import { describe, it, beforeEach, afterEach } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  recordFallbackTelemetry,
  assertRecordableFallbackPayload,
  sanitizeTargetUrl,
  getTelemetryLogPath,
  type FallbackTelemetryPayload,
} from './fallback-recorder.js';

let dir: string;
let gaps: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'antifan-telemetry-'));
  gaps = getTelemetryLogPath(dir);
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

const readRecords = (): Array<Record<string, unknown>> =>
  fs.existsSync(gaps) ? fs.readFileSync(gaps, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [];

/** The single record a successful write must have produced, narrowed for strict indexing. */
const firstRecord = (): Record<string, unknown> => {
  const records = readRecords();
  const [first, ...rest] = records;
  assert.ok(first, 'a telemetry record must have been written');
  assert.equal(rest.length, 0, 'exactly one record is expected');
  return first;
};

describe('fallback telemetry refuses instead of fabricating', () => {
  it('refuses a zero-argument call and writes nothing at all', () => {
    // The measured regression: this exact call returned {"recorded":true,...} and appended
    // a line, because the sanitizer substituted 'unknown' / 'browser_*' / 'FAILED' for the
    // three fields the advertised schema marks required.
    assert.throws(
      () => recordFallbackTelemetry({} as FallbackTelemetryPayload, dir),
      (err: unknown) => {
        const e = err as { code?: string; message: string };
        assert.equal(e.code, 'INVALID_ARGUMENT');
        assert.match(e.message, /primaryTool/);
        assert.match(e.message, /fallbackTool/);
        return true;
      }
    );
    assert.equal(fs.existsSync(gaps), false, 'a refused call must not create the telemetry ledger');
  });

  it('refuses an unsupported fallbackResult rather than defaulting it to FAILED', () => {
    assert.throws(
      () => recordFallbackTelemetry({ primaryTool: 'anti.inspect.dom', fallbackTool: 'playwright', fallbackResult: 'MAYBE' as never }, dir),
      (err: unknown) => {
        assert.equal((err as { code?: string }).code, 'INVALID_ARGUMENT');
        assert.match((err as Error).message, /SUCCESS, FAILED, SKIPPED/);
        return true;
      }
    );
    assert.equal(fs.existsSync(gaps), false);
  });

  it('treats a whitespace-only tool name as unsupplied', () => {
    assert.throws(() => assertRecordableFallbackPayload({ primaryTool: '   ', fallbackTool: 'playwright', fallbackResult: 'SUCCESS' }), /primaryTool/);
  });

  it('reports every unusable required field in one refusal', () => {
    assert.throws(
      () => assertRecordableFallbackPayload({} as FallbackTelemetryPayload),
      (err: unknown) => {
        assert.match((err as Error).message, /primaryTool, fallbackTool/);
        return true;
      }
    );
  });
});

describe('fallback telemetry records a complete payload faithfully', () => {
  it('writes exactly one line and invents no values', () => {
    const result = recordFallbackTelemetry(
      {
        primaryTool: 'anti.inspect.dom',
        fallbackTool: 'playwright.snapshot',
        fallbackResult: 'SKIPPED',
        sessionId: 'session-1',
        errorCode: 'WAIT_TIMEOUT',
      },
      dir
    );

    assert.equal(result.recorded, true);
    assert.equal(readRecords().length, 1);
    const rec = firstRecord();
    assert.equal(rec.primaryTool, 'anti.inspect.dom');
    assert.equal(rec.fallbackTool, 'playwright.snapshot');
    assert.equal(rec.fallbackResult, 'SKIPPED');
    assert.equal(rec.sessionId, 'session-1');
    assert.equal(rec.errorCode, 'WAIT_TIMEOUT');
    assert.equal(rec.contextMode, 'STANDALONE_PLAYWRIGHT_DIAGNOSTIC_PROBE');
    assert.equal(typeof rec.timestamp, 'string');
  });

  it('leaves optional fields absent instead of substituting plausible values', () => {
    recordFallbackTelemetry({ primaryTool: 'a', fallbackTool: 'b', fallbackResult: 'FAILED' }, dir);
    const rec = firstRecord();
    assert.equal(rec.errorCode, undefined, "an unsupplied errorCode must not become 'UNKNOWN_ERROR'");
    assert.equal(rec.errorMessage, undefined);
    assert.equal(rec.sessionId, undefined);
    assert.equal(rec.targetUrl, undefined);
    assert.equal(rec.notes, undefined);
    assert.equal(rec.durationMs, undefined);
  });

  it('appends rather than truncating the ledger', () => {
    recordFallbackTelemetry({ primaryTool: 'a', fallbackTool: 'b', fallbackResult: 'SUCCESS' }, dir);
    recordFallbackTelemetry({ primaryTool: 'c', fallbackTool: 'd', fallbackResult: 'FAILED' }, dir);
    assert.deepEqual(readRecords().map((r) => r.primaryTool), ['a', 'c']);
  });

  it('keeps URL sanitisation: credentials and sensitive query values never reach the ledger', () => {
    const sanitized = sanitizeTargetUrl('https://user:pw@shop.test/path?token=abc123&keep=1');
    assert.doesNotMatch(sanitized, /pw/);
    assert.doesNotMatch(sanitized, /abc123/);
    assert.match(sanitized, /REDACTED/);
    assert.match(sanitized, /keep=1/);

    recordFallbackTelemetry(
      { primaryTool: 'a', fallbackTool: 'b', fallbackResult: 'SUCCESS', targetUrl: 'https://user:pw@shop.test/path?token=abc123&keep=1' },
      dir
    );
    const rec = firstRecord();
    assert.doesNotMatch(String(rec.targetUrl), /abc123/);
    assert.match(String(rec.targetUrl), /keep=1/);
  });
});
