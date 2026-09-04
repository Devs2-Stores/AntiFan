import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import {
  computeSparseInteractionDelta,
  hasAnyObservableChange,
} from '../../src/main/verification/interaction-delta.js';
import {
  attributeMutations,
  RawMutationInput,
} from '../../src/main/verification/mutation-attribution.js';
import {
  ActionBoundary,
  RawBehaviorScope,
} from '../../src/main/verification/interaction-contract.js';
import { BrowserControlPort } from '../../src/main/tools/browser-control-port.js';
describe('Verification Core - Sparse Interaction Delta & Mutation Attribution', () => {
  const dummyBaseline: RawBehaviorScope = {
    url: 'https://storefront.dev/products/item-1',
    title: 'Product Details',
    bodyClasses: ['theme-default'],
    bodyOverflowLocked: false,
    bodyOverflowY: 'auto',
    bodyOverflowX: 'hidden',
    hasHorizontalOverflow: false,
    scrollWidth: 1200,
    viewportWidth: 1200,
    target: {
      found: true,
      tagName: 'button',
      classes: ['btn', 'btn-primary'],
      rect: { x: 100, y: 200, width: 140, height: 44 },
      ariaExpanded: 'false',
      ariaHidden: null,
      ariaSelected: null,
      ariaModal: null,
      display: 'inline-block',
      visibility: 'visible',
      opacity: '1',
      transform: 'none',
    },
    activeOverlays: [
      {
        tagName: 'div',
        id: 'header-menu',
        className: 'menu-dropdown',
        rect: { width: 300, height: 200 },
        role: 'menu',
      },
    ],
  };

  it('1. Returns all fields as unchanged when before and after scopes are identical', () => {
    const delta = computeSparseInteractionDelta(dummyBaseline, { ...dummyBaseline });

    assert.strictEqual(delta.target.classes?.status, 'unchanged');
    assert.strictEqual(delta.target.rect?.status, 'unchanged');
    assert.strictEqual(delta.target.style?.status, 'unchanged');
    assert.strictEqual(delta.target.aria?.status, 'unchanged');

    assert.strictEqual(delta.document.url?.status, 'unchanged');
    assert.strictEqual(delta.document.bodyClasses?.status, 'unchanged');
    assert.strictEqual(delta.document.bodyOverflowLocked?.status, 'unchanged');
    assert.strictEqual(delta.document.hasHorizontalOverflow?.status, 'unchanged');

    assert.strictEqual(delta.overlayCandidateDelta.added.length, 0);
    assert.strictEqual(delta.overlayCandidateDelta.removed.length, 0);
    assert.strictEqual(delta.overlayCandidateDelta.retained.length, 1);
    assert.strictEqual(delta.overlayCandidateDelta.retained[0]?.rectChanged, false);

    assert.strictEqual(hasAnyObservableChange(delta), false);
  });

  it('2. Accurately detects target transitions across classes, rect, style, and aria', () => {
    const afterScope: RawBehaviorScope = {
      ...dummyBaseline,
      target: {
        ...dummyBaseline.target!,
        classes: ['btn', 'btn-primary', 'is-active'],
        rect: { x: 100, y: 200, width: 160, height: 48 },
        ariaExpanded: 'true',
        opacity: '0.8',
        transform: 'scale(1.05)',
      },
    };

    const delta = computeSparseInteractionDelta(dummyBaseline, afterScope);

    assert.strictEqual(delta.target.classes?.status, 'changed');
    if (delta.target.classes?.status === 'changed') {
      assert.deepStrictEqual(delta.target.classes.after, ['btn', 'btn-primary', 'is-active']);
    }

    assert.strictEqual(delta.target.rect?.status, 'changed');
    if (delta.target.rect?.status === 'changed') {
      assert.strictEqual(delta.target.rect.after.width, 160);
      assert.deepStrictEqual(delta.target.rect.delta, { dx: 0, dy: 0, dw: 20, dh: 4 });
    }

    assert.strictEqual(delta.target.aria?.status, 'changed');
    if (delta.target.aria?.status === 'changed') {
      assert.strictEqual(delta.target.aria.after.ariaExpanded, 'true');
    }

    assert.strictEqual(delta.target.style?.status, 'changed');
    if (delta.target.style?.status === 'changed') {
      assert.strictEqual(delta.target.style.after.opacity, '0.8');
      assert.strictEqual(delta.target.style.after.transform, 'scale(1.05)');
    }

    assert.strictEqual(hasAnyObservableChange(delta), true);
  });

  it('3. Classifies overlay candidate lifecycle: added, removed, and retained with geometry change', () => {
    const afterScope: RawBehaviorScope = {
      ...dummyBaseline,
      activeOverlays: [
        {
          tagName: 'div',
          id: 'header-menu',
          className: 'menu-dropdown',
          rect: { width: 350, height: 280 }, // Geometry changed
          role: 'menu',
        },
        {
          tagName: 'div',
          id: 'cart-drawer',
          className: 'drawer drawer-open',
          rect: { width: 400, height: 800 },
          role: 'dialog',
        },
      ],
    };

    const delta = computeSparseInteractionDelta(dummyBaseline, afterScope);

    assert.strictEqual(delta.overlayCandidateDelta.added.length, 1);
    assert.strictEqual(delta.overlayCandidateDelta.added[0]?.id, 'cart-drawer');

    assert.strictEqual(delta.overlayCandidateDelta.removed.length, 0);

    assert.strictEqual(delta.overlayCandidateDelta.retained.length, 1);
    assert.strictEqual(delta.overlayCandidateDelta.retained[0]?.before.id, 'header-menu');
    assert.strictEqual(delta.overlayCandidateDelta.retained[0]?.rectChanged, true);

    assert.strictEqual(hasAnyObservableChange(delta), true);
  });

  it('4. Handles missing or unresolvable target cleanly as unavailable', () => {
    const delta = computeSparseInteractionDelta(
      { ...dummyBaseline, target: undefined },
      { ...dummyBaseline, target: undefined }
    );

    assert.strictEqual(delta.target.classes?.status, 'unavailable');
    assert.strictEqual(delta.target.rect?.status, 'unavailable');
    assert.strictEqual(delta.target.style?.status, 'unavailable');
    assert.strictEqual(delta.target.aria?.status, 'unavailable');
  });

  it('5. Detects document-level transitions: url, body classes, overflow lock, horizontal overflow', () => {
    const afterScope: RawBehaviorScope = {
      ...dummyBaseline,
      url: 'https://storefront.dev/cart',
      bodyClasses: ['theme-default', 'drawer-open'],
      bodyOverflowLocked: true,
      hasHorizontalOverflow: true,
    };

    const delta = computeSparseInteractionDelta(dummyBaseline, afterScope);

    assert.strictEqual(delta.document.url?.status, 'changed');
    if (delta.document.url?.status === 'changed') {
      assert.strictEqual(delta.document.url.after, 'https://storefront.dev/cart');
    }

    assert.strictEqual(delta.document.bodyClasses?.status, 'changed');
    assert.strictEqual(delta.document.bodyOverflowLocked?.status, 'changed');
    assert.strictEqual(delta.document.hasHorizontalOverflow?.status, 'changed');

    assert.strictEqual(hasAnyObservableChange(delta), true);
  });

  it('6. Enforces temporal deadline invariant: drops mutations beyond attributionWindowMs', () => {
    const boundary: ActionBoundary = {
      armedAt: 990,
      actionStartedAt: 1000,
      settleStartedAt: 1050,
      settledAt: 1500,
      attributionWindowMs: 400, // Enforced window: 400ms max relative offset
      attributionDeadline: 1400,
    };

    const rawMutations: RawMutationInput[] = [
      { t: 25, type: 'attributes', targetId: 'btn-add-cart', attributeName: 'class' },
      { t: 150, type: 'childList', targetClass: 'cart-drawer-body', addedCount: 1 },
      { t: 380, type: 'attributes', targetClass: 'cart-count-badge', attributeName: 'data-count' },
      { t: 650, type: 'childList', targetClass: 'carousel-track', addedCount: 1 }, // Beyond 400ms deadline!
    ];

    const batch = attributeMutations(rawMutations, boundary, { id: 'btn-add-cart' });

    assert.strictEqual(batch.records.length, 3);
    assert.strictEqual(batch.outOfBoundsCount, 1);
    assert.strictEqual(batch.integrity.status, 'COMPLETE');
    assert.strictEqual(batch.integrity.reason, 'CLEAN_OBSERVATION');
  });

  it('7. Classifies Scope heuristically while keeping Causality UNKNOWN (Zero Hallucination)', () => {
    const boundary: ActionBoundary = {
      armedAt: 495,
      actionStartedAt: 500,
      settledAt: 900,
      attributionWindowMs: 1000,
      attributionDeadline: 1500,
    };

    const rawMutations: RawMutationInput[] = [
      // 1. Target match
      { t: 15, type: 'attributes', targetId: 'submit-btn', attributeName: 'disabled' },
      // 2. Candidate disclosure overlay match
      { t: 120, type: 'childList', targetClass: 'modal-body', addedCount: 2 },
      // 3. Uncorrelated background mutation
      { t: 350, type: 'attributes', targetClass: 'hero-slider-indicator', attributeName: 'class' },
    ];

    const batch = attributeMutations(rawMutations, boundary, { id: 'submit-btn' });

    assert.strictEqual(batch.records.length, 3);

    // Record 1: TARGET scope, but Causality is UNKNOWN
    const r1 = batch.records[0]!;
    assert.strictEqual(r1.classification.causality, 'UNKNOWN');
    assert.strictEqual(r1.classification.scope, 'TARGET');
    assert.strictEqual(r1.classification.method, 'TEMPORAL');
    assert.strictEqual(r1.inference?.reasonCode, 'TARGET_MATCH');
    assert.strictEqual(r1.observation.targetId, 'submit-btn');
    assert.strictEqual(r1.observation.type, 'attributes');
    assert.strictEqual(r1.inference?.confidence, 0.9);

    // Record 2: RELATED scope, Causality is UNKNOWN
    const r2 = batch.records[1]!;
    assert.strictEqual(r2.classification.causality, 'UNKNOWN');
    assert.strictEqual(r2.classification.scope, 'RELATED');
    assert.strictEqual(r2.classification.method, 'HEURISTIC');
    assert.strictEqual(r2.inference?.reasonCode, 'RELATED_OVERLAY_APPEARED');
    assert.strictEqual(r2.inference?.confidence, 0.75);

    // Record 3: AMBIENT scope, Causality is UNKNOWN
    const r3 = batch.records[2]!;
    assert.strictEqual(r3.classification.causality, 'UNKNOWN');
    assert.strictEqual(r3.classification.scope, 'UNKNOWN');
    assert.strictEqual(r3.classification.method, 'TEMPORAL');
    assert.strictEqual(r3.inference?.reasonCode, 'WITHIN_ACTION_WINDOW');
    assert.strictEqual(r3.inference?.confidence, 0.5);
  });

  it('8. Flags buffer truncation in ObservationIntegrity with machine-readable reason', () => {
    const boundary: ActionBoundary = {
      armedAt: 90,
      actionStartedAt: 100,
      settledAt: 300,
      attributionWindowMs: 500,
      attributionDeadline: 600,
    };

    const rawMutations: RawMutationInput[] = Array.from({ length: 6 }, (_, i) => ({
      t: i * 10,
      type: 'attributes' as const,
      targetId: `elem-${i}`,
    }));

    const batch = attributeMutations(rawMutations, boundary, undefined, { bufferLimit: 5 });

    assert.strictEqual(batch.integrity.status, 'TRUNCATED');
    assert.strictEqual(batch.integrity.reason, 'BUFFER_LIMIT_EXCEEDED');
    assert.strictEqual(batch.integrity.bufferLimit, 5);
    assert.strictEqual(batch.integrity.totalObserved, 6);
  });

  it('9. Micro-test: handles synchronous mutation (t=0) and exact deadline inclusion/exclusion', () => {
    const boundary: ActionBoundary = {
      armedAt: 95,
      actionStartedAt: 100,
      settledAt: 400,
      attributionWindowMs: 300,
      attributionDeadline: 400,
    };

    const rawMutations: RawMutationInput[] = [
      { t: 0, type: 'attributes', targetId: 'sync-btn', attributeName: 'class' }, // Synchronous mutation at t=0
      { t: 300, type: 'childList', targetId: 'at-deadline', addedCount: 1 },      // Exactly at deadline (t=300) -> INCLUDED
      { t: 301, type: 'childList', targetId: 'past-deadline', addedCount: 1 },    // 1ms past deadline (t=301) -> EXCLUDED
    ];

    const batch = attributeMutations(rawMutations, boundary, { id: 'sync-btn' });

    assert.strictEqual(batch.records.length, 2);
    assert.strictEqual(batch.outOfBoundsCount, 1);
    assert.strictEqual(batch.records[0]?.observation.timestampOffsetMs, 0);
    assert.strictEqual(batch.records[1]?.observation.timestampOffsetMs, 300);
  });

  it('10. Enforces pre-action boundary: strictly rejects mutations occurring before action trigger (t < 0)', () => {
    const boundary: ActionBoundary = {
      armedAt: 900,
      actionStartedAt: 1000, // Action started at t=1000
      settledAt: 1400,
      attributionWindowMs: 400,
      attributionDeadline: 1400,
    };

    const rawMutations: RawMutationInput[] = [
      { t: -20, type: 'attributes', targetId: 'pre-action-noise' }, // Occurred before action trigger! -> EXCLUDED
      { t: 0, type: 'attributes', targetId: 'at-action-el', attributeName: 'class' }, // At action -> INCLUDED
      { t: 150, type: 'childList', targetId: 'post-action-el', addedCount: 1 },       // Post action -> INCLUDED
    ];

    const batch = attributeMutations(rawMutations, boundary, { id: 'at-action-el' });

    assert.strictEqual(batch.records.length, 2, 'Pre-action mutation must not be attributed');
    assert.strictEqual(batch.outOfBoundsCount, 1, 'Pre-action mutation must count as out-of-bounds');
    assert.strictEqual(batch.records[0]?.observation.targetId, 'at-action-el');
    assert.strictEqual(batch.records[0]?.observation.timestampOffsetMs, 0);
    assert.strictEqual(batch.records[1]?.observation.targetId, 'post-action-el');
    assert.strictEqual(batch.records[1]?.observation.timestampOffsetMs, 150);
  });

  it('11. Fails closed with ACTION_MARKER_FAILED and skips attribution when action marker fails', async () => {
    const mockHost = {
      getTabList: () => [{ id: 'tab-test' }],
      agentHover: async () => true,
      evalJs: async (script: string) => {
        if (script.includes('window.__antifanMarkAction ?')) {
          return null; // Simulate action marker failure!
        }
        if (script.includes('window.__stopAntifanMotion ?')) {
          return {
            samples: [],
            mutations: [{ tPage: 1010, type: 'attributes', targetId: 'btn' }],
            actionStartT: null, // Unconfirmed!
            markerConfirmed: false,
            armT: 1000,
            stopT: 1200,
            durationMs: 200,
          };
        }
        if (script.includes('__antifanMotionSamples')) {
          return { armed: true, mutationObserver: true, motionObserver: true };
        }
        return {};
      },
    };

    const port = new BrowserControlPort(mockHost as any);
    const target = {
      tabId: 'tab-test',
      projectId: 'p1',
      workspaceId: 'w1',
      runtimeId: 'r1',
      browserEpoch: 1,
      documentGeneration: 1,
    };

    const res = await port.traceInteraction(target as any, 'r1', 'a1', {
      action: 'hover',
      selector: 'button',
      settleMs: 20,
    });

    const evidence = res.evidence as any;
    assert.strictEqual(evidence.observationIntegrity.status, 'UNAVAILABLE');
    assert.strictEqual(evidence.observationIntegrity.reason, 'ACTION_MARKER_FAILED');
    assert.strictEqual(evidence.attribution, undefined, 'Must skip attribution when action marker is unconfirmed');
  });

  it('12. Accepts legitimate page timestamp 0 for action marker without false failure', async () => {
    const mockHost = {
      hasTab: () => true,
      getTabList: () => [{ id: 'tab-test' }],
      agentHover: async () => true,
      evalJs: async (script: string) => {
        if (script.includes('window.__antifanMarkAction ?')) {
          return 0; // Page clock exactly 0!
        }
        if (script.includes('window.__stopAntifanMotion ?')) {
          return {
            samples: [],
            mutations: [{ tPage: 25, type: 'attributes', targetId: 'btn' }],
            actionStartT: 0,
            markerConfirmed: true,
            armT: 0,
            stopT: 100,
            durationMs: 100,
          };
        }
        if (script.includes('__antifanMotionSamples')) {
          return { armed: true, mutationObserver: true, motionObserver: true };
        }
        return {};
      },
    };

    const port = new BrowserControlPort(mockHost as any);
    const target = {
      tabId: 'tab-test',
      projectId: 'p1',
      workspaceId: 'w1',
      runtimeId: 'r1',
      browserEpoch: 1,
      documentGeneration: 1,
    };

    const res = await port.traceInteraction(target as any, 'r1', 'a1', {
      action: 'hover',
      selector: 'button',
      settleMs: 20,
    });

    const evidence = res.evidence as any;
    assert.strictEqual(evidence.observationIntegrity.status, 'COMPLETE');
    assert.strictEqual(evidence.observationIntegrity.reason, 'CLEAN_OBSERVATION');
    assert.ok(evidence.attribution, 'Must perform attribution when action marker is 0');
    assert.strictEqual(evidence.attribution.records.length, 1);
  });
});
