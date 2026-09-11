import { catalogIds, eachLimit, pullItem } from './common.js';
import { log } from '../log.js';

export async function fullImport(ctx) {
  const ids = await catalogIds(ctx.ml, ctx.sellerId);
  log('catalog.enumerated', { count: ids.length, mode: 'full_import' });
  for (let start = 0; start < ids.length; start += ctx.config.concurrency) {
    await eachLimit(ids.slice(start, start + ctx.config.concurrency), ctx.config.concurrency, id => pullItem(ctx, id));
    await ctx.checkpoint();
  }
}
