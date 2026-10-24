/**
 * The ambient-authority refusals tell the caller what to do next: a dead binding says why it is
 * stale, and a request with no window names the user's way of handing the agent a tab.
 */
import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import { TabAmbientAuthority } from '../../../src/main/browser/tab-ambient-authority';
import { CapabilityError } from '../../../src/shared/control-plane-contracts';
import type { NativeTabHost } from '../../../src/main/browser/native-tab-host';

const MENU_LABEL = 'Cho agent của project này dùng tab';

function authority(hosts: unknown[] = []): TabAmbientAuthority {
  return new TabAmbientAuthority({
    directory: {
      hosts: () => hosts as NativeTabHost[],
      hostForTab: () => undefined,
      hostForProject: () => undefined,
    },
  });
}

function refusal(run: () => unknown): CapabilityError {
  try {
    run();
  } catch (err) {
    assert.ok(err instanceof CapabilityError, 'a typed refusal');
    return err;
  }
  assert.fail('expected a refusal');
}

function liveHost(): unknown {
  return {
    canHostTabs: () => true,
    getAutomationTabId: () => null,
    windowOwnerKey: () => 'project:p',
  };
}

describe('TARGET_STALE for a tab no window owns', () => {
  it('carries the unowned cause alongside the existing rebind hints', () => {
    const err = refusal(() => authority().hostForTabOrBootstrap('tab-gone'));
    assert.equal(err.code, 'TARGET_STALE');
    assert.equal(err.details?.cause, 'unowned');
    assert.equal(err.details?.canRebind, true);
    assert.equal(err.details?.recovery, 'anti.browser.tabs.list');
  });
});

describe('TARGET_REQUIRED guidance', () => {
  it('names the right-click share menu when no window is live', () => {
    const err = refusal(() => authority([]).ambientHostOrThrow());
    assert.equal(err.code, 'TARGET_REQUIRED');
    assert.match(String(err.details?.recovery), new RegExp(MENU_LABEL));
    assert.match(String(err.details?.recovery), /anti\.browser\.rebind_target/);
  });

  it('names the right-click share menu when several windows are live', () => {
    const err = refusal(() => authority([liveHost(), liveHost()]).ambientHostOrThrow());
    assert.equal(err.code, 'TARGET_REQUIRED');
    assert.match(String(err.details?.recovery), new RegExp(MENU_LABEL));
    assert.match(String(err.details?.recovery), /anti\.browser\.tabs\.list/);
  });
});
