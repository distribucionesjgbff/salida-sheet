import { test } from 'node:test';
import assert from 'node:assert/strict';
import { run } from '../src/run.js';
import { withLease } from '../src/db/lease.js';

function fixture() {
  const updates = [];
  let scan = 0;
  return { updates, task: 'full_import', config: { concurrency: 2, pushEnabled: false },
    lease: { owner: 'owner', signal: new AbortController().signal, check: async () => {} },
    repo: {
      startRun: async () => ({id:'run'}), updateRun: async (_id,row) => { updates.push(row); },
      auth: async () => ({seller_id:123}), apply: async () => true, markError: async () => {}
    },
    ml: { request: async path => {
      if (path === '/users/me') return {id:123,site_id:'MLA'};
      if (path.includes('/search?')) return scan++ ? {results:[]} : {results:['MLA1','MLA2'],scroll_id:'s'};
      if (path.includes('/MLA1?')) throw new Error('HTTP 503');
      return {id:'MLA2',seller_id:123,title:'Good',available_quantity:2,variations:[],last_updated:'2026-09-11T00:00:00Z'};
    } }
  };
}
test('corrida procesa resto tras fallo por ítem y persiste resultado final', async () => {
  const args = fixture();
  assert.equal(await run(args),'failed');
  const final = args.updates.at(-1);
  assert.equal(final.status,'failed');
  assert.equal(final.items_processed,2);
  assert.equal(final.items_failed,1);
  assert.ok(final.finished_at);
});
test('corrida marca fallo global y finaliza registro aunque falle enumeración', async () => {
  const args = fixture();
  args.ml.request = async () => { throw new Error('No autorizado'); };
  await assert.rejects(run(args),/No autorizado/);
  assert.equal(args.updates.at(-1).status,'failed');
  assert.match(args.updates.at(-1).notes,/No autorizado/);
});
test('lease rechazado no ejecuta trabajo; lease adquirido se libera ante fallo', async () => {
  let worked = false;
  await withLease({rpc:async()=>false},'sync',async()=>{worked=true;});
  assert.equal(worked,false);
  const calls = [];
  const repo = {rpc:async(_name,args)=>{calls.push(args.p_action);return true;}};
  await assert.rejects(withLease(repo,'sync',async lease=>{await lease.check();throw new Error('job failure');}),/job failure/);
  assert.deepEqual(calls,['acquire','renew','release']);
});
test('lease perdido aborta operaciones y nunca continúa trabajo', async () => {
  const repo = {rpc:async(_name,args)=>args.p_action==='acquire'};
  await withLease(repo,'sync',async lease=>{
    await assert.rejects(lease.check(),/Lease perdido/);
    assert.equal(lease.signal.aborted,true);
    await assert.rejects(lease.check(),/Lease perdido/);
  });
});
