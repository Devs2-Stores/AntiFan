import * as fs from 'node:fs';
import * as path from 'node:path';

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
    primaryTool: sanitizeString(payload.primaryTool, 128) || 'unknown',
    errorCode: sanitizeString(payload.errorCode, 64) || 'UNKNOWN_ERROR',
    errorMessage: sanitizeString(payload.errorMessage, 1024) || undefined,
    fallbackTool: sanitizeString(payload.fallbackTool, 128) || 'browser_*',
    fallbackResult: payload.fallbackResult || 'FAILED',
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
