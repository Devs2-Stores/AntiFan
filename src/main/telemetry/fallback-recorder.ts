import * as fs from 'node:fs';
import * as path from 'node:path';
import { CapabilityError } from '../../shared/control-plane-contracts';

export interface FallbackTelemetryPayload {
  sessionId?: string;
  targetUrl?: string;
  primaryTool: string;
  errorCode?: string;
  errorMessage?: string;
  fallbackTool: string;
  fallbackResult: 'SUCCESS' | 'FAILED' | 'SKIPPED';
  durationMs?: number;
  notes?: string;
}

export interface SanitizedTelemetryRecord extends FallbackTelemetryPayload {
  timestamp: string;
  contextMode: 'STANDALONE_PLAYWRIGHT_DIAGNOSTIC_PROBE';
}

const MAX_LOG_SIZE_BYTES = 10 * 1024 * 1024; // 10MB rotation boundary
const SENSITIVE_QUERY_PARAMS = new Set(['token', 'auth', 'secret', 'access_token', 'key', 'apikey', 'api_key', 'password', 'sig', 'signature']);
const FALLBACK_RESULTS = ['SUCCESS', 'FAILED', 'SKIPPED'] as const;
type FallbackResult = (typeof FALLBACK_RESULTS)[number];

/**
 * The result tag is validated instead of assumed: a record whose `fallbackResult` is
 * absent or invented describes a fallback outcome that never happened, and telemetry
 * that cannot be distinguished from measurement is worse than no telemetry.
 */
export function normalizeFallbackResult(value: unknown): FallbackResult {
  const candidate = typeof value === 'string' ? value.trim() : '';
  if (!(FALLBACK_RESULTS as readonly string[]).includes(candidate)) {
    throw new CapabilityError(
      'INVALID_ARGUMENT',
      `Fallback telemetry 'fallbackResult' must be one of ${FALLBACK_RESULTS.join(', ')}; received ${JSON.stringify(value)}. No record was written.`
    );
  }
  return candidate as FallbackResult;
}

/**
 * Refuses a payload whose required fields are missing or unusable.
 *
 * Measured on the live bridge: `anti.telemetry.record_fallback` with no arguments at all
 * returned `{"recorded":true,...}` and appended a line to `gaps.jsonl`, because the
 * sanitizer substituted `'unknown'`, `'browser_*'` and `'FAILED'` for the three fields
 * the advertised schema marks required. That turned an empty call into a record that
 * looked exactly like a real fallback event, so the ledger could not be trusted as
 * evidence. A refusal is the only honest outcome.
 */
export function assertRecordableFallbackPayload(payload: FallbackTelemetryPayload): void {
  const observed = payload as Partial<FallbackTelemetryPayload> | undefined;
  const missing: string[] = [];
  if (!sanitizeString(observed?.primaryTool, 128)) missing.push('primaryTool');
  if (!sanitizeString(observed?.fallbackTool, 128)) missing.push('fallbackTool');
  // Collected rather than thrown on first sight: a caller that sent nothing needs the
  // whole list in one refusal, not one field per attempt.
  const result = typeof observed?.fallbackResult === 'string' ? observed.fallbackResult.trim() : '';
  if (!(FALLBACK_RESULTS as readonly string[]).includes(result)) missing.push('fallbackResult');
  if (missing.length > 0) {
    const detail = missing.includes('fallbackResult')
      ? ` (received fallbackResult=${JSON.stringify(observed?.fallbackResult)}; allowed: ${FALLBACK_RESULTS.join(', ')})`
      : '';
    throw new CapabilityError(
      'INVALID_ARGUMENT',
      `Fallback telemetry requires ${missing.join(', ')}, and this call supplied no usable value for ${missing.length === 1 ? 'it' : 'them'}.${detail} ` +
        'The record is refused rather than written with substituted values, because a fabricated fallback record is indistinguishable from a measured one.'
    );
  }
}

export function sanitizeTargetUrl(rawUrl?: string): string {
  if (!rawUrl || typeof rawUrl !== 'string') return '';
  try {
    const parsed = new URL(rawUrl);
    // Strip user:pass basic auth
    parsed.username = '';
    parsed.password = '';
    // Strip sensitive query params
    const keys = Array.from(parsed.searchParams.keys());
    for (const key of keys) {
      if (SENSITIVE_QUERY_PARAMS.has(key.toLowerCase())) {
        parsed.searchParams.set(key, '[REDACTED]');
      }
    }
    return parsed.toString();
  } catch {
    // Fallback: strip after ? or #
    return rawUrl.replace(/[\?#].*$/, '').replace(/\/\/.*@/, '//');
  }
}

export function sanitizeString(val?: string, maxLen = 2048): string {
  if (!val || typeof val !== 'string') return '';
  return val
    .slice(0, maxLen)
    .replace(/\r?\n|\r/g, ' ')
    .trim();
}

export function sanitizeTelemetryPayload(payload: FallbackTelemetryPayload): SanitizedTelemetryRecord {
  return {
    timestamp: new Date().toISOString(),
    contextMode: 'STANDALONE_PLAYWRIGHT_DIAGNOSTIC_PROBE',
    sessionId: sanitizeString(payload.sessionId, 128) || undefined,
    targetUrl: sanitizeTargetUrl(payload.targetUrl) || undefined,
    // No fabricated stand-ins: a value the caller did not supply stays empty rather than
    // being replaced by a plausible one. The required fields are guaranteed present here
    // because `assertRecordableFallbackPayload` refuses the call before any record is built.
    primaryTool: sanitizeString(payload.primaryTool, 128),
    errorCode: sanitizeString(payload.errorCode, 64) || undefined,
    errorMessage: sanitizeString(payload.errorMessage, 1024) || undefined,
    fallbackTool: sanitizeString(payload.fallbackTool, 128),
    fallbackResult: normalizeFallbackResult(payload.fallbackResult),
    durationMs: typeof payload.durationMs === 'number' && Number.isFinite(payload.durationMs) ? Math.max(0, payload.durationMs) : undefined,
    notes: sanitizeString(payload.notes, 1024) || undefined,
  };
}

export function getTelemetryLogPath(baseDir = process.cwd()): string {
  return path.join(baseDir, '.antifan', 'telemetry', 'gaps.jsonl');
}

export function recordFallbackTelemetry(
  payload: FallbackTelemetryPayload,
  baseDir = process.cwd()
): { recorded: boolean; path: string; record: SanitizedTelemetryRecord } {
  // Refused before any filesystem work: nothing is created, rotated or appended for a
  // payload that does not actually describe a fallback event.
  assertRecordableFallbackPayload(payload);

  const logPath = getTelemetryLogPath(baseDir);
  const logDir = path.dirname(logPath);

  try {
    if (!fs.existsSync(logDir)) {
      fs.mkdirSync(logDir, { recursive: true });
    }

    // Check for 10MB rotation
    if (fs.existsSync(logPath)) {
      const stats = fs.statSync(logPath);
      if (stats.size >= MAX_LOG_SIZE_BYTES) {
        const rotatedPath = path.join(logDir, `gaps-${Date.now()}.jsonl`);
        fs.renameSync(logPath, rotatedPath);
      }
    }

    const record = sanitizeTelemetryPayload(payload);
    const jsonLine = JSON.stringify(record) + '\n';
    fs.appendFileSync(logPath, jsonLine, 'utf8');

    return { recorded: true, path: logPath, record };
  } catch (err: unknown) {
    const record = sanitizeTelemetryPayload(payload);
    return { recorded: false, path: logPath, record };
  }
}
