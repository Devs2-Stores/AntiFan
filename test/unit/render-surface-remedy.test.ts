import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import { renderSurfaceRemedy } from '../../src/main/verification/visual-capture';

describe('renderSurfaceRemedy', () => {
  it('sends a hidden or minimized window to tabs.activate restoreWindow, never to set_viewport', () => {
    for (const remedy of [
      renderSurfaceRemedy({ cause: 'window-not-presented' }),
      renderSurfaceRemedy({ cause: 'background-hidden', hostWindowHidden: true }),
    ]) {
      assert.equal(remedy.hostWindowHidden, true);
      assert.equal(remedy.retryable, true);
      assert.match(remedy.text, /restoreWindow:true/);
      assert.match(remedy.text, /allowDegradedSurface:true/);
      assert.match(remedy.text, /Do not use anti\.browser\.set_viewport/);
      assert.equal(remedy.steps[0], 'anti.browser.tabs.activate {restoreWindow:true}');
    }
  });

  it('tells a loading document to wait, not to resize it', () => {
    const remedy = renderSurfaceRemedy({ cause: 'document-not-loaded' });
    assert.equal(remedy.hostWindowHidden, false);
    assert.deepEqual(remedy.steps, ['anti.browser.wait', 'retry']);
    assert.doesNotMatch(remedy.text, /set_viewport/);
  });

  it('tells a background tab of a visible window to activate it first', () => {
    const remedy = renderSurfaceRemedy({ cause: 'background-hidden' });
    assert.equal(remedy.hostWindowHidden, false);
    assert.equal(remedy.steps[0], 'anti.browser.tabs.activate');
    assert.match(remedy.text, /tabs\.activate/);
    assert.doesNotMatch(remedy.text, /Call anti\.browser\.set_viewport/);
  });

  it('offers get_viewport first for an unclassified surface and flags set_viewport as a persistent override', () => {
    const remedy = renderSurfaceRemedy({ cause: 'probe-unavailable' });
    assert.equal(remedy.steps[0], 'anti.browser.get_viewport');
    assert.match(remedy.text, /no laid-out surface/);
    assert.match(remedy.text, /persistent device-emulation override/);
    assert.ok(remedy.steps.includes('allowDegradedSurface:true'));
  });

  it('every remedy is retryable and names its steps in order', () => {
    for (const cause of ['window-not-presented', 'document-not-loaded', 'background-hidden', 'probe-unavailable', 'zero-size']) {
      const remedy = renderSurfaceRemedy({ cause });
      assert.equal(remedy.retryable, true, cause);
      assert.ok(remedy.steps.length >= 2, cause);
      assert.ok(remedy.text.length > 40, cause);
    }
  });
});
