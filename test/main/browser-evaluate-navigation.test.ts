// A script that moves the page (location.assign, form submit) answers with the navigation, not with a
// stale-target error the caller has to decode before it learns whether the script ran.
import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import { BrowserControlPort } from '../../src/main/tools/browser-control-port';
import { CapabilityError } from '../../src/shared/control-plane-contracts';
import { evaluateCapability, EVAL_TARGET, makeEvalHost } from './evaluate-test-host';

const navigated = () => new CapabilityError(
  'TARGET_STALE',
  'Tab tab-1 navigated to https://tts.vclip.io/project/1 while the script ran; its result belonged to the document that was replaced',
  { cause: 'navigated-away', tabId: 'tab-1', newUrl: 'https://tts.vclip.io/project/1' }
);

describe('anti.browser.evaluate when the script moves the page', () => {
  it('answers with the navigation instead of a stale-target error', async () => {
    const { host } = makeEvalHost({ evalJs: async () => { throw navigated(); } });
    const result = await evaluateCapability(host)({ expression: "location.assign('https://tts.vclip.io/project/1')" });
    assert.deepEqual(result, { navigated: true, newUrl: 'https://tts.vclip.io/project/1', scriptMayHaveRun: true });
  });

  it('still refuses when the tab is gone rather than navigated', async () => {
    const gone = new CapabilityError('TARGET_STALE', 'No such tab: tab-1', { cause: 'tab-gone', tabId: 'tab-1' });
    const { host } = makeEvalHost({ evalJs: async () => { throw gone; } });
    await assert.rejects(
      evaluateCapability(host)({ expression: 'document.title' }),
      (err: unknown) => err instanceof CapabilityError && err.code === 'TARGET_STALE'
    );
  });

  it('leaves the port-level eval strict so internal measurements never read a stand-in object as data', async () => {
    const { host } = makeEvalHost({ evalJs: async () => { throw navigated(); } });
    await assert.rejects(
      new BrowserControlPort(host).eval(EVAL_TARGET, '1'),
      (err: unknown) => err instanceof CapabilityError && err.code === 'TARGET_STALE'
    );
  });
});
