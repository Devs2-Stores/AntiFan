/**
 * Credential scrubbing shared by the bridge responses and the lifecycle journal sink.
 * Kept free of imports so any module can use it without a dependency cycle.
 */

export function redactCredentials(input: string): string {
  if (!input || typeof input !== 'string') return input;
  return input
    .replace(/(Bearer\s+)[A-Za-z0-9._~+/-]+=*/gi, '$1[REDACTED]')
    .replace(/(x-antifan-attachment-secret:\s*)[A-Za-z0-9._~+/-]+=*/gi, '$1[REDACTED]')
    .replace(/(token=)[^& \t\r\n"']+/gi, '$1[REDACTED]')
    .replace(/(secret=)[^& \t\r\n"']+/gi, '$1[REDACTED]')
    .replace(/(pairingCode=)[^& \t\r\n"']+/gi, '$1[REDACTED]')
    .replace(/(code=)[^& \t\r\n"']+/gi, '$1[REDACTED]')
    .replace(/([?&](?:token|secret|code|key)=)[^& \t\r\n"']+/gi, '$1[REDACTED]')
    .replace(/("token"\s*:\s*")[^"]+(")/gi, '$1[REDACTED]$2')
    .replace(/("secret"\s*:\s*")[^"]+(")/gi, '$1[REDACTED]$2')
    .replace(/("code"\s*:\s*")[^"]+(")/gi, '$1[REDACTED]$2');
}

/**
 * Shallow copy of `fields` with every top-level string value scrubbed. Non-string
 * values are passed through untouched. Returns `undefined` for no fields.
 */
export function redactFields(fields: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
  if (!fields) return fields;
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(fields)) {
    const value = fields[key];
    out[key] = typeof value === 'string' ? redactCredentials(value) : value;
  }
  return out;
}
