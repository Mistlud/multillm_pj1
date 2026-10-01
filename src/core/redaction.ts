const secrets = new Set<string>();
const privateField = /^(?:authorization|cookie|set-cookie|credential(?:ref)?|credentials|api[_-]?key|access[_-]?token|refresh[_-]?token|client[_-]?secret|private[_-]?key|password|secret|bearer[_-]?token)$/i;
export function registerSecret(value: string): void {
  if (value.length >= 6) secrets.add(value);
  try { const parsed = JSON.parse(value); if (parsed && typeof parsed === 'object') for (const [key, item] of Object.entries(parsed)) if (privateField.test(key) && typeof item === 'string' && item.length >= 6) secrets.add(item); } catch { /* Plain API keys are also supported. */ }
}
function redactText(value: string): string {
  let text = value.replace(/-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?-----END [^-]*PRIVATE KEY-----/g, '[REDACTED]')
    .replace(/\bBearer\s+[A-Za-z0-9._~+\/-]+=*/gi, 'Bearer [REDACTED]')
    .replace(/\b(?:sk-[A-Za-z0-9_-]{12,}|AIza[A-Za-z0-9_-]{20,}|eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)\b/g, '[REDACTED]')
    .replace(/\b(api[_ -]?key|access[_ -]?token|refresh[_ -]?token|client[_ -]?secret|private[_ -]?key|password)\s*[=:]\s*["']?[^\s,"'}]+/gi, '$1=[REDACTED]');
  for (const secret of secrets) text = text.split(secret).join('[REDACTED]');
  return text.slice(0, 32_000);
}
/** Preserve provider error fields while removing secrets before any persistence or display. */
export function sanitizeError(value: unknown, depth = 0): any {
  if (depth > 12) return '[truncated]';
  if (typeof value === 'string') return redactText(value);
  if (value instanceof Error) return redactText(value.message);
  if (value === null || typeof value === 'number' || typeof value === 'boolean') return value;
  if (Array.isArray(value)) return value.slice(0, 100).map((item) => sanitizeError(item, depth + 1));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).slice(0, 100).map(([key, item]) => [key, privateField.test(key) ? '[REDACTED]' : sanitizeError(item, depth + 1)]));
  return null;
}
