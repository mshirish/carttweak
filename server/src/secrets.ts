// Secrets live only in this process. Everything written to disk or sent to a
// client passes through redact().
const registered = new Set<string>();

export function registerSecret(value: string | null | undefined): void {
  if (value && value.length >= 4) registered.add(value);
}

export function redact(input: string): string {
  let s = input;
  for (const secret of registered) s = s.split(secret).join('[REDACTED]');
  s = s.replace(/(Basic\s+)[A-Za-z0-9+/=]{8,}/gi, '$1[REDACTED]');
  s = s.replace(/(Bearer\s+)[A-Za-z0-9._~+/=-]+/gi, '$1[REDACTED]');
  s = s.replace(/("access_token"\s*:\s*")[^"]+/gi, '$1[REDACTED]');
  s = s.replace(/([?&]api_key=)[^&\s"']+/gi, '$1[REDACTED]');
  return s;
}

/** True if any registered secret appears in the text. */
export function containsSecret(text: string): boolean {
  for (const secret of registered) if (text.includes(secret)) return true;
  return false;
}

/** URL safe to store or return: api_key removed; Kroger tracking `cid` (which embeds the client id) removed. */
export function publicUrl(url: string): string {
  const u = new URL(url);
  u.searchParams.delete('api_key');
  u.searchParams.delete('cid');
  return redact(u.toString());
}
