import { setTimeout as sleep } from 'node:timers/promises';
import { validateItem, itemFailure } from './common.js';
import { log } from '../log.js';

export function pushPayload(row, fresh) {
  if (!Number.isInteger(row.available_quantity) || row.available_quantity < 0) throw new Error('Stock inválido');
  if (row.has_variations !== (fresh.variations.length > 0)) throw new Error('Cambió la estructura de variaciones en ML; reconciliar antes de enviar');
  if (!row.has_variations) return { available_quantity: row.available_quantity };
  const desired = row.stock_by_variation;
  const cachedIds = row.variations_raw.map(v => String(v.id)).sort();
  const freshIds = fresh.variations.map(v => String(v.id)).sort();
  if (JSON.stringify(cachedIds) !== JSON.stringify(freshIds)) throw new Error('Cambió el conjunto de variaciones en ML; reconciliar el snapshot');
  if (!desired || JSON.stringify(Object.keys(desired).sort()) !== JSON.stringify(freshIds))
    throw new Error('Definir stock_by_variation para TODAS las variaciones (por ID)');
  if (Object.values(desired).some(q => !Number.isInteger(q) || q < 0)
      || Object.values(desired).reduce((sum, q) => sum + q, 0) !== row.available_quantity)
    throw new Error('El total no coincide con stock_by_variation; editar cantidades por variación');
  // Array completo de IDs, nunca parcial. Solo campos editables del contrato PUT:
  // reenviar objetos GET con atributos de solo lectura puede rechazar el request.
  return { variations: row.variations_raw.map(v => ({ id: v.id, available_quantity: desired[String(v.id)] })) };
}
export function stockMatches(payload, item) {
  if (!payload.variations) return item.available_quantity === payload.available_quantity;
  const actual = new Map(item.variations.map(v => [String(v.id), v.available_quantity]));
  return actual.size === payload.variations.length && payload.variations.every(v => actual.get(String(v.id)) === v.available_quantity);
}
export async function pushUpdates(ctx) {
  const pending = await ctx.repo.allItems({ pending: true });
  if (!ctx.config.pushEnabled) {
    log('push.disabled', { pending: pending.length });
    return;
  }
  for (const row of pending) {
    ctx.processed.add(row.id);
    try {
      const path = `/items/${encodeURIComponent(row.id)}`;
      const fresh = validateItem(await ctx.ml.request(`${path}?include_attributes=all`), row.id);
      if (String(fresh.seller_id) !== String(ctx.sellerId)) throw new Error('El ítem pertenece a otro vendedor');
      const payload = pushPayload(row, fresh);
      let confirmed = fresh;
      if (!stockMatches(payload, fresh)) {
        await ctx.lease.check();
        await ctx.ml.request(path, { method: 'PUT', body: payload });
        // Confirmar mediante GET: si una venta cambia el stock entre PUT y GET,
        // conservar el pendiente para revisión y no afirmar éxito silenciosamente.
        confirmed = validateItem(await ctx.ml.request(`${path}?include_attributes=all`), row.id);
        if (!stockMatches(payload, confirmed)) throw new Error('ML no confirmó el stock enviado; revisar antes del próximo reintento');
      }
      const applied = await ctx.repo.apply(ctx.lease.owner, confirmed, row.stock_revision);
      log('item.push', { item: row.id, result: applied ? 'ok' : 'new_local_revision_pending' });
    } catch (error) { await itemFailure(ctx, row.id, error, row.stock_revision); }
    await ctx.checkpoint();
    await sleep(ctx.config.putDelay, undefined, { signal: ctx.lease.signal });
  }
}
