import { DatabaseError } from '../db/supabase.js';
import { LeaseLostError } from '../db/lease.js';
import { AuthError } from '../ml/auth.js';
import { log, safeError } from '../log.js';

export const isFatal = error => error instanceof DatabaseError || error instanceof LeaseLostError || error instanceof AuthError;
export async function eachLimit(values, concurrency, worker) {
  // Esperar TODAS las tareas en vuelo antes de soltar el lease, incluso ante fallo global.
  let next = 0;
  let failure;
  await Promise.all(Array.from({ length: Math.min(concurrency, values.length) }, async () => {
    while (!failure && next < values.length) {
      const value = values[next++];
      try { await worker(value); } catch (error) { failure ??= error; }
    }
  }));
  if (failure) throw failure;
}
export function validateItem(item, id) {
  if (!item || item.id !== id || typeof item.title !== 'string' || !Array.isArray(item.variations)
      || !Number.isInteger(item.available_quantity) || item.available_quantity < 0
      || !Number.isFinite(Date.parse(item.last_updated))) throw new Error(`Detalle ML inválido: ${id}`);
  const seen = new Set();
  for (const variation of item.variations) {
    if (variation.id === undefined || seen.has(String(variation.id)) || !Number.isInteger(variation.available_quantity) || variation.available_quantity < 0)
      throw new Error(`Variación ML inválida: ${id}`);
    seen.add(String(variation.id));
  }
  return item;
}
export async function itemFailure(ctx, id, error, revision = null) {
  if (isFatal(error)) throw error;
  ctx.failed.add(id);
  await ctx.repo.markError(ctx.lease.owner, id, safeError(error), revision);
  log('item.error', { item: id, error: safeError(error) }, 'error');
}
export async function pullItem(ctx, id) {
  ctx.processed.add(id);
  try {
    const item = validateItem(await ctx.ml.request(`/items/${encodeURIComponent(id)}?include_attributes=all`), id);
    if (String(item.seller_id) !== String(ctx.sellerId)) throw new Error('El ítem pertenece a otro vendedor');
    const applied = await ctx.repo.apply(ctx.lease.owner, item);
    log('item.pull', { item: id, result: applied ? 'ok' : 'local_pending' });
  } catch (error) { await itemFailure(ctx, id, error); }
}
export async function catalogIds(ml, sellerId) {
  const ids = new Set();
  let scroll;
  // Agotar scan ANTES de consultar detalles: el scroll de ML expira en 5 minutos.
  while (true) {
    const params = new URLSearchParams({ search_type: 'scan', limit: '100' });
    if (scroll) params.set('scroll_id', scroll);
    const page = await ml.request(`/users/${sellerId}/items/search?${params}`);
    if (!Array.isArray(page?.results)) throw new Error('Respuesta inválida al enumerar catálogo');
    if (!page.results.length) break;
    let added = 0;
    for (const id of page.results) {
      if (typeof id !== 'string' || !/^MLA\d+$/.test(id)) throw new Error('Catálogo contiene un ID inválido o no MLA');
      if (!ids.has(id)) { ids.add(id); added++; }
    }
    if (!page.scroll_id || !added) throw new Error('Scan incompleto: falta cursor o página repetida');
    // Algunos cursores son estables durante todo el scan: detectar repetición de resultados, no de token.
    scroll = page.scroll_id;
  }
  return [...ids];
}
