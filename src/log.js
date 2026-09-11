const secrets = new Set();
export function registerSecret(value) { if (value) secrets.add(String(value)); }
export function safeError(error) {
  let message = String(error?.message ?? error);
  for (const secret of secrets) message = message.replaceAll(secret, '[REDACTED]');
  return message.replace(/(Bearer\s+)\S+/gi, '$1[REDACTED]').slice(0, 2000);
}
export function log(operation, context = {}, level = 'info') {
  const line = JSON.stringify({ timestamp: new Date().toISOString(), level, operation, ...context });
  (level === 'error' ? console.error : console.log)(line);
}
