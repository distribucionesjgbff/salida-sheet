import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { config } from '../src/config.js';
import { database } from '../src/db/supabase.js';
import { withLease } from '../src/db/lease.js';
import { createAuthorization, exchangeAuthorization } from '../src/ml/authorize.js';
import { log, safeError } from '../src/log.js';

const cfg = config('full_import');
const redirectUri = process.env.ML_REDIRECT_URI;
if (!redirectUri) throw new Error('Falta ML_REDIRECT_URI');
const session = createAuthorization({clientId:cfg.clientId,redirectUri});
const repo = database(cfg);
const port = 8787;
let tunnel;
let timer;
let busy = false;
const finish = () => {
  clearTimeout(timer);
  server.close();
  server.closeIdleConnections();
  tunnel?.kill();
};
const reply = (res, status, text) => {
  res.writeHead(status, {'Content-Type':'text/plain; charset=utf-8','Cache-Control':'no-store','Referrer-Policy':'no-referrer'});
  res.end(text);
};
const server = createServer(async (req,res) => {
  const url = new URL(req.url, 'http://127.0.0.1');
  if (req.method !== 'GET') return reply(res,405,'Método no permitido');
  if (url.pathname === '/health') return reply(res,200,'Receptor OAuth de salida-sheet activo');
  if (url.pathname !== new URL(redirectUri).pathname) return reply(res,404,'No encontrado');
  if (!url.search) return reply(res,200,'Receptor listo. Abrí el enlace de autorización proporcionado por Codex.');
  if (busy) return reply(res,409,'Autorización en curso');
  let grant;
  try { grant = session.consume(url); }
  catch(error) { return reply(res,400,safeError(error)); }
  busy = true;
  try {
    const result = await withLease(repo,'sync',lease => exchangeAuthorization({grant,config:cfg,repo,lease}));
    if (!result) throw new Error('Hay otra sincronización activa; iniciar autorización nuevamente');
    log('oauth.bootstrap.saved',{seller_id:result.sellerId});
    reply(res,200,'Mercado Libre conectado. La autorización quedó guardada en Supabase. Volvé a Codex y avisá que está listo.');
  } catch(error) {
    log('oauth.bootstrap.failed',{error:safeError(error)},'error');
    reply(res,500,'No se pudo completar la autorización. Volvé a Codex para revisar el error.');
    process.exitCode=1;
  } finally { setTimeout(finish,1500); }
});
server.on('error',error => { log('oauth.server.failed',{error:safeError(error)},'error'); process.exitCode=1; finish(); });
await mkdir('.local',{recursive:true});
await writeFile('.local/ml-authorization-url.txt',session.url,{mode:0o600});
server.listen(port,'127.0.0.1',() => {
  log('oauth.server.ready',{port,redirect_uri:redirectUri,expires_in_minutes:20});
  if (process.argv.includes('--ngrok')) {
    if (!new URL(redirectUri).hostname.endsWith('.ngrok-free.dev')) throw new Error('Usar --ngrok solo con el dominio de desarrollo configurado');
    tunnel=spawn('ngrok',['http',`http://127.0.0.1:${port}`,`--url=${new URL(redirectUri).origin}`,'--inspect=false','--log=stdout','--log-format=json'],
      {windowsHide:true,stdio:['ignore','pipe','pipe']});
    // No registrar solicitudes/códigos OAuth del túnel.
    tunnel.stdout.resume();tunnel.stderr.resume();
    tunnel.on('error',error => {log('oauth.tunnel.failed',{error:safeError(error)},'error');process.exitCode=1;finish();});
    tunnel.on('exit',code => {if(code){log('oauth.tunnel.exited',{code},'error');process.exitCode=1;finish();}});
  }
});
timer=setTimeout(()=>{log('oauth.server.expired');finish();},20*60*1000);
for (const signal of ['SIGINT','SIGTERM']) process.on(signal,finish);
