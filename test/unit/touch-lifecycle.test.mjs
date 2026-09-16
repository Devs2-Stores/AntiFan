import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildIsolatedExecutorScript } from '../../.compiled/src/main/browser/semantic-ref-executor.js';

const baseReq = {
  action: 'click',
  selector: '#drawer-toggle',
  nonce: '00000000-0000-4000-8000-000000000000',
  documentUrl: 'https://example.test/',
  presetId: 'phone-iphone14pro',
};

test('mobile preset triggers full touch lifecycle sequence', () => {
  const script = buildIsolatedExecutorScript(baseReq);
  const order = [
    'pointerover',
    'pointerenter',
    'pointerdown',
    'touchstart',
    'touchend',
    'pointerup',
  ];
  let lastIdx = -1;
  for (const ev of order) {
    const idx = script.indexOf(`'${ev}'`);
    assert.ok(idx > lastIdx, `${ev} dispatched after previous event`);
    lastIdx = idx;
  }
  // `new MouseEvent('click'` also appears in the auto-dismiss path earlier in the script, so the
  // assertion anchors on the first click dispatch AFTER the touch sequence, not the first overall.
  const clickIdx = script.indexOf("new MouseEvent('click'", lastIdx);
  assert.ok(clickIdx > lastIdx, 'click dispatched last');
});

test('touch events carry isPrimary and pointerType touch', () => {
  const script = buildIsolatedExecutorScript(baseReq);
  assert.ok(script.includes('isPrimary: true'));
  assert.ok(script.includes("pointerType: 'touch'"));
});

test('44x44px target dilation applied to touch radii', () => {
  const script = buildIsolatedExecutorScript(baseReq);
  assert.ok(script.includes('Math.max(width, 44)'));
  assert.ok(script.includes('Math.max(height, 44)'));
  assert.ok(script.includes('radiusX: dilatedWidth / 2'));
});

test('click suppressed when touchstart preventDefaulted', () => {
  const script = buildIsolatedExecutorScript(baseReq);
  assert.ok(script.includes('if (!prevented)'), 'defaultPrevented check gates click');
});

test('desktop preset falls back to mouse-only dispatch', () => {
  const script = buildIsolatedExecutorScript({ ...baseReq, presetId: 'desktop-fhd' });
  // isMobilePreset evaluates false for desktop-fhd; the else branch dispatches mousedown/mouseup/click
  assert.ok(script.includes('isMobilePreset'));
  assert.ok(script.includes("new MouseEvent('mousedown'"));
});
