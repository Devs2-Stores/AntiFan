import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import * as vm from 'node:vm';
import { SemanticRefRegistry, makeTargetKey } from '../../src/main/browser/semantic-ref-registry';
import { RawElementDescriptor } from '../../src/main/browser/semantic-ref-types';
import { CapabilityError } from '../../src/shared/control-plane-contracts';
import { buildIsolatedCollectorScript, buildIsolatedExecutorScript } from '../../src/main/browser/semantic-ref-executor';
describe('SemanticRefRegistry Pure Main Authority', () => {
  const sampleDescriptor = (id: string, tag = 'button', label = 'Click Me'): RawElementDescriptor => ({
    path: [{ kind: 'dom', index: 0, tag, id }],
    fingerprint: { tag, role: tag, id },
    rect: { x: 10, y: 20, width: 100, height: 40, centerX: 60, centerY: 40 },
    label,
    role: tag,
    id,
  });

  it('generates target keys correctly with desktop default', () => {
    assert.equal(makeTargetKey('tab-1', 'desktop'), 'tab-1:desktop');
    assert.equal(makeTargetKey('tab-1', undefined), 'tab-1:desktop');
    assert.equal(makeTargetKey('tab-1', 'mobile'), 'tab-1:mobile');
  });

  it('allocates monotonic refs across snapshots and targets without collision', () => {
    const registry = new SemanticRefRegistry();
    assert.equal(registry.getStats().highWaterRefIndex, 0);

    // Collection on Tab 1 Desktop
    const target1 = {
      tabId: 'tab-1',
      paneId: 'desktop',
      browserEpoch: 1,
      documentGeneration: 1,
      documentUrl: 'https://example.com/page1',
    };
    const c1 = registry.beginCollection(target1);
    const snap1 = registry.publishSnapshot({
      ...target1,
      sequence: c1.sequence,
      nonce: c1.nonce,
      rawDescriptors: [sampleDescriptor('btn-1'), sampleDescriptor('btn-2')],
    });

    assert.equal(snap1.count, 2);
    assert.deepEqual(snap1.refs, ['@e1', '@e2']);
    assert.equal(registry.getStats().highWaterRefIndex, 2);

    // Collection on Tab 1 Mobile
    const targetMobile = {
      tabId: 'tab-1',
      paneId: 'mobile',
      browserEpoch: 1,
      documentGeneration: 1,
      documentUrl: 'https://example.com/page1-mobile',
    };
    const cMobile = registry.beginCollection(targetMobile);
    const snapMobile = registry.publishSnapshot({
      ...targetMobile,
      sequence: cMobile.sequence,
      nonce: cMobile.nonce,
      rawDescriptors: [sampleDescriptor('btn-mobile-1')],
    });

    assert.equal(snapMobile.count, 1);
    assert.deepEqual(snapMobile.refs, ['@e3']);
    assert.equal(registry.getStats().highWaterRefIndex, 3);

    // Resolve ref on Desktop
    const resolvedDesktop = registry.resolveRef(target1, '@e1');
    assert.equal(resolvedDesktop.ref, '@e1');
    assert.equal(resolvedDesktop.id, 'btn-1');

    // Resolve ref on Mobile
    const resolvedMobile = registry.resolveRef(targetMobile, '@e3');
    assert.equal(resolvedMobile.ref, '@e3');
    assert.equal(resolvedMobile.id, 'btn-mobile-1');
  });

  it('rejects stale or mismatched nonces and sequences during publication', () => {
    const registry = new SemanticRefRegistry();
    const target = {
      tabId: 'tab-1',
      paneId: 'desktop',
      browserEpoch: 1,
      documentGeneration: 1,
      documentUrl: 'https://example.com',
    };

    const c1 = registry.beginCollection(target);

    // Stale nonce
    assert.throws(
      () =>
        registry.publishSnapshot({
          ...target,
          sequence: c1.sequence,
          nonce: '00000000-0000-0000-0000-000000000099',
          rawDescriptors: [sampleDescriptor('btn-1')],
        }),
      (err: unknown) => err instanceof CapabilityError && err.code === 'REF_STALE'
    );

    // Stale sequence after second beginCollection
    const c2 = registry.beginCollection(target);
    assert.throws(
      () =>
        registry.publishSnapshot({
          ...target,
          sequence: c1.sequence,
          nonce: c1.nonce,
          rawDescriptors: [sampleDescriptor('btn-1')],
        }),
      (err: unknown) => err instanceof CapabilityError && err.code === 'REF_STALE'
    );

    // Valid second collection succeeds
    const snap = registry.publishSnapshot({
      ...target,
      sequence: c2.sequence,
      nonce: c2.nonce,
      rawDescriptors: [sampleDescriptor('btn-fresh')],
    });
    assert.equal(snap.count, 1);
  });

  it('rejects publication when epoch, generation, or URL differs from pending collection metadata', () => {
    const registry = new SemanticRefRegistry();
    const target = {
      tabId: 'tab-meta',
      paneId: 'desktop',
      browserEpoch: 1,
      documentGeneration: 2,
      documentUrl: 'https://example.com/checkout',
    };

    const c = registry.beginCollection(target);

    // Mismatched epoch at publish time
    assert.throws(
      () =>
        registry.publishSnapshot({
          ...target,
          browserEpoch: 2,
          sequence: c.sequence,
          nonce: c.nonce,
          rawDescriptors: [sampleDescriptor('btn-1')],
        }),
      (err: unknown) => err instanceof CapabilityError && err.code === 'REF_STALE'
    );

    // Mismatched generation at publish time
    assert.throws(
      () =>
        registry.publishSnapshot({
          ...target,
          documentGeneration: 3,
          sequence: c.sequence,
          nonce: c.nonce,
          rawDescriptors: [sampleDescriptor('btn-1')],
        }),
      (err: unknown) => err instanceof CapabilityError && err.code === 'REF_STALE'
    );

    // Mismatched URL at publish time
    assert.throws(
      () =>
        registry.publishSnapshot({
          ...target,
          documentUrl: 'https://example.com/thank-you',
          sequence: c.sequence,
          nonce: c.nonce,
          rawDescriptors: [sampleDescriptor('btn-1')],
        }),
      (err: unknown) => err instanceof CapabilityError && err.code === 'REF_STALE'
    );
  });

  it('guarantees atomic allocation: a malformed later descriptor burns zero refs', () => {
    const registry = new SemanticRefRegistry();
    const target = {
      tabId: 'tab-atomic',
      paneId: 'desktop',
      browserEpoch: 1,
      documentGeneration: 1,
      documentUrl: 'https://example.com',
    };

    assert.equal(registry.getStats().highWaterRefIndex, 0);

    const c1 = registry.beginCollection(target);
    const invalidDescriptors: any[] = [
      sampleDescriptor('btn-good-1'),
      { path: [], fingerprint: null, rect: null }, // Malformed!
    ];

    assert.throws(
      () =>
        registry.publishSnapshot({
          ...target,
          sequence: c1.sequence,
          nonce: c1.nonce,
          rawDescriptors: invalidDescriptors,
        }),
      (err: unknown) => err instanceof CapabilityError && err.code === 'INVALID_ARGUMENT'
    );

    // High-water mark must NOT have incremented!
    assert.equal(registry.getStats().highWaterRefIndex, 0);

    // Reusing the same pending collection c1 succeeds and receives @e1
    const snap = registry.publishSnapshot({
      ...target,
      sequence: c1.sequence,
      nonce: c1.nonce,
      rawDescriptors: [sampleDescriptor('btn-good-after')],
    });
    assert.deepEqual(snap.refs, ['@e1']);
    assert.equal(registry.getStats().highWaterRefIndex, 1);
  });

  it('enforces target identity, epoch, generation, and URL matching in resolveRef', () => {
    const registry = new SemanticRefRegistry();
    const target = {
      tabId: 'tab-1',
      paneId: 'desktop',
      browserEpoch: 1,
      documentGeneration: 2,
      documentUrl: 'https://example.com/active',
    };

    const c = registry.beginCollection(target);
    registry.publishSnapshot({
      ...target,
      sequence: c.sequence,
      nonce: c.nonce,
      rawDescriptors: [sampleDescriptor('btn-active')],
    });

    // Epoch mismatch -> TARGET_STALE
    assert.throws(
      () => registry.resolveRef({ ...target, browserEpoch: 2 }, '@e1'),
      (err: unknown) => err instanceof CapabilityError && err.code === 'TARGET_STALE'
    );

    // Generation mismatch -> REF_STALE
    assert.throws(
      () => registry.resolveRef({ ...target, documentGeneration: 3 }, '@e1'),
      (err: unknown) => err instanceof CapabilityError && err.code === 'REF_STALE'
    );

    // URL mismatch -> REF_STALE
    assert.throws(
      () => registry.resolveRef({ ...target, documentUrl: 'https://example.com/other' }, '@e1'),
      (err: unknown) => err instanceof CapabilityError && err.code === 'REF_STALE'
    );

    // Expired historical ref -> REF_STALE
    // Invalidate target
    registry.invalidateTarget('tab-1', 'desktop');
    assert.throws(
      () => registry.resolveRef(target, '@e1'),
      (err: unknown) => err instanceof CapabilityError && err.code === 'REF_STALE'
    );

    // Never allocated future ref -> REF_NOT_FOUND
    assert.throws(
      () => registry.resolveRef(target, '@e9999'),
      (err: unknown) => err instanceof CapabilityError && err.code === 'REF_NOT_FOUND'
    );
  });

  it('prunes expired records and collections according to maxRecordAgeMs and clock', () => {
    let now = 1000;
    const registry = new SemanticRefRegistry({
      maxRecordAgeMs: 5000,
      clock: () => now,
    });

    const target = {
      tabId: 'tab-age',
      paneId: 'desktop',
      browserEpoch: 1,
      documentGeneration: 1,
      documentUrl: 'https://example.com',
    };

    const c = registry.beginCollection(target);
    registry.publishSnapshot({
      ...target,
      sequence: c.sequence,
      nonce: c.nonce,
      rawDescriptors: [sampleDescriptor('btn-1')],
    });

    assert.equal(registry.getStats().activeTargets, 1);

    // Advance time by 6 seconds (exceeding 5s TTL)
    now += 6000;

    // Resolving expired ref throws REF_STALE
    assert.throws(
      () => registry.resolveRef(target, '@e1'),
      (err: unknown) => err instanceof CapabilityError && err.code === 'REF_STALE'
    );
    assert.equal(registry.getStats().activeTargets, 0);
  });

  it('enforces total process descriptors limits', () => {
    const registry = new SemanticRefRegistry({
      maxTotalProcessDescriptors: 3,
    });

    const target1 = { tabId: 't1', paneId: 'desktop', browserEpoch: 1, documentGeneration: 1, documentUrl: 'https://example.com' };
    const target2 = { tabId: 't2', paneId: 'desktop', browserEpoch: 1, documentGeneration: 1, documentUrl: 'https://example.com' };

    const c1 = registry.beginCollection(target1);
    registry.publishSnapshot({ ...target1, sequence: c1.sequence, nonce: c1.nonce, rawDescriptors: [sampleDescriptor('b1'), sampleDescriptor('b2')] });

    const c2 = registry.beginCollection(target2);
    // Adding 2 more exceeds limit of 3!
    assert.throws(
      () =>
        registry.publishSnapshot({
          ...target2,
          sequence: c2.sequence,
          nonce: c2.nonce,
          rawDescriptors: [sampleDescriptor('b3'), sampleDescriptor('b4')],
        }),
      (err: unknown) => err instanceof CapabilityError && err.code === 'ARTIFACT_TOO_LARGE'
    );
  });

  it('invalidates tabs across all panes cleanly', () => {
    const registry = new SemanticRefRegistry();
    const targetDesktop = {
      tabId: 'tab-x',
      paneId: 'desktop',
      browserEpoch: 1,
      documentGeneration: 1,
      documentUrl: 'https://example.com',
    };
    const targetMobile = {
      tabId: 'tab-x',
      paneId: 'mobile',
      browserEpoch: 1,
      documentGeneration: 1,
      documentUrl: 'https://example.com',
    };

    const cD = registry.beginCollection(targetDesktop);
    registry.publishSnapshot({ ...targetDesktop, sequence: cD.sequence, nonce: cD.nonce, rawDescriptors: [sampleDescriptor('btn-d')] });

    const cM = registry.beginCollection(targetMobile);
    registry.publishSnapshot({ ...targetMobile, sequence: cM.sequence, nonce: cM.nonce, rawDescriptors: [sampleDescriptor('btn-m')] });

    assert.equal(registry.getStats().activeTargets, 2);

    registry.invalidateTab('tab-x');
    assert.equal(registry.getStats().activeTargets, 0);
  });

  it('handles destroy and marks registry disposed', () => {
    const registry = new SemanticRefRegistry();
    const target = {
      tabId: 'tab-1',
      paneId: 'desktop',
      browserEpoch: 1,
      documentGeneration: 1,
      documentUrl: 'https://example.com',
    };

    registry.destroy();
    assert.equal(registry.getStats().isDisposed, true);

    assert.throws(
      () => registry.beginCollection(target),
      (err: unknown) => err instanceof CapabilityError && err.code === 'RUNTIME_DRAINING'
    );
  });

  it('buildIsolatedCollectorScript produces valid JavaScript syntax with and without rootSelector', () => {
    const defaultScript = buildIsolatedCollectorScript('test-nonce-1', 'https://example.com');
    assert.doesNotThrow(() => {
      new vm.Script(defaultScript);
    });

    const scopedScript = buildIsolatedCollectorScript('test-nonce-2', 'https://example.com', '#cart-drawer');
    assert.doesNotThrow(() => {
      new vm.Script(scopedScript);
    });
  });

  it('buildIsolatedExecutorScript produces valid JavaScript syntax for actions', () => {
    const clickScript = buildIsolatedExecutorScript({
      action: 'click',
      ref: '@e1',
      nonce: 'nonce-1',
      documentUrl: 'https://example.com',
    });
    assert.doesNotThrow(() => {
      new vm.Script(clickScript);
    });
  });
});
