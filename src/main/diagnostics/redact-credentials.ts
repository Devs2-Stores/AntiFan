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
    // Anchored: `exitCode=1` or `errorCode=EPERM` are diagnostics, not pairing codes.
    .replace(/((?<![A-Za-z0-9_])code=)[^& \t\r\n"']+/gi, '$1[REDACTED]')
    .replace(/([?&](?:token|secret|code|key)=)[^& \t\r\n"']+/gi, '$1[REDACTED]')
    .replace(/("token"\s*:\s*")[^"]+(")/gi, '$1[REDACTED]$2')
    .replace(/("secret"\s*:\s*")[^"]+(")/gi, '$1[REDACTED]$2')
    .replace(/("code"\s*:\s*")[^"]+(")/gi, '$1[REDACTED]$2');
}

const MAX_REDACT_DEPTH = 4;

function redactValue(value: unknown, depth: number): unknown {
  if (typeof value === 'string') return redactCredentials(value);
  if (depth >= MAX_REDACT_DEPTH || value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map((item) => redactValue(item, depth + 1));
  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) return value;
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(value)) out[key] = redactValue((value as Record<string, unknown>)[key], depth + 1);
  return out;
}

/**
 * Copy of `fields` with every string scrubbed, including strings inside plain objects
 * and arrays up to a small depth (journal rows carry `{ error: { message } }` shapes).
 * Other values are passed through. Returns `undefined` for no fields.
 */
export function redactFields(fields: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
  if (!fields) return fields;
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(fields)) out[key] = redactValue(fields[key], 1);
  return out;
}
