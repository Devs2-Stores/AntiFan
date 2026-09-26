import { describe, it, beforeEach, afterEach } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  recordFallbackTelemetry,
  assertRecordableFallbackPayload,
  sanitizeTargetUrl,
  sanitizeString,
  getTelemetryLogPath,
  type FallbackTelemetryPayload,
} from '../../src/main/telemetry/fallback-recorder';

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
  fs.existsSync(gaps) ? fs.readFileSync(gaps, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line)) : [];

/** The single record a successful write must have produced, narrowed for strict indexing. */
const firstRecord = (): Record<string, unknown> => {
  const records = readRecords();
  const [first, ...rest] = records;
  assert.ok(first, 'a telemetry record must have been written');
  assert.equal(rest.length, 0, 'exactly one record is expected');
  return first;
};

const errnoCode = (err: unknown): string | undefined =>
  err instanceof Error && 'code' in err && typeof err.code === 'string' ? err.code : undefined;

describe('FallbackRecorder sanitization', () => {
  it('sanitizeTargetUrl strips basic auth and sensitive query parameters', () => {
    const rawUrl = 'https://admin_user:super_secret_password@shop.myshopify.com/products/test?access_token=shpat_12345&utm_source=google&auth=bearer_token&view=quick';
    const sanitized = sanitizeTargetUrl(rawUrl);

    assert.ok(!sanitized.includes('super_secret_password'), 'Must strip password');
    assert.ok(!sanitized.includes('admin_user'), 'Must strip username');
    assert.ok(!sanitized.includes('shpat_12345'), 'Must strip access_token value');
    assert.ok(!sanitized.includes('bearer_token'), 'Must strip auth value');
    assert.ok(sanitized.includes('utm_source=google'), 'Must keep safe query params');
    assert.ok(sanitized.includes('view=quick'), 'Must keep safe query params');
    assert.ok(sanitized.includes('shop.myshopify.com/products/test'));
  });

  it('sanitizeString strips newlines and caps length', () => {
    const multiLine = 'Error: Target not found\n  at evaluate (line 42)\r\n  caused by Connection Refused';
    const sanitized = sanitizeString(multiLine);
    assert.ok(!sanitized.includes('\n'), 'Must not contain newline characters');
    assert.ok(!sanitized.includes('\r'), 'Must not contain carriage returns');
    assert.strictEqual(sanitized, 'Error: Target not found   at evaluate (line 42)   caused by Connection Refused');
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

describe('fallback telemetry refuses instead of fabricating', () => {
  it('refuses a zero-argument call and writes nothing at all', () => {
    // The measured regression: this exact call returned {"recorded":true,...} and appended
    // a line, because the sanitizer substituted 'unknown' / 'browser_*' / 'FAILED' for the
    // three fields the advertised schema marks required.
    assert.throws(
      () => recordFallbackTelemetry({} as FallbackTelemetryPayload, dir),
      (err: unknown) => {
        assert.equal(errnoCode(err), 'INVALID_ARGUMENT');
        assert.ok(err instanceof Error);
        assert.match(err.message, /primaryTool/);
        assert.match(err.message, /fallbackTool/);
        return true;
      }
    );
    assert.equal(fs.existsSync(gaps), false, 'a refused call must not create the telemetry ledger');
  });

  it('refuses an unsupported fallbackResult rather than defaulting it to FAILED', () => {
    assert.throws(
      () => recordFallbackTelemetry({ primaryTool: 'anti.inspect.dom', fallbackTool: 'playwright', fallbackResult: 'MAYBE' as never }, dir),
      (err: unknown) => {
        assert.equal(errnoCode(err), 'INVALID_ARGUMENT');
        assert.ok(err instanceof Error);
        assert.match(err.message, /SUCCESS, FAILED, SKIPPED/);
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
        assert.ok(err instanceof Error);
        assert.match(err.message, /primaryTool, fallbackTool/);
        return true;
      }
    );
  });
});

describe('fallback telemetry records a complete payload faithfully', () => {
  it('recordFallbackTelemetry writes valid structured JSONL into .antifan/telemetry/gaps.jsonl', () => {
    const res = recordFallbackTelemetry({
      sessionId: 'test-session-123\nnewline',
      targetUrl: 'https://user:pass@example.com/checkout?token=secret123',
      primaryTool: 'anti.agent.cursor.click',
      errorCode: 'REF_NOT_FOUND',
      errorMessage: 'Element @e5 was not found\non current page',
      fallbackTool: 'browser_click',
      fallbackResult: 'SUCCESS',
      durationMs: 45.5,
      notes: 'Playwright resolved selector by fallback text',
    }, dir);

    assert.strictEqual(res.recorded, true);
    assert.ok(fs.existsSync(gaps), 'gaps.jsonl must exist on disk');

    const content = fs.readFileSync(gaps, 'utf8');
    const lines = content.trim().split('\n');
    assert.strictEqual(lines.length, 1);

    const record = JSON.parse(lines[0]!);
    assert.strictEqual(record.primaryTool, 'anti.agent.cursor.click');
    assert.strictEqual(record.fallbackTool, 'browser_click');
    assert.strictEqual(record.fallbackResult, 'SUCCESS');
    assert.strictEqual(record.contextMode, 'STANDALONE_PLAYWRIGHT_DIAGNOSTIC_PROBE');
    assert.ok(!record.targetUrl.includes('pass'));
    assert.ok(!record.targetUrl.includes('secret123'));
    assert.ok(!record.errorMessage.includes('\n'));
    assert.ok(record.timestamp);
  });

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
});
