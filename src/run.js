import { fullImport } from './sync/fullImport.js';
import { incrementalSync } from './sync/incrementalSync.js';
import { pushUpdates } from './sync/pushUpdates.js';
import { mirrorSync } from './sheet/mirrorSync.js';
import { log, safeError } from './log.js';

export async function run({ task, repo, lease, config, ml, selected }) {
  const kind = task === 'mirror' ? 'mirror' : 'sync';
  const mode = ['full_import', 'refresh_selected'].includes(task) ? task : 'incremental';
  const { id: runId } = await repo.startRun(kind, mode);
  const processed = new Set();
  const failed = new Set();
  const ctx = { repo, lease, config, ml, processed, failed,
    checkpoint: () => repo.updateRun(runId, { items_processed: processed.size, items_failed: failed.size }) };
  log('run.started', { run_id: runId, task });
  try {
    if (task === 'mirror') await mirrorSync(ctx);
    else {
      const me = await ml.request('/users/me');
      if (me.site_id !== 'MLA' || !Number.isSafeInteger(me.id)) throw new Error('La cuenta OAuth debe ser del sitio MLA');
      ctx.sellerId = me.id;
      const storedAuth = await repo.auth();
      if (storedAuth.seller_id && String(storedAuth.seller_id) !== String(me.id)) throw new Error('La cuenta OAuth cambió de vendedor');
      if (task === 'full_import') await fullImport(ctx);
      else if (task === 'refresh_selected') await incrementalSync(ctx, selected);
      else {
        // Enviar intención local primero; pull jamás pisa pendientes, incluso errores.
        await pushUpdates(ctx);
        await incrementalSync(ctx);
      }
    }
    await lease.check();
    const status = failed.size ? 'failed' : 'completed';
    await repo.updateRun(runId, { status, finished_at: new Date().toISOString(),
      items_processed: processed.size, items_failed: failed.size,
      notes: `task=${task}; unchanged=${ctx.skipped ?? 0}; push_enabled=${config.pushEnabled}; ${failed.size ? 'Finalizó con errores por ítem; ver items.last_error.' : 'OK'}` });
    log('run.finished', { run_id: runId, task, status, items_processed: processed.size, items_failed: failed.size });
    return status;
  } catch (error) {
    await repo.updateRun(runId, { status: 'failed', finished_at: new Date().toISOString(),
      items_processed: processed.size, items_failed: failed.size, notes: safeError(error) })
      .catch(dbError => log('run.persist_failed', { run_id: runId, error: safeError(dbError) }, 'error'));
    log('run.failed', { run_id: runId, task, error: safeError(error) }, 'error');
    throw error;
  }
}
