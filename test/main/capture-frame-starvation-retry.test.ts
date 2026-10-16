import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import { CaptureError } from '../../src/main/verification/visual-capture';
import { createCaptureHarness } from './capture-host-harness';

describe('capture frame starvation: activate the target, then dispatch', () => {
  it('recovers a background tab that only produces frames once it is the presented tab, then restores the user tab', async () => {
    const state = { activated: false };
    const harness = createCaptureHarness({ frameAlive: () => state.activated });
    const baseSwitch = harness.ctx.switchTab!;
    harness.ctx.switchTab = (tabId, opts) => {
      if (tabId === 'tab-2') state.activated = true;
      return baseSwitch(tabId, opts);
    };

    const envelope = await harness.devTools.captureVerificationScreenshot(undefined, 'tab-2', 'desktop');

    assert.equal(envelope.backend, 'cdp');
    assert.equal(envelope.captureMode, 'viewport');
    const methods = harness.calls.map((c) => c.method);
    assert.ok(methods.includes('Page.bringToFront'), 'the repair must ask the page to come to the front');
    assert.ok(methods.includes('Page.captureScreenshot'), 'the capture must be dispatched once frames exist');
    assert.ok(methods.indexOf('Page.bringToFront') < methods.indexOf('Page.captureScreenshot'));
    assert.deepEqual(harness.switched, ['tab-2', 'tab-1'], 'the target is activated for the raster and the user tab is put back afterwards');
  });

  it('names the activation attempt and the real remedy when the window still produces no frame, and puts the user tab back', async () => {
    const harness = createCaptureHarness({ frameAlive: () => false });

    await assert.rejects(
      () => harness.devTools.captureVerificationScreenshot(undefined, 'tab-2', 'desktop'),
      (err: unknown) => {
        assert.ok(err instanceof CaptureError);
        assert.equal(err.code, 'CAPTURE_FRAME_STARVATION');
        assert.match(err.message, /activate-tab/, 'the message must report that the tab was activated');
        assert.match(err.message, /bring the AntiFan window to the front/);
        assert.doesNotMatch(err.message, /Remedy: .*restart the app/, 'restarting is no longer the first remedy');
        return true;
      }
    );
    assert.equal(harness.calls.some((c) => c.method === 'Page.captureScreenshot'), false, 'a starved presenter never receives the dispatch');
    assert.deepEqual(harness.switched, ['tab-2', 'tab-1']);
  });

  it('does not switch tabs for a target that is already the presented one', async () => {
    const harness = createCaptureHarness({ frameAlive: () => false });

    await assert.rejects(
      () => harness.devTools.captureVerificationScreenshot(undefined, 'tab-1', 'desktop'),
      (err: unknown) => err instanceof CaptureError && err.code === 'CAPTURE_FRAME_STARVATION'
    );
    assert.deepEqual(harness.switched, []);
    assert.ok(harness.calls.some((c) => c.method === 'Page.bringToFront'));
  });
});
