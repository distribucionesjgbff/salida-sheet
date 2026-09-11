import { createClient } from '@supabase/supabase-js';

export class DatabaseError extends Error {}
export async function checked(query) {
  try {
    const { data, error } = await query;
    if (error) throw new DatabaseError(`Supabase: ${error.message}`);
    return data;
  } catch (error) {
    if (error instanceof DatabaseError) throw error;
    throw new DatabaseError(`Supabase: ${error.message ?? 'request failed'}`);
  }
}
export function database(config) {
  const client = createClient(config.supabaseUrl, config.supabaseKey, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    global: { fetch: (url, options = {}) => fetch(url, {
      ...options, signal: options.signal
        ? AbortSignal.any([options.signal, AbortSignal.timeout(30000)]) : AbortSignal.timeout(30000)
    }) }
  });
  return new Repository(client);
}
export class Repository {
  constructor(client) { this.client = client; }
  rpc(name, args) { return checked(this.client.rpc(name, args)); }
  async allItems({ pending = false } = {}) {
    const rows = [];
    let after = '';
    while (true) {
      let query = this.client.from('items').select('*').order('id').gt('id', after).limit(500);
      if (pending) query = query.eq('push_pending', true);
      const page = await checked(query);
      rows.push(...page);
      if (page.length < 500) return rows;
      after = page.at(-1).id;
    }
  }
  auth() { return checked(this.client.from('ml_auth').select('*').eq('id', 1).single()); }
  saveAuth(owner, data) { return this.rpc('save_ml_auth', { p_owner: owner, p_data: data }); }
  apply(owner, item, revision = null) {
    return this.rpc('apply_ml_snapshot', { p_owner: owner, p_item: item, p_revision: revision });
  }
  markError(owner, id, error, revision = null) {
    return this.rpc('mark_item_error', { p_owner: owner, p_id: id, p_error: error, p_revision: revision });
  }
  async startRun(task, mode) {
    // Con el lease adquirido, cualquier running anterior de esta tarea quedó huérfano.
    await checked(this.client.from('sync_runs').update({ status: 'failed', finished_at: new Date().toISOString(),
      notes: 'Proceso anterior interrumpido; lease vencido.' }).eq('task', task).eq('status', 'running'));
    return checked(this.client.from('sync_runs').insert({ task, mode }).select('id').single());
  }
  updateRun(id, data) { return checked(this.client.from('sync_runs').update(data).eq('id', id)); }
}
