import { randomBytes, createHash, timingSafeEqual } from 'node:crypto';
import { registerSecret } from '../log.js';

export function createAuthorization({ clientId, redirectUri, now = Date.now }) {
  const redirect = new URL(redirectUri);
  if (redirect.protocol !== 'https:' || redirect.search || redirect.hash) throw new Error('Redirect URI debe ser HTTPS, sin query ni fragmento');
  const verifier = randomBytes(32).toString('base64url');
  const state = randomBytes(32).toString('base64url');
  registerSecret(verifier);
  const expiresAt = now() + 20 * 60 * 1000;
  let used = false;
  const authorization = new URL('https://auth.mercadolibre.com.ar/authorization');
  authorization.search = new URLSearchParams({ response_type: 'code', client_id: clientId,
    redirect_uri: redirectUri, state, code_challenge_method: 'S256',
    code_challenge: createHash('sha256').update(verifier).digest('base64url') }).toString();
  return {
    url: authorization.toString(),
    consume(callback) {
      if (callback.pathname !== redirect.pathname) throw new Error('Ruta callback incorrecta');
      if (now() >= expiresAt) throw new Error('Autorización vencida; iniciar nuevamente');
      const received = Buffer.from(callback.searchParams.get('state') || '');
      const expected = Buffer.from(state);
      if (callback.searchParams.getAll('state').length !== 1 || received.length !== expected.length || !timingSafeEqual(received, expected))
        throw new Error('State inválido');
      if (used) throw new Error('Autorización ya utilizada');
      if (callback.searchParams.has('error')) { used = true; throw new Error('Autorización rechazada por Mercado Libre'); }
      const code = callback.searchParams.get('code');
      if (!code || callback.searchParams.getAll('code').length !== 1) throw new Error('Falta código OAuth');
      used = true;
      registerSecret(code);
      return { code, verifier, redirectUri };
    }
  };
}

export async function exchangeAuthorization({ grant, config, repo, lease, fetchFn = fetch }) {
  await lease.check();
  const previous = await repo.auth();
  if (previous.refresh_token || previous.access_token || previous.refresh_in_progress)
    throw new Error('ml_auth ya contiene una autorización; no se reemplaza mediante bootstrap');
  const response = await fetchFn('https://api.mercadolibre.com/oauth/token', {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'authorization_code', client_id: config.clientId,
      client_secret: config.clientSecret, code: grant.code, code_verifier: grant.verifier, redirect_uri: grant.redirectUri }),
    signal: AbortSignal.any([lease.signal, AbortSignal.timeout(30000)])
  });
  if (!response.ok) throw new Error(`OAuth HTTP ${response.status}; iniciar una autorización nueva`);
  const token = await response.json();
  registerSecret(token.access_token); registerSecret(token.refresh_token);
  if (!token.access_token || !token.refresh_token || !Number.isSafeInteger(token.user_id)
      || !Number.isFinite(token.expires_in) || token.expires_in <= 0) throw new Error('Respuesta OAuth incompleta');
  if (previous.seller_id && String(previous.seller_id) !== String(token.user_id)) throw new Error('El vendedor no coincide con ml_auth');
  const data = { access_token: token.access_token, refresh_token: token.refresh_token, seller_id: token.user_id,
    expires_at: new Date(Date.now() + token.expires_in * 1000).toISOString(), refresh_in_progress: false };
  // Se repite solo la persistencia de la misma respuesta; nunca el canje del code.
  for (let attempt = 0; attempt < 3; attempt++) {
    try { await repo.saveAuth(lease.owner, data); return { sellerId: token.user_id }; }
    catch { if (attempt === 2) throw new Error('No se pudo guardar OAuth en Supabase; iniciar autorización nueva'); }
  }
}
