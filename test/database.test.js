import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';

let db;
const owner = '11111111-1111-4111-8111-111111111111';
const other = '22222222-2222-4222-8222-222222222222';
const item = (id, quantity = 5) => ({ id, title: 'Producto', available_quantity: quantity,
  variations: [], last_updated: '2026-09-11T10:00:00Z' });
before(async () => {
  db = new PGlite();
  await db.exec('create role anon; create role authenticated; create role service_role bypassrls;');
  await db.exec(await readFile(new URL('../migrations/001_init.sql', import.meta.url), 'utf8'));
  await db.query("select public.job_lock('sync', $1, 'acquire')", [owner]);
});
after(async () => { await db?.close(); });
const apply = (snapshot, revision = null, lock = owner) => db.query('select public.apply_ml_snapshot($1,$2,$3) as applied', [lock, JSON.stringify(snapshot), revision]);
const get = async id => (await db.query('select * from public.items where id=$1', [id])).rows[0];

test('migración habilita RLS en tres tablas sin políticas y restringe RPC', async () => {
  const tables = await db.query("select relname,relrowsecurity from pg_class where relnamespace='public'::regnamespace and relkind='r'");
  assert.equal(tables.rows.length, 3);
  assert.ok(tables.rows.every(row => row.relrowsecurity));
  assert.equal((await db.query("select * from pg_policies where schemaname='public'")).rows.length, 0);
  assert.equal((await db.query("select has_function_privilege('anon','public.job_lock(text,uuid,text)','execute') as allowed")).rows[0].allowed, false);
  await db.exec('set role anon');
  try { await assert.rejects(db.query('select * from public.ml_auth'), /permission denied/); }
  finally { await db.exec('reset role'); }
});

test('una edición marca pending, un pull no la pisa y CAS conserva una edición posterior', async () => {
  await apply(item('MLA1'));
  await db.query('update public.items set available_quantity=9 where id=$1', ['MLA1']);
  let row = await get('MLA1');
  assert.equal(row.push_pending, true);
  assert.equal(row.sync_status, 'pending');
  assert.equal(Number(row.stock_revision), 1);
  assert.equal((await apply(item('MLA1', 3))).rows[0].applied, false);
  assert.equal((await get('MLA1')).available_quantity, 9);
  await db.query("update public.items set available_quantity=12 where id='MLA1'");
  assert.equal((await apply(item('MLA1', 9), 1)).rows[0].applied, false);
  row = await get('MLA1');
  assert.equal(row.available_quantity, 12);
  assert.equal(row.push_pending, true);
  assert.equal((await apply(item('MLA1', 12), 2)).rows[0].applied, true);
  row = await get('MLA1');
  assert.equal(row.push_pending, false);
  assert.equal(Number(row.stock_revision), 2);
});

test('variations_raw se conserva íntegro y cantidades explícitas actualizan el total', async () => {
  const snapshot = { ...item('MLA2', 7), variations: [
    { id: 10, available_quantity: 3, picture_ids: ['abc'], attribute_combinations: [{ id: 'COLOR', value_name: 'Azul' }] },
    { id: 20, available_quantity: 4, seller_custom_field: 'SKU-2' }
  ] };
  await apply(snapshot);
  assert.deepEqual((await get('MLA2')).variations_raw, snapshot.variations);
  await db.query("update public.items set stock_by_variation='{" + '"10":6,"20":2' + "}' where id='MLA2'");
  const row = await get('MLA2');
  assert.equal(row.available_quantity, 8);
  assert.equal(row.push_pending, true);
  assert.deepEqual(row.variations_raw, snapshot.variations);
  await assert.rejects(db.query("update public.items set variations_raw='[]' where id='MLA2'"), /snapshot/);
  await assert.rejects(db.query("update public.items set stock_by_variation=$1 where id='MLA2'", [{10: -1, 20: 2}]), /no negativo/);
});

test('error por ítem conserva intención local; error antiguo no pisa nueva revisión', async () => {
  await db.query('select public.mark_item_error($1,$2,$3,$4)', [owner, 'MLA1', 'HTTP 503', 2]);
  assert.equal((await get('MLA1')).sync_status, 'error');
  await db.query("update public.items set available_quantity=15 where id='MLA1'");
  await db.query('select public.mark_item_error($1,$2,$3,$4)', [owner, 'MLA1', 'error viejo', 2]);
  assert.equal((await get('MLA1')).sync_status, 'pending');
  await db.query('select public.mark_item_error($1,$2,$3)', [owner, 'MLA404', 'No existe']);
  assert.equal((await get('MLA404')).sync_status, 'error');
});

test('locks excluyen segundo sync, permiten espejo y rechazan escrituras sin dueño', async () => {
  assert.equal((await db.query("select public.job_lock('sync',$1,'acquire') as ok", [other])).rows[0].ok, false);
  assert.equal((await db.query("select public.job_lock('mirror',$1,'acquire') as ok", [other])).rows[0].ok, true);
  await assert.rejects(apply(item('MLA3'), null, other), /lease lost/);
  await assert.rejects(db.query('select public.save_ml_auth($1,$2)', [other, { refresh_token: 'invalid' }]), /lease lost/);
  await db.query('select public.save_ml_auth($1,$2)', [owner, { refresh_token: 'rotated', refresh_in_progress: false }]);
  assert.equal((await db.query('select refresh_token from public.ml_auth')).rows[0].refresh_token, 'rotated');
});

test('un lease vencido se puede reemplazar, el dueño anterior no puede confirmar', async () => {
  await db.query("update public.ml_auth set locks=jsonb_set(locks,'{sync,until}',to_jsonb('2000-01-01T00:00:00Z'::text))");
  assert.equal((await db.query("select public.job_lock('sync',$1,'renew') as ok", [owner])).rows[0].ok, false);
  assert.equal((await db.query("select public.job_lock('sync',$1,'acquire') as ok", [other])).rows[0].ok, true);
  await assert.rejects(apply(item('MLA8')), /lease lost/);
  assert.equal((await apply(item('MLA8'), null, other)).rows[0].applied, true);
});
