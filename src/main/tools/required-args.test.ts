import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import { findMissingRequiredArgs, assertRequiredArgs, checkRequiredArgs } from './required-args.js';

/**
 * These cases pin the contract that the live bridge was measured to violate: all three
 * of `tabs.activate {}`, `rebind_target {}` and `set_automation_target {}` were ACCEPTED
 * even though their advertised schema marks `tabId` required. The gate must refuse the
 * omission, and it must not over-refuse values that are real caller intent.
 */
describe('findMissingRequiredArgs', () => {
  it('reports a required field that the call omitted entirely', () => {
    assert.deepEqual(findMissingRequiredArgs({ required: ['tabId'] }, {}), ['tabId']);
  });

  it('reports nothing when every required field carries a value', () => {
    assert.deepEqual(findMissingRequiredArgs({ required: ['tabId'] }, { tabId: 'tab-1' }), []);
  });

  it('treats a blank string as unsupplied', () => {
    assert.deepEqual(findMissingRequiredArgs({ required: ['tabId'] }, { tabId: '   ' }), ['tabId']);
  });

  it('treats an explicit null or undefined as unsupplied', () => {
    assert.deepEqual(findMissingRequiredArgs({ required: ['tabId'] }, { tabId: null }), ['tabId']);
    assert.deepEqual(findMissingRequiredArgs({ required: ['tabId'] }, { tabId: undefined }), ['tabId']);
  });

  it('enforces nothing when the schema declares no required list', () => {
    assert.deepEqual(findMissingRequiredArgs({}, { anything: 1 }), []);
    assert.deepEqual(findMissingRequiredArgs(undefined, {}), []);
    assert.deepEqual(findMissingRequiredArgs({ required: [] }, {}), []);
  });

  it('counts an empty array as supplied, because emptiness is domain semantics', () => {
    // `dropFiles` with filePaths: [] has a caller-specific meaning and its own error;
    // refusing it here would replace that explanation with a generic one.
    assert.deepEqual(
      findMissingRequiredArgs({ required: ['refOrSelector', 'filePaths'] }, { filePaths: [] }),
      ['refOrSelector']
    );
  });

  it('counts 0 and false as supplied values', () => {
    // `browser.set-viewport {width:0,height:0}` is a real request, not a missing one.
    assert.deepEqual(findMissingRequiredArgs({ required: ['width', 'height'] }, { width: 0, height: 0 }), []);
    assert.deepEqual(findMissingRequiredArgs({ required: ['reload'] }, { reload: false }), []);
  });

  it('reports every missing field in schema order', () => {
    assert.deepEqual(findMissingRequiredArgs({ required: ['width', 'height'] }, {}), ['width', 'height']);
  });
});

/**
 * `oneOf` covers argument forms a flat `required` list cannot express - a capability that
 * accepts `expression` OR `expressionFile` advertises
 * `oneOf: [{ required: ['expression'] }, { required: ['expressionFile'] }]` and the gate
 * must pass whichever form the caller chose, refuse a call that satisfied neither, and
 * stay out of the way when several forms are supplied at once (which combination is legal
 * is the capability's domain decision, not the gate's).
 */
describe('oneOf required alternatives', () => {
  const schema = { oneOf: [{ required: ['expression'] }, { required: ['expressionFile'] }] };

  it('passes when the first advertised form is fully supplied', () => {
    assert.equal(checkRequiredArgs('anti.browser.evaluate', schema, { expression: 'document.title' }), undefined);
    assert.doesNotThrow(() => assertRequiredArgs('anti.browser.evaluate', schema, { expression: 'document.title' }));
  });

  it('passes when the second advertised form is fully supplied', () => {
    assert.equal(checkRequiredArgs('anti.browser.evaluate', schema, { expressionFile: 'scripts/probe.js' }), undefined);
    assert.doesNotThrow(() => assertRequiredArgs('anti.browser.evaluate', schema, { expressionFile: 'scripts/probe.js' }));
  });

  it('refuses a call that satisfied neither form, naming both alternatives', () => {
    const refusal = checkRequiredArgs('anti.browser.evaluate', schema, {});
    assert.ok(refusal);
    assert.deepEqual(refusal.missing, []);
    assert.deepEqual(refusal.unsatisfiedAlternatives, [['expression'], ['expressionFile']]);
    assert.match(refusal.message, /expression/);
    assert.match(refusal.message, /expressionFile/);
    assert.throws(
      () => assertRequiredArgs('anti.browser.evaluate', schema, {}),
      (err: unknown) => {
        const e = err as { code?: string; message: string };
        assert.equal(e.code, 'INVALID_ARGUMENT');
        assert.match(e.message, /anti\.browser\.evaluate/);
        assert.match(e.message, /expression/);
        assert.match(e.message, /expressionFile/);
        return true;
      }
    );
  });

  it('passes when both forms are supplied, leaving the combination to the capability', () => {
    assert.equal(
      checkRequiredArgs('anti.browser.evaluate', schema, { expression: '1', expressionFile: 'scripts/probe.js' }),
      undefined
    );
    assert.doesNotThrow(() =>
      assertRequiredArgs('anti.browser.evaluate', schema, { expression: '1', expressionFile: 'scripts/probe.js' })
    );
  });

  it('still enforces the flat required list alongside a satisfied oneOf', () => {
    const combined = { required: ['tabId'], oneOf: [{ required: ['expression'] }, { required: ['expressionFile'] }] };
    const refusal = checkRequiredArgs('anti.browser.evaluate', combined, { expression: '1' });
    assert.ok(refusal);
    assert.deepEqual(refusal.missing, ['tabId']);
    assert.deepEqual(refusal.unsatisfiedAlternatives, []);
  });

  it('still enforces the oneOf alongside a satisfied flat required list', () => {
    const combined = { required: ['tabId'], oneOf: [{ required: ['expression'] }, { required: ['expressionFile'] }] };
    const refusal = checkRequiredArgs('anti.browser.evaluate', combined, { tabId: 'tab-1' });
    assert.ok(refusal);
    assert.deepEqual(refusal.missing, []);
    assert.deepEqual(refusal.unsatisfiedAlternatives, [['expression'], ['expressionFile']]);
  });

  it('treats a blank-string member of a form as unsupplied', () => {
    const refusal = checkRequiredArgs('anti.browser.evaluate', schema, { expression: '   ' });
    assert.ok(refusal);
    assert.deepEqual(refusal.unsatisfiedAlternatives, [['expression'], ['expressionFile']]);
  });
});

describe('assertRequiredArgs', () => {
  it('refuses an omitted required tabId with a code the caller can act on', () => {
    assert.throws(
      () => assertRequiredArgs('anti.browser.tabs.activate', { required: ['tabId'] }, {}),
      (err: unknown) => {
        const e = err as { code?: string; message: string };
        assert.equal(e.code, 'INVALID_ARGUMENT');
        assert.match(e.message, /anti\.browser\.tabs\.activate/);
        assert.match(e.message, /tabId/);
        return true;
      }
    );
  });

  it('accepts the same call once the required field is supplied', () => {
    assert.doesNotThrow(() => assertRequiredArgs('anti.browser.tabs.activate', { required: ['tabId'] }, { tabId: 'tab-9' }));
  });

  it('leaves capabilities without a required list untouched', () => {
    assert.doesNotThrow(() => assertRequiredArgs('theme.assert_cart', { properties: { tabId: { type: 'string' } } }, {}));
  });
});
