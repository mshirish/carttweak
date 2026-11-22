// Redaction for anything printed or written to disk. Secrets never leave memory.
const registered = new Set<string>();

export function registerSecret(value: string | null | undefined): void {
  if (value && value.length >= 4) registered.add(value);
}

export function redact(input: unknown): string {
  let s = typeof input === 'string' ? input : JSON.stringify(input);
  if (s == null) return String(s);
  for (const secret of registered) s = s.split(secret).join('[REDACTED]');
  // Base64 of "id:secret" for Basic auth
  s = s.replace(/(Basic\s+)[A-Za-z0-9+/=]{8,}/gi, '$1[REDACTED]');
  s = s.replace(/(Bearer\s+)[A-Za-z0-9._~+/=-]+/gi, '$1[REDACTED]');
  s = s.replace(/("access_token"\s*:\s*")[^"]+/gi, '$1[REDACTED]');
  s = s.replace(/("refresh_token"\s*:\s*")[^"]+/gi, '$1[REDACTED]');
  s = s.replace(/([?&]api_key=)[^&\s"']+/gi, '$1[REDACTED]');
  return s;
}

/** URL safe to store as a source: api_key query param removed entirely. */
export function publicUrl(url: string): string {
  const u = new URL(url);
  u.searchParams.delete('api_key');
  return u.toString();
}
