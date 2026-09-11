import { catalogIds, eachLimit, pullItem, isFatal } from './common.js';
import { log } from '../log.js';

export async function incrementalSync(ctx, selected) {
  const local = new Map((await ctx.repo.allItems()).map(item => [item.id, item]));
  const ids = selected ?? [...new Set([...await catalogIds(ctx.ml, ctx.sellerId), ...local.keys()])];
  const candidates = ids.filter(id => !local.get(id)?.push_pending && !ctx.failed.has(id));
  let skipped = 0;
  // ML search devuelve IDs, no timestamps. Multiget liviano permite comparar
  // last_updated sin descargar title/attributes/variations de todo el catálogo.
  for (let start = 0; start < candidates.length; start += 20) {
    const batch = candidates.slice(start, start + 20);
    let response;
    try {
      response = await ctx.ml.request(`/items?ids=${batch.join(',')}&attributes=id,last_updated`);
      if (!Array.isArray(response)) throw new Error('Multiget inválido');
    } catch (error) {
      if (isFatal(error)) throw error;
      // Si el batch falla, el GET individual aísla el ítem y aplica los reintentos.
      await eachLimit(batch, ctx.config.concurrency, id => pullItem(ctx, id));
      await ctx.checkpoint();
      continue;
    }
    const metadata = new Map(response.filter(entry => entry?.body?.id).map(entry => [entry.body.id, entry]));
    await eachLimit(batch, ctx.config.concurrency, async id => {
      const entry = metadata.get(id);
      const cached = local.get(id);
      if (entry?.code === 200 && cached?.sync_status === 'ok' && cached.last_ml_update_at
          && Number.isFinite(Date.parse(entry.body.last_updated))
          && Date.parse(entry.body.last_updated) === Date.parse(cached.last_ml_update_at)) {
        skipped++;
        return;
      }
      // Errores por entrada (incluidos 5xx/429) se resuelven con GET individual.
      await pullItem(ctx, id);
    });
    await ctx.checkpoint();
  }
  log('incremental.checked', { total: ids.length, unchanged: skipped, pending: ids.length - candidates.length });
  ctx.skipped = skipped;
}
