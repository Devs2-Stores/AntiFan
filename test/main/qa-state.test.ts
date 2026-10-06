import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import { dispositionFor, isRebindableStale, extractErrorCode } from '../../src/main/qa/qa-state';
import { CapabilityError } from '../../src/shared/control-plane-contracts';

function capErr(code: string, details?: Record<string, unknown>): CapabilityError {
  return new CapabilityError(code as never, `msg:${code}`, details);
}

describe('qa-state refusal classifier', () => {
  it('write operations always classify HARD_BLOCK regardless of code', () => {
    assert.equal(dispositionFor(capErr('TARGET_STALE'), 'write'), 'HARD_BLOCK');
    assert.equal(dispositionFor(capErr('CAPABILITY_NOT_FOUND'), 'write'), 'HARD_BLOCK');
    assert.equal(dispositionFor(new Error('boom'), 'write'), 'HARD_BLOCK');
  });

  it('read operations map known code families', () => {
    assert.equal(dispositionFor(capErr('TARGET_STALE'), 'read'), 'AUTO_RECOVER');
    assert.equal(dispositionFor(capErr('LEASE_EXPIRED'), 'read'), 'AUTO_RECOVER');
    assert.equal(dispositionFor(capErr('CAPTURE_TIMEOUT'), 'read'), 'DEGRADED_CONTINUE');
    assert.equal(dispositionFor(capErr('NO_RENDER_SURFACE'), 'read'), 'DEGRADED_CONTINUE');
    assert.equal(dispositionFor(capErr('WAIT_TIMEOUT'), 'read'), 'RETRY_REQUIRED');
    assert.equal(dispositionFor(capErr('SETTLE_INCOMPLETE'), 'read'), 'INCONCLUSIVE');
    assert.equal(dispositionFor(capErr('POLICY_DENIED'), 'read'), 'HARD_BLOCK');
    assert.equal(dispositionFor(capErr('REPLAY_DENIED'), 'read'), 'HARD_BLOCK');
  });

  it('Object.prototype member names do not leak into classification', () => {
    // Prototype-pollution regression: 'toString'/'constructor'/'hasOwnProperty'
    // must classify as unknown (INCONCLUSIVE), not via inherited members.
    assert.equal(dispositionFor(capErr('toString'), 'read'), 'INCONCLUSIVE');
    assert.equal(dispositionFor(capErr('constructor'), 'read'), 'INCONCLUSIVE');
    assert.equal(dispositionFor(capErr('hasOwnProperty'), 'read'), 'INCONCLUSIVE');
    assert.equal(dispositionFor(capErr('valueOf'), 'read'), 'INCONCLUSIVE');
  });

  it('unknown and non-capability errors classify INCONCLUSIVE on reads', () => {
    assert.equal(dispositionFor(capErr('NO_SUCH_CODE'), 'read'), 'INCONCLUSIVE');
    assert.equal(dispositionFor(new Error('generic'), 'read'), 'INCONCLUSIVE');
    assert.equal(dispositionFor('string-error', 'read'), 'INCONCLUSIVE');
    assert.equal(dispositionFor(null, 'read'), 'INCONCLUSIVE');
  });

  it('extractErrorCode reads err.code and falls back to UNKNOWN', () => {
    assert.equal(extractErrorCode(capErr('ABC')), 'ABC');
    assert.equal(extractErrorCode({}), 'UNKNOWN');
    assert.equal(extractErrorCode(null), 'UNKNOWN');
  });

  it('isRebindableStale requires TARGET_STALE plus an explicit rebind signal', () => {
    assert.equal(isRebindableStale(capErr('TARGET_STALE', { canRebind: true })), true);
    assert.equal(isRebindableStale(capErr('TARGET_STALE', { recovery: 'rebind to live target' })), true);
    assert.equal(isRebindableStale(capErr('TARGET_STALE')), false);
    assert.equal(isRebindableStale(capErr('TARGET_STALE', { canRebind: false })), false);
    assert.equal(isRebindableStale(capErr('TARGET_MISMATCH')), false);
  });
});
