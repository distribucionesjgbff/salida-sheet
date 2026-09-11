import { registerSecret, log } from '../log.js';

export class AuthError extends Error {}
export class MLAuth {
  constructor({ repo, lease, config, fetchFn = fetch, now = Date.now }) {
    Object.assign(this, { repo, lease, config, fetchFn, now });
  }
  async token(rejectedToken) {
    if (this.pending) return this.pending;
    this.pending = this.getToken(rejectedToken);
    try { return await this.pending; } finally { this.pending = undefined; }
  }
  async getToken(rejectedToken) {
    await this.lease.check();
    const row = await this.repo.auth();
    registerSecret(row.access_token);
    registerSecret(row.refresh_token);
    if (row.refresh_in_progress) throw new AuthError('Refresh anterior inconcluso. Reautorizar OAuth y recuperar ml_auth según README.');
    if (row.access_token && row.access_token !== rejectedToken && Date.parse(row.expires_at) > this.now() + 120000) return row.access_token;
    const refresh = row.refresh_token || this.config.refreshToken;
    if (!refresh) throw new AuthError('Falta ML_REFRESH_TOKEN de bootstrap');
    // Persistir ANTES del POST: si el proceso muere no se reutiliza a ciegas un token rotado.
    await this.repo.saveAuth(this.lease.owner, { refresh_in_progress: true, refresh_token: refresh });
    let response;
    try {
      response = await this.fetchFn('https://api.mercadolibre.com/oauth/token', {
        method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ grant_type: 'refresh_token', client_id: this.config.clientId,
          client_secret: this.config.clientSecret, refresh_token: refresh }),
        signal: AbortSignal.any([this.lease.signal, AbortSignal.timeout(30000)])
      });
    } catch { throw new AuthError('OAuth sin respuesta segura; refresh marcado inconcluso. No se reintenta un token de un solo uso.'); }
    if (!response.ok) throw new AuthError(`OAuth HTTP ${response.status}; revisar autorización y recuperar ml_auth.`);
    let data;
    try { data = await response.json(); } catch { throw new AuthError('OAuth devolvió JSON inválido; recuperar ml_auth.'); }
    registerSecret(data.access_token);
    registerSecret(data.refresh_token);
    if (!data.access_token || !data.refresh_token || !Number.isFinite(data.expires_in) || data.expires_in <= 0 || !data.user_id)
      throw new AuthError('OAuth devolvió un token incompleto; recuperar ml_auth.');
    if (row.seller_id && String(row.seller_id) !== String(data.user_id))
      throw new AuthError('OAuth devolvió otro vendedor. No mezclar catálogos; recuperar autorización de la cuenta original.');
    // Es seguro repetir la persistencia de la MISMA respuesta, nunca el POST OAuth.
    let lastError;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        await this.repo.saveAuth(this.lease.owner, {
          access_token: data.access_token, refresh_token: data.refresh_token,
          expires_at: new Date(this.now() + data.expires_in * 1000).toISOString(),
          seller_id: data.user_id, refresh_in_progress: false
        });
        log('oauth.refreshed', { seller_id: data.user_id });
        return data.access_token;
      } catch (error) { lastError = error; }
    }
    throw new AuthError(`No se pudo persistir el token rotado (${lastError?.name}); recuperar autorización.`);
  }
}
