import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MLAuth } from '../src/ml/auth.js';
import { MLClient } from '../src/ml/client.js';

const lease = () => ({ owner:'owner', signal:new AbortController().signal, check:async()=>{} });
test('dos corridas usan token persistido y rotación posterior usa refresh más nuevo', async () => {
  let time = Date.parse('2026-09-11T00:00:00Z');
  const row = {};
  const used = [];
  const options = { lease:lease(), config:{refreshToken:'seed',clientId:'app',clientSecret:'secret'}, now:()=>time,
    repo:{auth:async()=>({...row}),saveAuth:async(_owner,data)=>Object.assign(row,data)},
    fetchFn:async(_url,options)=>{
      used.push(options.body.get('refresh_token'));
      return Response.json({access_token:`access-${used.length}`,refresh_token:`refresh-${used.length}`,expires_in:21600,user_id:123});
    } };
  assert.equal(await new MLAuth(options).token(),'access-1');
  assert.equal(await new MLAuth(options).token(),'access-1');
  assert.deepEqual(used,['seed']);
  time += 21600*1000;
  const auth = new MLAuth(options);
  assert.deepEqual(await Promise.all([auth.token(),auth.token(),auth.token()]),['access-2','access-2','access-2']);
  assert.deepEqual(used,['seed','refresh-1']);
  assert.equal(row.refresh_token,'refresh-2');
});
test('refresh ambiguo queda bloqueado entre corridas, no reutiliza token de un uso', async () => {
  const row = {};
  let calls = 0;
  const options = {lease:lease(),config:{refreshToken:'seed'},repo:{auth:async()=>row,saveAuth:async(_owner,data)=>Object.assign(row,data)},
    fetchFn:async()=>{calls++;throw new Error('timeout');}};
  await assert.rejects(new MLAuth(options).token(),/sin respuesta segura/);
  assert.equal(row.refresh_in_progress,true);
  await assert.rejects(new MLAuth(options).token(),/inconcluso/);
  assert.equal(calls,1);
});
test('wrapper reintenta red y 5xx tres veces con 1s,4s,16s', async () => {
  let calls = 0;
  const delays = [];
  const ml = new MLClient({lease:lease(),auth:{token:async()=>'token'},sleepFn:async n=>delays.push(n),
    fetchFn:async()=>{ calls++; if(calls===1) throw new TypeError('network'); return Response.json({message:'unavailable'},{status:503}); }});
  await assert.rejects(ml.request('/items/MLA1'), /503/);
  assert.equal(calls,4);
  assert.deepEqual(delays,[1000,4000,16000]);
});
test('wrapper no reintenta 400 y respeta Retry-After de 429', async () => {
  let calls = 0;
  const delays = [];
  const ml = new MLClient({lease:lease(),auth:{token:async()=>'token'},sleepFn:async n=>delays.push(n),
    fetchFn:async()=>{ calls++;return Response.json({message:'bad'},{status:400}); }});
  await assert.rejects(ml.request('/items/MLA1'), /400/);
  assert.equal(calls,1);
  ml.fetchFn = async()=>{calls++;return calls===2?Response.json({}, {status:429,headers:{'Retry-After':'7'}}):Response.json({ok:true});};
  assert.deepEqual(await ml.request('/items/MLA1'),{ok:true});
  assert.deepEqual(delays,[7000]);
});
test('401 renueva una vez y nunca entra en loop', async () => {
  const tokens = [];
  let calls = 0;
  const ml = new MLClient({lease:lease(),auth:{token:async rejected=>{tokens.push(rejected);return rejected?'new':'old';}},
    fetchFn:async()=>{calls++;return Response.json({}, {status:401});}});
  await assert.rejects(ml.request('/items/MLA1'),/401/);
  assert.equal(calls,2);
  assert.deepEqual(tokens,[undefined,'old']);
});
