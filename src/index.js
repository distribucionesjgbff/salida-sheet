import { config } from './config.js';
import { database } from './db/supabase.js';
import { withLease } from './db/lease.js';
import { MLAuth } from './ml/auth.js';
import { MLClient } from './ml/client.js';
import { run } from './run.js';
import { log, safeError } from './log.js';

async function main() {
  const task = process.argv[2] || process.env.TASK || 'incremental';
  if (!['full_import','incremental','refresh_selected','mirror'].includes(task))
    throw new Error('Tarea inválida: full_import | incremental | refresh_selected MLA123 ... | mirror');
  const selected = process.argv.slice(3);
  if (task === 'refresh_selected' && (!selected.length || selected.some(id => !/^MLA\d+$/.test(id))))
    throw new Error('refresh_selected requiere IDs MLA válidos');
  const cfg = config(task);
  const repo = database(cfg);
  const result = await withLease(repo, task === 'mirror' ? 'mirror' : 'sync', async lease => {
    const ml = task === 'mirror' ? undefined : new MLClient({ auth: new MLAuth({ repo, lease, config: cfg }), lease });
    return run({ task, repo, lease, config: cfg, ml, selected });
  });
  if (result === 'failed') process.exitCode = 1;
}
main().catch(error => { log('fatal', { error: safeError(error) }, 'error'); process.exitCode = 1; });
