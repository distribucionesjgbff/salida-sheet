import { setTimeout as sleep } from 'node:timers/promises';
import { log } from '../log.js';

export class MLError extends Error {
  constructor(message, status) { super(message); this.status = status; }
}
export class MLClient {
  constructor({ auth, lease, fetchFn = fetch, sleepFn = sleep }) {
    Object.assign(this, { auth, lease, fetchFn, sleepFn });
  }
  async request(path, { method = 'GET', body } = {}) {
    if (!path.startsWith('/') || path.startsWith('//')) throw new Error('Ruta ML inválida');
    let token = await this.auth.token();
    let authRetried = false;
    let retry = 0;
    while (true) {
      await this.lease.check();
      let response;
      let data;
      let error;
      try {
        response = await this.fetchFn(`https://api.mercadolibre.com${path}`, {
          method, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
          signal: AbortSignal.any([this.lease.signal, AbortSignal.timeout(30000)])
        });
        const raw = await response.text();
        try { data = raw ? JSON.parse(raw) : null; }
        catch { if (response.ok) throw new Error('Respuesta JSON inválida'); }
      } catch (cause) {
        this.lease.signal.throwIfAborted();
        error = new MLError(`ML ${method} ${path.split('?')[0]}: ${cause.name || 'network error'}`);
      }
      if (response?.status === 401 && !authRetried) {
        token = await this.auth.token(token);
        authRetried = true;
        continue;
      }
      if (!error && response?.ok) return data;
      error ??= new MLError(`ML ${method} ${path.split('?')[0]} HTTP ${response.status}: ${String(data?.message ?? data?.error ?? 'sin detalle').slice(0, 500)}`, response.status);
      const retryable = !response || response.status >= 500 || response.status === 429 || (response.ok && error);
      if (!retryable || retry === 3) throw error;
      const retryAfter = response?.headers.get('retry-after');
      const seconds = retryAfter === null || retryAfter === undefined ? 0 : Number(retryAfter);
      const headerMs = Number.isFinite(seconds) ? seconds * 1000 : Math.max(0, Date.parse(retryAfter) - Date.now());
      const delay = Math.max([1000, 4000, 16000][retry], Math.min(headerMs || 0, 60000));
      log('ml.retry', { method, path: path.split('?')[0], attempt: ++retry, delay_ms: delay, status: response?.status });
      await this.sleepFn(delay, undefined, { signal: this.lease.signal });
    }
  }
}
