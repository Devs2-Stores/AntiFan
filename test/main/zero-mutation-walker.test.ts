import { describe, it } from 'node:test';
import * as assert from 'node:assert';
import * as vm from 'node:vm';
import {
  buildIsolatedCollectorScript,
  buildIsolatedExecutorScript,
  ISOLATED_AGENT_WORLD_ID,
} from '../../src/main/browser/semantic-ref-executor';
import { validateCollectionEnvelope } from '../../src/main/browser/semantic-ref-types';

describe('Phase 4: Zero-Mutation Isolated World Walker & Executor (World 1004)', () => {
  it('1. Collector builds valid script targeting world 1004 and executes cleanly without DOM mutations', () => {
    assert.strictEqual(ISOLATED_AGENT_WORLD_ID, 1004);

    const nonce = 'a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d';
    const url = 'https://example.com/shop';
    const script = buildIsolatedCollectorScript(nonce, url);

    assert.ok(script.includes(nonce), 'Collector script must embed expected nonce');
    assert.ok(script.includes(url), 'Collector script must embed expected URL');
    assert.ok(!script.includes('data-antifan-ref'), 'Collector must never reference data-antifan-ref');
    assert.ok(!script.includes('__antifanRefMap'), 'Collector must never reference __antifanRefMap');
  });

  it('2. Traversal script evaluates in simulated DOM environment with zero attribute or global mutations', () => {
    const nonce = '12345678-1234-4234-8234-123456789abc';
    const url = 'https://example.com/checkout';

    // Create a mock DOM environment
    const mutatedAttributes: string[] = [];
    const createdElements: string[] = [];

    const mockButton = {
      tagName: 'BUTTON',
      id: 'checkout-btn',
      className: 'btn btn-primary',
      getAttribute: (name: string) => {
        if (name === 'role') return 'button';
        if (name === 'aria-label') return 'Complete Purchase';
        return null;
      },
      hasAttribute: (name: string) => name === 'role' || name === 'aria-label',
      setAttribute: (name: string) => { mutatedAttributes.push(name); },
      getBoundingClientRect: () => ({ x: 20, y: 50, width: 120, height: 40 }),
      children: [],
      innerText: 'Complete Purchase',
      textContent: 'Complete Purchase',
    };

    const mockInput = {
      tagName: 'INPUT',
      id: 'coupon-code',
      type: 'text',
      className: 'form-control',
      getAttribute: (name: string) => {
        if (name === 'type') return 'text';
        if (name === 'placeholder') return 'Promo code';
        return null;
      },
      hasAttribute: (name: string) => name === 'type' || name === 'placeholder',
      setAttribute: (name: string) => { mutatedAttributes.push(name); },
      getBoundingClientRect: () => ({ x: 20, y: 100, width: 200, height: 35 }),
      children: [],
      value: '',
    };

    const mockBody = {
      tagName: 'BODY',
      children: [mockButton, mockInput],
      getAttribute: () => null,
      hasAttribute: () => false,
      getBoundingClientRect: () => ({ x: 0, y: 0, width: 800, height: 600 }),
    };

    const mockHtml = {
      tagName: 'HTML',
      children: [mockBody],
      getAttribute: () => null,
      hasAttribute: () => false,
    };

    const mockDoc = {
      children: [mockHtml],
      body: mockBody,
      documentElement: mockHtml,
      getElementById: (id: string) => {
        if (id === 'checkout-btn') return mockButton;
        if (id === 'coupon-code') return mockInput;
        return null;
      },
      createElement: (tag: string) => {
        createdElements.push(tag);
        return { tagName: tag.toUpperCase() };
      },
    };

    const sandbox = {
      window: {
        location: { href: url },
        getComputedStyle: () => ({ display: 'block', visibility: 'visible', opacity: '1' }),
      },
      document: mockDoc,
      Element: function Element() {},
      Array,
      JSON,
      String,
      Number,
      Math,
    };

    // Ensure mock objects inherit from Element in sandbox
    Object.setPrototypeOf(mockHtml, sandbox.Element.prototype);
    Object.setPrototypeOf(mockBody, sandbox.Element.prototype);
    Object.setPrototypeOf(mockButton, sandbox.Element.prototype);
    Object.setPrototypeOf(mockInput, sandbox.Element.prototype);

    const script = buildIsolatedCollectorScript(nonce, url);
    const result = vm.runInNewContext(script, sandbox);

    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.nonce, nonce);
    assert.strictEqual(result.documentUrl, url);
    assert.strictEqual(result.descriptors.length, 2);

    const btnDesc = result.descriptors[0]!;
    assert.strictEqual(btnDesc.fingerprint.tag, 'button');
    assert.strictEqual(btnDesc.fingerprint.id, 'checkout-btn');
    assert.strictEqual(btnDesc.label, 'Complete Purchase');
    assert.strictEqual(btnDesc.rect.x, 20);
    assert.strictEqual(btnDesc.rect.y, 50);
    assert.strictEqual(btnDesc.rect.width, 120);
    assert.strictEqual(btnDesc.rect.height, 40);
    assert.strictEqual(btnDesc.rect.centerX, 80);
    assert.strictEqual(btnDesc.rect.centerY, 70);

    const inputDesc = result.descriptors[1]!;
    assert.strictEqual(inputDesc.fingerprint.tag, 'input');
    assert.strictEqual(inputDesc.fingerprint.id, 'coupon-code');
    assert.strictEqual(inputDesc.label, 'Promo code');

    // Zero-mutation assertions:
    assert.strictEqual(mutatedAttributes.length, 0, 'Collector must not mutate any DOM attributes');
    assert.strictEqual(createdElements.length, 0, 'Collector must not create any DOM elements');
    assert.strictEqual((sandbox.window as any).__antifanRefMap, undefined, 'Must not define __antifanRefMap on window');
  });

  it('3. validateCollectionEnvelope parses raw result and rejects mutated URLs or mismatched nonces', () => {
    const nonce = 'f47ac10b-58cc-4372-a567-0e02b2c3d479';
    const url = 'https://example.com/shop';

    const envelope = {
      ok: true,
      nonce,
      documentUrl: url,
      descriptors: [
        {
          path: [{ kind: 'dom', index: 0, tag: 'button', id: 'btn-1' }],
          fingerprint: { tag: 'button', id: 'btn-1' },
          rect: { x: 10, y: 20, width: 80, height: 30, centerX: 50, centerY: 35 },
          label: 'Submit',
          role: 'button',
          id: 'btn-1',
        },
      ],
    };
    const validated = validateCollectionEnvelope(envelope, nonce, url);
    assert.strictEqual(validated.length, 1);
    assert.strictEqual(validated[0]?.id, 'btn-1');

    // Nonce mismatch fails closed
    assert.throws(
      () => validateCollectionEnvelope(envelope, '99999999-9999-4999-8999-999999999999', url),
      /REF_STALE|nonce mismatch/i
    );

    // URL mismatch fails closed
    assert.throws(
      () => validateCollectionEnvelope(envelope, nonce, 'https://example.com/other'),
      /REF_STALE|documentUrl mismatch/i
    );
  });

  it('4. Executor script verifies documentUrl preflight and returns REF_DOCUMENT_MUTATED on URL change', () => {
    const request = {
      action: 'click' as const,
      ref: '@e1',
      documentUrl: 'https://example.com/step-1',
      nonce: '11111111-2222-4333-8444-555555555555',
    };

    const script = buildIsolatedExecutorScript(request);

    const sandbox = {
      window: {
        location: { href: 'https://example.com/step-2-navigated' },
      },
      document: {},
      JSON,
      Array,
    };

    const res = vm.runInNewContext(script, sandbox);
    assert.strictEqual(res.ok, false);
    assert.strictEqual(res.code, 'REF_DOCUMENT_MUTATED');
    assert.match(res.error, /mutated before execution/i);
  });
});
