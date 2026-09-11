import { registerSecret } from './log.js';

function required(env, key) {
  if (!env[key]?.trim()) throw new Error(`Falta variable ${key}`);
  return env[key];
}
function integer(env, key, fallback, min, max) {
  const value = Number(env[key] ?? fallback);
  if (!Number.isInteger(value) || value < min || value > max) throw new Error(`${key} inválido`);
  return value;
}
export function config(task, env = process.env) {
  for (const key of ['ML_CLIENT_SECRET','ML_REFRESH_TOKEN','SUPABASE_SERVICE_ROLE_KEY','GOOGLE_SERVICE_ACCOUNT_JSON']) registerSecret(env[key]);
  const result = {
    supabaseUrl: required(env, 'SUPABASE_URL'),
    supabaseKey: required(env, 'SUPABASE_SERVICE_ROLE_KEY'),
    concurrency: integer(env, 'ML_GET_CONCURRENCY', 20, 1, 20),
    putDelay: integer(env, 'ML_PUT_DELAY_MS', 350, 0, 60000),
    pushEnabled: env.PUSH_ENABLED === 'true'
  };
  if (env.PUSH_ENABLED && !['true','false'].includes(env.PUSH_ENABLED)) throw new Error('PUSH_ENABLED debe ser true o false');
  if (task === 'mirror') {
    result.googleCredentials = JSON.parse(required(env, 'GOOGLE_SERVICE_ACCOUNT_JSON'));
    registerSecret(result.googleCredentials.private_key);
    result.sheetId = required(env, 'MIRROR_SHEET_ID');
    required(env, 'MIRROR_TAB_ID');
    result.tabId = integer(env, 'MIRROR_TAB_ID', 0, 0, 2147483647);
  } else {
    result.clientId = required(env, 'ML_CLIENT_ID');
    result.clientSecret = required(env, 'ML_CLIENT_SECRET');
    result.refreshToken = env.ML_REFRESH_TOKEN;
  }
  return result;
}
