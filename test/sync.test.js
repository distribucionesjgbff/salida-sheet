import { test } from 'node:test';
import assert from 'node:assert/strict';
import { catalogIds, eachLimit } from '../src/sync/common.js';
import { incrementalSync } from '../src/sync/incrementalSync.js';
import { pushPayload, pushUpdates } from '../src/sync/pushUpdates.js';
import { fullImport } from '../src/sync/fullImport.js';
import { mirrorRequests, mirrorSync, MIRROR_NOTE } from '../src/sheet/mirrorSync.js';
import { Repository } from '../src/db/supabase.js';

const detail = (id, quantity = 5, variations = []) => ({ id, seller_id: 123, title: '=IMPORTXML("evil")',
  available_quantity: quantity, variations, last_updated: '2026-09-11T10:00:00Z' });
function context(rows = []) {
  const applied = [];
  const errors = [];
  return { sellerId: 123, processed: new Set(), failed: new Set(), config: { concurrency: 20, putDelay: 0, pushEnabled: true },
    lease: { owner: 'owner', signal: new AbortController().signal, check: async () => {} }, checkpoint: async () => {}, applied, errors,
    repo: { allItems: async () => rows, apply: async (...args) => { applied.push(args); return true; },
      markError: async (...args) => { errors.push(args); } } };
}
test('scan enumera más de 2600 IDs antes del detalle', async () => {
  let offset = 0;
  const ids = await catalogIds({ request: async path => {
    assert.match(path, /search_type=scan/);
    if (offset) assert.match(path, /scroll_id=stable/);
    const results = Array.from({ length: Math.min(100, 2603 - offset) }, (_, i) => `MLA${offset + i}`);
    offset += results.length;
    return { results, scroll_id: 'stable' };
  } }, 123);
  assert.equal(ids.length, 2603);
});
test('scan no silencia cursor faltante ni páginas repetidas', async () => {
  await assert.rejects(catalogIds({ request: async () => ({ results: ['MLA1'] }) }, 1), /incompleto/);
  await assert.rejects(catalogIds({ request: async () => ({ results: ['MLA1'], scroll_id: 'a' }) }, 1), /incompleto/);
});
test('cache-first omite detalle sin cambios, refresca nuevos y errores y omite pendientes', async () => {
  const ctx = context([
    { id: 'MLA1', sync_status: 'ok', last_ml_update_at: '2026-09-11T10:00:00+00:00' },
    { id: 'MLA2', sync_status: 'ok', push_pending: true },
    { id: 'MLA3', sync_status: 'error', last_ml_update_at: '2026-09-11T10:00:00Z' }
  ]);
  const details = [];
  ctx.ml = { request: async path => {
    if (path.startsWith('/items?')) return ['MLA1','MLA3','MLA4'].map(id => ({ code: 200, body: { id, last_updated: detail(id).last_updated } }));
    const id = path.split('/')[2].split('?')[0];
    details.push(id);
    return detail(id);
  } };
  await incrementalSync(ctx, ['MLA1','MLA2','MLA3','MLA4']);
  assert.deepEqual(details.sort(), ['MLA3','MLA4']);
  assert.equal(ctx.skipped, 1);
});
test('error individual de multiget cae a GET; fallo de uno no detiene el resto', async () => {
  const ctx = context();
  ctx.ml = { request: async path => {
    if (path.startsWith('/items?')) return [{ code: 503, body: { id: 'MLA1' } }];
    if (path.includes('/MLA1?')) throw new Error('HTTP 503 agotado');
    return detail('MLA2');
  } };
  await incrementalSync(ctx, ['MLA1','MLA2']);
  assert.equal(ctx.failed.has('MLA1'), true);
  assert.equal(ctx.applied[0][1].id, 'MLA2');
});
test('PUT contiene todos los IDs y exige cantidades por variación sin mutar snapshot', () => {
  const variations = [{ id: 1, available_quantity: 2, picture_ids: ['pic'] }, { id: 2, available_quantity: 3 }];
  const row = { has_variations: true, available_quantity: 9, variations_raw: variations, stock_by_variation: { 1: 4, 2: 5 } };
  assert.deepEqual(pushPayload(row, detail('MLA1', 5, variations)), { variations: [{ id: 1, available_quantity: 4 }, { id: 2, available_quantity: 5 }] });
  assert.equal(variations[0].available_quantity, 2);
  assert.throws(() => pushPayload({ ...row, available_quantity: 10 }, detail('MLA1', 5, variations)), /total/);
  assert.throws(() => pushPayload({ ...row, stock_by_variation: {1: 9} }, detail('MLA1', 5, variations)), /TODAS/);
  assert.throws(() => pushPayload(row, detail('MLA1', 5, [...variations, {id: 3, available_quantity: 0}])), /conjunto/);
});
test('push fallido no corta siguientes; confirmación usa revisión leída', async () => {
  const ctx = context([
    { id: 'MLA1', available_quantity: 6, has_variations: false, stock_revision: 1 },
    { id: 'MLA2', available_quantity: 8, has_variations: false, stock_revision: 4 }
  ]);
  const calls = [];
  let pushed = false;
  ctx.ml = { request: async (path, options) => {
    calls.push({ path, options });
    if (path.includes('MLA1')) throw new Error('HTTP 500');
    if (options?.method === 'PUT') { pushed = true; return {}; }
    return detail('MLA2', pushed ? 8 : 5);
  } };
  await pushUpdates(ctx);
  assert.equal(ctx.failed.has('MLA1'), true);
  assert.equal(ctx.applied[0][2], 4);
  assert.equal(calls.filter(c => c.options?.method === 'PUT').length, 1);
});
test('push ya aplicado se reconcilia sin repetir PUT; modo comparación no envía', async () => {
  const ctx = context([{id:'MLA1',available_quantity:5,has_variations:false,stock_revision:1}]);
  ctx.ml = { request: async (path, options) => { assert.equal(options, undefined); return detail('MLA1'); } };
  await pushUpdates(ctx);
  assert.equal(ctx.applied.length, 1);
  ctx.config.pushEnabled = false;
  ctx.ml.request = async () => { throw new Error('No debe consultar ML'); };
  await pushUpdates(ctx);
});
test('full import conserva snapshot completo y continúa tras error de un ítem', async () => {
  const ctx = context();
  let enumerated = false;
  ctx.ml = { request: async path => {
    if (path.includes('/search?')) {
      if (enumerated) return { results: [] };
      enumerated = true;
      return { results: ['MLA1','MLA2'], scroll_id: 's' };
    }
    if (path.includes('MLA1')) throw new Error('Item unavailable');
    return detail('MLA2', 3, [{ id: 11, available_quantity: 3, attribute_combinations: [{id:'COLOR',value_name:'Rojo'}] }]);
  } };
  await fullImport(ctx);
  assert.equal(ctx.failed.size, 1);
  assert.equal(ctx.applied[0][1].variations[0].attribute_combinations[0].value_name, 'Rojo');
});
test('pool espera tareas en vuelo antes de propagar fallo global', async () => {
  let finished = false;
  await assert.rejects(eachLimit([1,2,3], 2, async n => {
    if (n === 1) { await new Promise(resolve => setTimeout(resolve, 5)); throw new Error('fatal'); }
    await new Promise(resolve => setTimeout(resolve, 20)); finished = true;
  }), /fatal/);
  assert.equal(finished, true);
});
test('espejo realiza un batch, títulos literales y rango que limpia sobrantes', async () => {
  const ctx = context([{ ...detail('MLA1'), sync_status: 'ok', updated_at: 'today' }]);
  ctx.config.tabId = 0; ctx.config.sheetId = 'sheet';
  let calls = 0;
  await mirrorSync(ctx, { spreadsheets: { batchUpdate: async args => {
    calls++;
    const update = args.requestBody.requests[1].updateCells;
    assert.equal(update.rows[0].values[0].note, MIRROR_NOTE);
    assert.equal(update.rows[2].values[1].userEnteredValue.stringValue, detail('MLA1').title);
    assert.equal(update.range.endRowIndex, 1000);
    assert.equal(update.rows.length, 3);
  } } });
  assert.equal(calls, 1);
  assert.equal(mirrorRequests([],0)[1].updateCells.rows.length, 2);
});
test('Supabase pagina todo el catálogo, no queda limitado a 1000 filas', async () => {
  const rows = Array.from({length:2603}, (_, i) => ({ id: `MLA${String(i).padStart(5,'0')}` }));
  const repo = new Repository({ from: () => {
    let after = ''; let size;
    const q = { select: () => q, order: () => q, gt: (_key,value) => { after=value; return q; },
      limit: n => { size=n; return q; }, then: fn => Promise.resolve({data:rows.filter(r=>r.id>after).slice(0,size)}).then(fn) };
    return q;
  } });
  assert.equal((await repo.allItems()).length, 2603);
});
