import { randomUUID } from 'node:crypto';
import { log, safeError } from '../log.js';

export class LeaseLostError extends Error {}
export async function withLease(repo, task, work) {
  const owner = randomUUID();
  const call = action => repo.rpc('job_lock', { p_task: task, p_owner: owner, p_action: action });
  if (!await call('acquire')) {
    log('run.skipped', { task, reason: 'Hay otra corrida activa' });
    return;
  }
  const controller = new AbortController();
  let failure;
  let renewal;
  const lease = {
    owner, signal: controller.signal,
    async check() {
      if (failure) throw failure;
      if (!renewal) renewal = (async () => {
        try {
          if (!await call('renew')) throw new LeaseLostError('Lease perdido');
        } catch (error) {
          failure = new LeaseLostError(`No se pudo renovar el lease: ${safeError(error)}`);
          controller.abort(failure);
          throw failure;
        } finally { renewal = undefined; }
      })();
      await renewal;
    }
  };
  const timer = setInterval(() => lease.check().catch(() => {}), 30000);
  timer.unref();
  try { return await work(lease); }
  finally {
    clearInterval(timer);
    if (renewal) await renewal.catch(() => {});
    await call('release').catch(error => log('lease.release.error', { task, error: safeError(error) }, 'error'));
  }
}
