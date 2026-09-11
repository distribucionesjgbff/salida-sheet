import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {createAuthorization,exchangeAuthorization} from '../src/ml/authorize.js';
const redirectUri='https://example.com/mercadolibre/callback';
test('PKCE S256, state, vencimiento y consumo único',()=>{
 let now=1000;
 const auth=createAuthorization({clientId:'123',redirectUri,now:()=>now});
 const start=new URL(auth.url);
 assert.equal(start.searchParams.get('code_challenge_method'),'S256');
 assert.throws(()=>auth.consume(new URL(redirectUri+'?code=one&state=wrong')),/State/);
 const callback=new URL(redirectUri);callback.searchParams.set('state',start.searchParams.get('state'));callback.searchParams.set('code','one');
 const grant=auth.consume(callback);
 assert.equal(createHash('sha256').update(grant.verifier).digest('base64url'),start.searchParams.get('code_challenge'));
 assert.throws(()=>auth.consume(callback),/utilizada/);
 now+=21*60*1000;
 assert.throws(()=>auth.consume(callback),/vencida/);
});
test('canje persiste token; fallo de DB no repite POST y no reemplaza autorización previa',async()=>{
 let requests=0,writes=0;
 const args={grant:{code:'code',verifier:'verifier',redirectUri},config:{clientId:'123',clientSecret:'secret'},
  lease:{owner:'owner',signal:new AbortController().signal,check:async()=>{}},
  repo:{auth:async()=>({}),saveAuth:async(_owner,data)=>{writes++;assert.equal(data.refresh_token,'refresh');if(writes<3)throw new Error('transient');}},
  fetchFn:async(_url,options)=>{requests++;assert.equal(options.body.get('code_verifier'),'verifier');return Response.json({access_token:'access',refresh_token:'refresh',expires_in:21600,user_id:123});}};
 assert.deepEqual(await exchangeAuthorization(args),{sellerId:123});assert.equal(requests,1);assert.equal(writes,3);
 args.repo.auth=async()=>({refresh_token:'existing'});
 await assert.rejects(exchangeAuthorization(args),/no se reemplaza/);assert.equal(requests,1);
});
