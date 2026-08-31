import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import {
  isSemanticRef,
  parseSemanticRefIndex,
  sanitizeLabel,
  formatSemanticSnapshot,
  validateRawDescriptor,
  validateCollectionEnvelope,
  validateActionRequest,
  validateActionResponse,
  validateUuid,
  validateTargetVersions,
  ISOLATED_AGENT_WORLD_ID,
  MAX_SNAPSHOT_DESCRIPTORS,
  MAX_TOTAL_SERIALIZED_BYTES,
  SemanticElementDescriptor,
  RawElementDescriptor,
  TraversalStepKind,
} from '../../src/main/browser/semantic-ref-types';
import { CapabilityError } from '../../src/shared/control-plane-contracts';
import { AGENT_BROWSER_SCRIPT } from '../../src/main/browser/agent-browser';

describe('Semantic Ref Contract Characterization', () => {
  it('identifies valid semantic ref tokens and rejects invalid or padded formats', () => {
    assert.equal(isSemanticRef('@e1'), true);
    assert.equal(isSemanticRef('@e42'), true);
    assert.equal(isSemanticRef('@e99999'), true);

    // Exact regex rejects whitespace/padding
    assert.equal(isSemanticRef(' @e1'), false);
    assert.equal(isSemanticRef('@e1 '), false);
    assert.equal(isSemanticRef('@e0'), false);
    assert.equal(isSemanticRef('@e-1'), false);
    assert.equal(isSemanticRef('@e'), false);
    assert.equal(isSemanticRef('e1'), false);
    assert.equal(isSemanticRef('@e1abc'), false);
    assert.equal(isSemanticRef(''), false);
    assert.equal(isSemanticRef(null), false);
    assert.equal(isSemanticRef(123), false);
  });

  it('parses valid semantic ref index and throws INVALID_ARGUMENT for malformed tokens', () => {
    assert.equal(parseSemanticRefIndex('@e1'), 1);
    assert.equal(parseSemanticRefIndex('@e250'), 250);

    assert.throws(
      () => parseSemanticRefIndex('@e0'),
      (err: unknown) => err instanceof CapabilityError && err.code === 'INVALID_ARGUMENT'
    );
    assert.throws(
      () => parseSemanticRefIndex(' @e1 '),
      (err: unknown) => err instanceof CapabilityError && err.code === 'INVALID_ARGUMENT'
    );
    assert.throws(
      () => parseSemanticRefIndex('invalid'),
      (err: unknown) => err instanceof CapabilityError && err.code === 'INVALID_ARGUMENT'
    );
  });

  it('sanitizes labels and escapes quotes and control chars in snapshot output', () => {
    assert.equal(sanitizeLabel('  Hello \r\n\t World  '), 'Hello World');
    assert.equal(sanitizeLabel(undefined), '');
    assert.equal(sanitizeLabel(null), '');

    const descriptors: SemanticElementDescriptor[] = [
      {
        ref: '@e1',
        refIndex: 1,
        documentUrl: 'https://example.com/store',
        nonce: '00000000-0000-0000-0000-000000000001',
        sequence: 1,
        path: [{ kind: 'dom', index: 0, tag: 'button' }],
        fingerprint: { tag: 'button', role: 'button', id: 'add-cart' },
        rect: { x: 10, y: 20, width: 100, height: 40, centerX: 60, centerY: 40 },
        label: 'Add "Special" Item\nNow',
        role: 'button',
        id: 'btn"quote',
        metadata: {
          sectionId: 'sec\r\nhero',
          productId: 'prod"99',
          blockId: 'blk\\cta',
          framePath: 'chat"frame',
        },
      },
    ];

    const formatted = formatSemanticSnapshot(descriptors);
    assert.ok(!formatted.includes('\nNow'));
    assert.ok(formatted.includes('\\"Special\\"'));
    assert.ok(formatted.includes('id: "btn\\"quote"'));
    assert.ok(formatted.includes('product: "prod\\"99"'));
  });

  it('formats metadata in strict canonical order: id, section, product, block, frame', () => {
    const descriptors: SemanticElementDescriptor[] = [
      {
        ref: '@e1',
        refIndex: 1,
        documentUrl: 'https://example.com',
        nonce: '00000000-0000-0000-0000-000000000001',
        sequence: 1,
        path: [{ kind: 'dom', index: 0, tag: 'button' }],
        fingerprint: { tag: 'button' },
        rect: { x: 0, y: 0, width: 10, height: 10, centerX: 5, centerY: 5 },
        label: 'Buy',
        role: 'button',
        id: 'btn-1',
        metadata: {
          framePath: 'frame-1',
          blockId: 'block-1',
          productId: 'prod-1',
          sectionId: 'sec-1',
        },
      },
      {
        ref: '@e2',
        refIndex: 2,
        documentUrl: 'https://example.com',
        nonce: '00000000-0000-0000-0000-000000000001',
        sequence: 1,
        path: [{ kind: 'dom', index: 1, tag: 'a' }],
        fingerprint: { tag: 'a' },
        rect: { x: 0, y: 0, width: 10, height: 10, centerX: 5, centerY: 5 },
        label: '',
        role: 'link',
      },
    ];

    const formatted = formatSemanticSnapshot(descriptors);
    const lines = formatted.split('\n');
    assert.equal(
      lines[0],
      '@e1 [button] "Buy" (id: "btn-1", section: "sec-1", product: "prod-1", block: "block-1", frame: "frame-1")'
    );
    assert.equal(lines[1], '@e2 [link]');
  });

  it('validates raw descriptors strictly and rejects non-finite geometry and invalid path steps', () => {
    const validRaw: RawElementDescriptor = {
      path: [{ kind: 'dom', index: 0, tag: 'a' }],
      fingerprint: { tag: 'a', role: 'link' },
      rect: { x: 0, y: 0, width: 50, height: 20, centerX: 25, centerY: 10 },
      label: 'Home',
      role: 'link',
    };

    const validated = validateRawDescriptor(validRaw, 0);
    assert.equal(validated.role, 'link');
    assert.equal(validated.label, 'Home');

    // Non-finite geometry
    assert.throws(
      () => validateRawDescriptor({ ...validRaw, rect: { x: NaN, y: 0, width: 50, height: 20 } }, 0),
      (err: unknown) => err instanceof CapabilityError && err.code === 'INVALID_ARGUMENT'
    );
    assert.throws(
      () => validateRawDescriptor({ ...validRaw, rect: { x: 0, y: 0, width: -10, height: 20 } }, 0),
      (err: unknown) => err instanceof CapabilityError && err.code === 'INVALID_ARGUMENT'
    );
    assert.throws(
      () => validateRawDescriptor({ ...validRaw, rect: { x: 0, y: Infinity, width: 10, height: 20 } }, 0),
      (err: unknown) => err instanceof CapabilityError && err.code === 'INVALID_ARGUMENT'
    );

    // Invalid path steps
    const invalidKind = 'unknown' as unknown as TraversalStepKind;
    assert.throws(
      () => validateRawDescriptor({ ...validRaw, path: [{ kind: invalidKind, index: 0 }] }, 0),
      (err: unknown) => err instanceof CapabilityError && err.code === 'INVALID_ARGUMENT'
    );
    assert.throws(
      () => validateRawDescriptor({ ...validRaw, path: [{ kind: 'dom', index: -1 }] }, 0),
      (err: unknown) => err instanceof CapabilityError && err.code === 'INVALID_ARGUMENT'
    );
  });

  it('validates isolated collection envelopes, enforces exact URL matching, and rejects oversized payloads', () => {
    const rawList: RawElementDescriptor[] = [
      {
        path: [{ kind: 'dom', index: 0, tag: 'button' }],
        fingerprint: { tag: 'button' },
        rect: { x: 10, y: 10, width: 100, height: 30, centerX: 60, centerY: 25 },
        label: 'Submit',
        role: 'button',
      },
    ];

    const validEnvelope = {
      ok: true,
      nonce: '00000000-0000-0000-0000-000000000001',
      documentUrl: 'https://example.com/app',
      descriptors: rawList,
    };

    const result = validateCollectionEnvelope(validEnvelope, '00000000-0000-0000-0000-000000000001', 'https://example.com/app');
    assert.equal(result.length, 1);
    assert.ok(result[0]);
    assert.equal(result[0].label, 'Submit');

    // Document URL mismatch must fail with REF_STALE
    assert.throws(
      () => validateCollectionEnvelope(validEnvelope, '00000000-0000-0000-0000-000000000001', 'https://example.com/other-page'),
      (err: unknown) => err instanceof CapabilityError && err.code === 'REF_STALE'
    );

    // Nonce mismatch must fail with REF_STALE
    assert.throws(
      () => validateCollectionEnvelope(validEnvelope, '00000000-0000-0000-0000-000000000002', 'https://example.com/app'),
      (err: unknown) => err instanceof CapabilityError && err.code === 'REF_STALE'
    );

    // Oversized descriptors list must fail with ARTIFACT_TOO_LARGE
    const oversizedList = Array.from({ length: MAX_SNAPSHOT_DESCRIPTORS + 1 }, () => rawList[0]);
    assert.throws(
      () =>
        validateCollectionEnvelope(
          { ...validEnvelope, descriptors: oversizedList },
          '00000000-0000-0000-0000-000000000001',
          'https://example.com/app'
        ),
      (err: unknown) => err instanceof CapabilityError && err.code === 'ARTIFACT_TOO_LARGE'
    );
    // Payload exceeding MAX_TOTAL_SERIALIZED_BYTES (128 KB) must fail with ARTIFACT_TOO_LARGE
    const hugeDescriptor: RawElementDescriptor = {
      path: [{ kind: 'dom', index: 0, tag: 'button' }],
      fingerprint: { tag: 'button' },
      rect: { x: 10, y: 10, width: 100, height: 30, centerX: 60, centerY: 25 },
      label: 'x'.repeat(50),
      role: 'button',
      metadata: {
        sectionId: 's'.repeat(1000),
        productId: 'p'.repeat(1000),
        blockId: 'b'.repeat(1000),
        framePath: 'f'.repeat(1000),
      },
    };
    const giantList = Array.from({ length: 40 }, () => hugeDescriptor);
    assert.ok(Buffer.byteLength(JSON.stringify(giantList), 'utf8') > MAX_TOTAL_SERIALIZED_BYTES);
    assert.throws(
      () =>
        validateCollectionEnvelope(
          { ...validEnvelope, descriptors: giantList },
          '00000000-0000-0000-0000-000000000001',
          'https://example.com/app'
        ),
      (err: unknown) => err instanceof CapabilityError && err.code === 'ARTIFACT_TOO_LARGE'
    );

    // Malformed nonces (even if identical) must throw INVALID_ARGUMENT
    assert.throws(
      () => validateCollectionEnvelope({ ...validEnvelope, nonce: 'bad-nonce' }, 'bad-nonce', 'https://example.com/app'),
      (err: unknown) => err instanceof CapabilityError && err.code === 'INVALID_ARGUMENT'
    );
  });

  it('validates UUIDs and target versions strictly', () => {
    assert.equal(validateUuid('a1b2c3d4-e5f6-7a8b-9c0d-1e2f3a4b5c6d'), 'a1b2c3d4-e5f6-7a8b-9c0d-1e2f3a4b5c6d');
    assert.throws(() => validateUuid('not-a-uuid'), (err: unknown) => err instanceof CapabilityError && err.code === 'INVALID_ARGUMENT');
    assert.throws(() => validateUuid(''), (err: unknown) => err instanceof CapabilityError && err.code === 'INVALID_ARGUMENT');

    // Version validation
    validateTargetVersions({ browserEpoch: 1, documentGeneration: 0, sequence: 1 });
    assert.throws(() => validateTargetVersions({ browserEpoch: 0 }), (err: unknown) => err instanceof CapabilityError && err.code === 'INVALID_ARGUMENT');
    assert.throws(() => validateTargetVersions({ documentGeneration: -1 }), (err: unknown) => err instanceof CapabilityError && err.code === 'INVALID_ARGUMENT');
    assert.throws(() => validateTargetVersions({ sequence: 0 }), (err: unknown) => err instanceof CapabilityError && err.code === 'INVALID_ARGUMENT');
  });

  it('hardens RendererActionRequest validation with UUID nonce, payload constraints, and target checks', () => {
    const validReq = {
      action: 'click',
      ref: '@e1',
      nonce: 'a1b2c3d4-e5f6-7a8b-9c0d-1e2f3a4b5c6d',
      documentUrl: 'https://example.com',
      x: 100,
      y: 200,
    };
    const validated = validateActionRequest(validReq);
    assert.equal(validated.action, 'click');
    assert.equal(validated.ref, '@e1');

    // Non-UUID nonce must throw INVALID_ARGUMENT
    assert.throws(
      () => validateActionRequest({ ...validReq, nonce: 'not-a-uuid' }),
      (err: unknown) => err instanceof CapabilityError && err.code === 'INVALID_ARGUMENT'
    );

    // Type action without string text must throw INVALID_ARGUMENT
    assert.throws(
      () => validateActionRequest({ ...validReq, action: 'type', text: undefined }),
      (err: unknown) => err instanceof CapabilityError && err.code === 'INVALID_ARGUMENT'
    );

    // Missing target for click must throw INVALID_ARGUMENT
    assert.throws(
      () => validateActionRequest({ action: 'click', nonce: validReq.nonce, documentUrl: validReq.documentUrl }),
      (err: unknown) => err instanceof CapabilityError && err.code === 'INVALID_ARGUMENT'
    );
  });

  it('hardens RendererActionResponse without boolean coercion and with strict rect verification', () => {
    // Valid executed response
    const validRes = { ok: true, executed: true, rect: { x: 0, y: 0, width: 10, height: 10 } };
    const validatedRes = validateActionResponse(validRes);
    assert.equal(validatedRes.ok, true);

    // Coercion rejection: string 'true' for executed must throw INVALID_ARGUMENT
    assert.throws(
      () => validateActionResponse({ ok: true, executed: 'true' as unknown as boolean }),
      (err: unknown) => err instanceof CapabilityError && err.code === 'INVALID_ARGUMENT'
    );

    // Non-boolean ok field must throw INVALID_ARGUMENT
    assert.throws(
      () => validateActionResponse({ ok: 'success' as unknown as boolean }),
      (err: unknown) => err instanceof CapabilityError && err.code === 'INVALID_ARGUMENT'
    );

    // Malformed rect must throw INVALID_ARGUMENT
    assert.throws(
      () => validateActionResponse({ ok: true, executed: true, rect: { x: NaN, y: 0, width: 10, height: 10 } }),
      (err: unknown) => err instanceof CapabilityError && err.code === 'INVALID_ARGUMENT'
    );

    // Valid error response
    const errRes = validateActionResponse({ ok: false, error: 'Target detached', code: 'NODE_DETACHED' });
    assert.equal(errRes.ok, false);
    if (!errRes.ok) {
      assert.equal(errRes.error, 'Target detached');
      assert.equal(errRes.code, 'NODE_DETACHED');
    }
  });

  it('characterizes legacy renderer script defects: contains DOM mutation and window ref map', () => {
    // Proves legacy script mutates customer DOM with data-antifan-ref and sets window.__antifanRefMap
    assert.ok(AGENT_BROWSER_SCRIPT.includes('data-antifan-ref'));
    assert.ok(AGENT_BROWSER_SCRIPT.includes('__antifanRefMap'));
    assert.ok(AGENT_BROWSER_SCRIPT.includes('window.__antifanAgent'));
  });

  it('verifies ISOLATED_AGENT_WORLD_ID is exactly 1004 and within safe non-extension range', () => {
    assert.equal(ISOLATED_AGENT_WORLD_ID, 1004);
    assert.ok(ISOLATED_AGENT_WORLD_ID >= 1000);
    assert.ok(ISOLATED_AGENT_WORLD_ID < 1 << 20);
    assert.notEqual(ISOLATED_AGENT_WORLD_ID, 0); // Main world
    assert.notEqual(ISOLATED_AGENT_WORLD_ID, 999); // Preload world
  });
});
