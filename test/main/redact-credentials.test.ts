import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import { redactCredentials, redactFields } from '../../src/main/diagnostics/redact-credentials';

describe('redactCredentials', () => {
  it('redacts bearer tokens, token=/code= pairs and JSON secret fields; leaves ordinary text and non-strings alone', () => {
    assert.equal(redactCredentials('Authorization: Bearer abc.DEF-123=='), 'Authorization: Bearer [REDACTED]');
    assert.equal(redactCredentials('GET /x?token=abc123&y=1'), 'GET /x?token=[REDACTED]&y=1');
    assert.equal(redactCredentials('pairingCode=99 code=77'), 'pairingCode=[REDACTED] code=[REDACTED]');
    assert.equal(redactCredentials('{"token":"abc","secret":"def","code":"ghi","ok":"keep"}'),
      '{"token":"[REDACTED]","secret":"[REDACTED]","code":"[REDACTED]","ok":"keep"}');
    assert.equal(redactCredentials('x-antifan-attachment-secret: s3cr3t'), 'x-antifan-attachment-secret: [REDACTED]');
    assert.equal(redactCredentials('plain failure text'), 'plain failure text');
    assert.equal(redactCredentials(''), '');
    assert.equal(redactCredentials(undefined as unknown as string), undefined);
  });

  it('redactFields scrubs top-level strings only and keeps other values by identity', () => {
    const nested = { token: 'token=abc' };
    const out = redactFields({ detail: 'token=abc', n: 5, nested, flag: true });
    assert.deepEqual(out, { detail: 'token=[REDACTED]', n: 5, nested, flag: true });
    assert.equal(out!.nested, nested);
    assert.equal(redactFields(undefined), undefined);
  });
});
