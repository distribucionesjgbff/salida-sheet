import { readFile } from 'node:fs/promises';
import pg from 'pg';

if (!process.env.DATABASE_URL) throw new Error('Falta DATABASE_URL (solo necesaria para migrar)');
const client = new pg.Client({ connectionString: process.env.DATABASE_URL, connectionTimeoutMillis: 30000 });
try {
  await client.connect();
  const existing = await client.query("select to_regclass('public.items') as items, to_regclass('public.sync_runs') as runs, to_regclass('public.ml_auth') as auth");
  if (Object.values(existing.rows[0]).some(Boolean)) throw new Error('Ya existen tablas del proyecto. Revisar antes de aplicar 001; no se modifica esquema existente automáticamente.');
  await client.query(await readFile(new URL('../migrations/001_init.sql', import.meta.url), 'utf8'));
  console.log(`${new Date().toISOString()} migration 001_init applied`);
} finally { await client.end(); }
