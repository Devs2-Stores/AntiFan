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

  it('keeps diagnostic codes that only end in `code=`', () => {
    assert.equal(redactCredentials('child exitCode=3 errorCode=EPERM statusCode=500'),
      'child exitCode=3 errorCode=EPERM statusCode=500');
    assert.equal(redactCredentials('GET /p?errorCode=1&code=77'), 'GET /p?errorCode=1&code=[REDACTED]');
  });

  it('redactFields scrubs strings inside plain objects and arrays, and passes other values through', () => {
    const when = new Date(0);
    const out = redactFields({
      detail: 'token=abc',
      n: 5,
      flag: true,
      when,
      error: { message: 'Authorization: Bearer s3cr3t', codes: ['secret=x', 7] },
    });
    assert.deepEqual(out, {
      detail: 'token=[REDACTED]',
      n: 5,
      flag: true,
      when,
      error: { message: 'Authorization: Bearer [REDACTED]', codes: ['secret=[REDACTED]', 7] },
    });
    assert.equal(out!.when, when, 'non-plain objects are not copied');
    assert.equal(redactFields(undefined), undefined);
  });

  it('stops descending at a fixed depth so a cyclic or deep value cannot hang the journal', () => {
    const cyclic: Record<string, unknown> = { token: 'token=abc' };
    cyclic.self = cyclic;
    const out = redactFields({ cyclic }) as { cyclic: Record<string, unknown> };
    assert.equal(out.cyclic.token, 'token=[REDACTED]');
  });
});
