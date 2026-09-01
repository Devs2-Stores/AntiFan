import { describe, it, before, after } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import {
  sanitizeTargetUrl,
  sanitizeString,
  sanitizeTelemetryPayload,
  recordFallbackTelemetry,
  getTelemetryLogPath,
} from '../../src/main/telemetry/fallback-recorder';

describe('FallbackRecorder: Gap Analysis Telemetry & Sanitization', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'antifan-telemetry-test-'));

  after(() => {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {}
  });

  it('1. sanitizeTargetUrl strips basic auth and sensitive query parameters', () => {
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

  it('2. sanitizeString strips newlines and caps length', () => {
    const multiLine = 'Error: Target not found\n  at evaluate (line 42)\r\n  caused by Connection Refused';
    const sanitized = sanitizeString(multiLine);
    assert.ok(!sanitized.includes('\n'), 'Must not contain newline characters');
    assert.ok(!sanitized.includes('\r'), 'Must not contain carriage returns');
    assert.strictEqual(sanitized, 'Error: Target not found   at evaluate (line 42)   caused by Connection Refused');
  });

  it('3. recordFallbackTelemetry writes valid structured JSONL into .antifan/telemetry/gaps.jsonl', () => {
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
    }, tmpDir);

    assert.strictEqual(res.recorded, true);
    const logPath = getTelemetryLogPath(tmpDir);
    assert.ok(fs.existsSync(logPath), 'gaps.jsonl must exist on disk');

    const content = fs.readFileSync(logPath, 'utf8');
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
});
