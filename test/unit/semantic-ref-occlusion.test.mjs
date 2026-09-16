import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildIsolatedExecutorScript } from '../../.compiled/src/main/browser/semantic-ref-executor.js';

const baseReq = {
  action: 'click',
  selector: '#target',
  nonce: '00000000-0000-4000-8000-000000000000',
  documentUrl: 'https://example.test/',
};

test('executor script contains containment check before dismissal', () => {
  const script = buildIsolatedExecutorScript(baseReq);
  const containmentIdx = script.indexOf('isContained');
  const dismissIdx = script.indexOf('overlaySelector');
  assert.ok(containmentIdx > -1, 'containment check present');
  assert.ok(dismissIdx > -1, 'auto-dismiss logic present');
  assert.ok(containmentIdx < dismissIdx, 'containment check runs before dismissal');
});

test('executor script honors noAutoDismiss opt-out', () => {
  const script = buildIsolatedExecutorScript({ ...baseReq, noAutoDismiss: true });
  assert.ok(script.includes('noAutoDismiss'), 'noAutoDismiss flag wired');
  assert.ok(script.includes('__antifanNoAutoDismiss'), 'session-level opt-out honored');
});

test('executor script includes deep-piercing dispatch for type', () => {
  const script = buildIsolatedExecutorScript({ ...baseReq, action: 'type', text: 'hello' });
  assert.ok(script.includes("req.action === 'type'"), 'type piercing branch present');
  assert.ok(script.includes('beforeinput'), 'beforeinput dispatched');
  assert.ok(script.includes('setNativeValue'), 'native value setter used');
});

test('executor script includes touch lifecycle for mobile preset', () => {
  const script = buildIsolatedExecutorScript({ ...baseReq, presetId: 'phone-iphone14pro' });
  assert.ok(script.includes('pointerover'), 'pointerover dispatched');
  assert.ok(script.includes('pointerenter'), 'pointerenter dispatched');
  assert.ok(script.includes('pointerdown'), 'pointerdown dispatched');
  assert.ok(script.includes('touchstart'), 'touchstart dispatched');
  assert.ok(script.includes('touchend'), 'touchend dispatched');
  assert.ok(script.includes('pointerup'), 'pointerup dispatched');
  assert.ok(script.includes("pointerType: 'touch'"), 'pointerType touch set');
  assert.ok(script.includes('isPrimary: true'), 'isPrimary set');
  assert.ok(script.includes('Math.max(width, 44)'), '44px dilation applied');
  assert.ok(script.includes('!prevented'), 'defaultPrevented gate before click');
});

test('executor script settles on motion drift without paying an asset-readiness budget', () => {
  const script = buildIsolatedExecutorScript(baseReq);
  assert.ok(script.includes('consecutiveZeroDelta'), 'zero-delta frame counter present');
  assert.ok(script.includes('hasRunningInfiniteAnimation'), 'infinite-motion tolerance applied');
  // Font/image readiness belongs to the visual-parity settle barrier in the capture path
  // (verification/capture-settle.ts). Awaiting it per action blew the executor latency SLO.
  assert.ok(!script.includes('document.fonts.ready'), 'no per-action font wait');
  assert.ok(!script.includes('img.decode'), 'no per-action image decode');
});

test('executor script includes mutation-loop circuit breaker', () => {
  const script = buildIsolatedExecutorScript(baseReq);
  assert.ok(script.includes('MutationObserver'), 'MutationObserver wired');
  assert.ok(script.includes('mutationCount >= 5'), 'mutation threshold enforced');
});

test('executor script caps auto-dismiss at 2 attempts', () => {
  const script = buildIsolatedExecutorScript(baseReq);
  assert.ok(script.includes('attempt < 2'), 'attempt cap present');
});

test('executor script Escape fallback skips editable focus', () => {
  const script = buildIsolatedExecutorScript(baseReq);
  assert.ok(script.includes('isEditableFocused'), 'editable-focus guard present');
  assert.ok(script.includes("key: 'Escape'"), 'Escape keydown dispatched');
});
