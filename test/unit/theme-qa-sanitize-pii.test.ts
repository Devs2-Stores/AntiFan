import { describe, it } from 'node:test';
import * as assert from 'node:assert';
import { sanitizePii } from '../../src/main/qa/theme-qa-workflow';

describe('ThemeQaWorkflow.sanitizePii', () => {
  it('leaves longer numeric fields intact so the serialized report stays parseable', () => {
    const serialized = JSON.stringify(
      {
        createdAt: 1790356373134,
        byteLength: 1790356373134,
        documentGeneration: 1790356373134,
      },
      null,
      2
    );

    const sanitized = sanitizePii(serialized);

    assert.strictEqual(sanitized, serialized);
    assert.deepStrictEqual(JSON.parse(sanitized), JSON.parse(serialized));
  });

  it('still redacts a real phone number and email inside report text', () => {
    const sanitized = sanitizePii('Customer phone 0987654321 / +84987654321, mail test.merchant@example.com');

    assert.ok(sanitized.includes('[REDACTED_PHONE]'));
    assert.ok(!sanitized.includes('0987654321'));
    assert.ok(!sanitized.includes('+84987654321'));
    assert.ok(sanitized.includes('[REDACTED_EMAIL]'));
    assert.ok(!sanitized.includes('test.merchant@example.com'));
  });

  it('keeps a redacted JSON string field structurally valid', () => {
    const serialized = JSON.stringify({ message: 'Unknown customer 0987654321 not found' });
    const sanitized = sanitizePii(serialized);

    assert.deepStrictEqual(JSON.parse(sanitized), {
      message: 'Unknown customer [REDACTED_PHONE] not found',
    });
  });
});
