import { describe, it } from 'node:test';
import * as assert from 'node:assert';
import {
  normalizeKey,
  normalizeModifiers,
  buildKeyboardInputEvents,
} from '../../src/main/browser/keyboard-normalizer';
import { BrowserControlPort, BrowserHostPort } from '../../src/main/tools/browser-control-port';
import { CapabilityCatalogue } from '../../src/main/tools/capability-catalogue';
import { registerBrowserCapabilities } from '../../src/main/tools/browser-capabilities';
import { CapabilityError, issueRuntimeLease, makeControlPlaneId } from '../../src/shared/control-plane-contracts';

function createMockHost(overrides?: Partial<BrowserHostPort>): BrowserHostPort {
  return {
    getTabList: () => [{ id: 'tab-active', url: 'https://example.com' }],
    getActiveTabId: () => 'tab-active',
    navigate: () => true,
    reload: () => true,
    getDom: async () => '<html></html>',
    captureScreenshot: async () => '',
    evalJs: async () => null,
    ...overrides,
  };
}

describe('Keyboard Normalizer & Browser Native Keyboard Press', () => {
  describe('normalizeKey', () => {
    it('normalizes standard named keys case-insensitively', () => {
      const enter = normalizeKey('enter');
      assert.strictEqual(enter.keyCode, 'Return');
      assert.strictEqual(enter.isPrintable, false);

      const esc = normalizeKey('esc');
      assert.strictEqual(esc.keyCode, 'Escape');

      const tab = normalizeKey('TAB');
      assert.strictEqual(tab.keyCode, 'Tab');

      const backspace = normalizeKey('Backspace');
      assert.strictEqual(backspace.keyCode, 'Backspace');

      const arrowDown = normalizeKey('arrowdown');
      assert.strictEqual(arrowDown.keyCode, 'Down');

      const space = normalizeKey('space');
      assert.strictEqual(space.keyCode, 'Space');
      assert.strictEqual(space.isPrintable, true);
    });

    it('normalizes single alphanumeric and printable punctuation keys', () => {
      const a = normalizeKey('a');
      assert.strictEqual(a.keyCode, 'a');
      assert.strictEqual(a.isPrintable, true);
      assert.strictEqual(a.text, 'a');

      const num5 = normalizeKey('5');
      assert.strictEqual(num5.keyCode, '5');
      assert.strictEqual(num5.isPrintable, true);

      const slash = normalizeKey('/');
      assert.strictEqual(slash.keyCode, '/');
      assert.strictEqual(slash.isPrintable, true);
    });

    it('throws on invalid empty key names or unsupported keys', () => {
      assert.throws(() => normalizeKey(''), /Key must be a non-empty string/);
      assert.throws(() => normalizeKey('   '), /Key must be a non-empty string/);
      assert.throws(() => normalizeKey('InvalidKeyXYZ'), /Unknown or unsupported key/);
    });
  });

  describe('normalizeModifiers', () => {
    it('maps modifier aliases (ctrl, cmd, win, opt) to Electron modifiers', () => {
      const mods = normalizeModifiers(['ctrl', 'SHIFT', 'opt', 'cmd']);
      assert.deepStrictEqual(mods.sort(), ['alt', 'control', 'meta', 'shift'].sort());
    });

    it('deduplicates modifiers and throws on unknown modifier names', () => {
      const mods = normalizeModifiers(['control', 'ctrl', 'shift']);
      assert.deepStrictEqual(mods.sort(), ['control', 'shift'].sort());

      assert.throws(() => normalizeModifiers(['invalid-mod']), /Unknown modifier/);
    });

    it('returns empty array when modifiers are undefined or empty', () => {
      assert.deepStrictEqual(normalizeModifiers(undefined), []);
      assert.deepStrictEqual(normalizeModifiers([]), []);
    });
  });

  describe('buildKeyboardInputEvents', () => {
    it('builds keyDown + char + keyUp for printable keys without shortcut modifiers', () => {
      const plainEvents = buildKeyboardInputEvents('k');
      assert.strictEqual(plainEvents.length, 3);
      assert.strictEqual(plainEvents[0]?.type, 'keyDown');
      assert.strictEqual(plainEvents[0]?.keyCode, 'k');
      assert.deepStrictEqual(plainEvents[0]?.modifiers, []);
      assert.strictEqual(plainEvents[1]?.type, 'char');
      assert.strictEqual(plainEvents[1]?.keyCode, 'k');
      assert.strictEqual(plainEvents[2]?.type, 'keyUp');
      assert.strictEqual(plainEvents[2]?.keyCode, 'k');

      const shiftEvents = buildKeyboardInputEvents('k', ['shift']);
      assert.strictEqual(shiftEvents.length, 3);
      assert.strictEqual(shiftEvents[0]?.type, 'keyDown');
      assert.strictEqual(shiftEvents[0]?.keyCode, 'k');
      assert.deepStrictEqual(shiftEvents[0]?.modifiers, ['shift']);
      assert.strictEqual(shiftEvents[1]?.type, 'char');
      assert.strictEqual(shiftEvents[1]?.keyCode, 'k');
      assert.strictEqual(shiftEvents[2]?.type, 'keyUp');
      assert.strictEqual(shiftEvents[2]?.keyCode, 'k');
    });

    it('omits char event for shortcut keys with control or meta', () => {
      const events = buildKeyboardInputEvents('k', ['ctrl']);
      assert.strictEqual(events.length, 2);
      assert.strictEqual(events[0]?.type, 'keyDown');
      assert.strictEqual(events[0]?.keyCode, 'k');
      assert.deepStrictEqual(events[0]?.modifiers, ['control']);

      assert.strictEqual(events[1]?.type, 'keyUp');
      assert.strictEqual(events[1]?.keyCode, 'k');
    });

    it('builds keyDown + keyUp without char for non-printable navigation/control keys', () => {
      const events = buildKeyboardInputEvents('Enter');
      assert.strictEqual(events.length, 2);
      assert.strictEqual(events[0]?.type, 'keyDown');
      assert.strictEqual(events[0]?.keyCode, 'Return');
      assert.strictEqual(events[1]?.type, 'keyUp');
      assert.strictEqual(events[1]?.keyCode, 'Return');
    });
  });

  describe('BrowserControlPort.keyboardPress', () => {
    it('dispatches keyboard press to host with active tab fallback and target resolution', async () => {
      let dispatchedParams: unknown;
      const mockHost = createMockHost({
        sendKeyboardPress: async (params) => {
          dispatchedParams = params;
          return { success: true, key: params.key, modifiers: params.modifiers || [] };
        },
      });

      const port = new BrowserControlPort(mockHost);
      const res = await port.keyboardPress({ key: 'Enter', modifiers: ['ctrl'], tabId: 'tab-active' });
      assert.strictEqual(res.success, true);
      assert.strictEqual(res.key, 'Enter');
      assert.deepStrictEqual(dispatchedParams, { key: 'Enter', modifiers: ['ctrl'], tabId: 'tab-active' });
    });

    it('validates key parameter and throws CapabilityError on empty or invalid key', async () => {
      const mockHost = createMockHost({
        sendKeyboardPress: async (params) => {
          if (params.modifiers?.includes('invalid-mod')) {
            throw new Error('Unsupported modifier: invalid-mod');
          }
          return { success: true, key: params.key, modifiers: params.modifiers || [] };
        },
      });

      const port = new BrowserControlPort(mockHost);
      await assert.rejects(
        () => port.keyboardPress({ key: '', tabId: 'tab-active' }),
        (err: unknown) => err instanceof CapabilityError && err.code === 'INVALID_ARGUMENT',
      );
      await assert.rejects(
        () => port.keyboardPress({ key: 'a', modifiers: ['invalid-mod'], tabId: 'tab-active' }),
        (err: unknown) => err instanceof CapabilityError && err.code === 'INVALID_ARGUMENT',
      );
    });

    it('throws CapabilityError if host does not support sendKeyboardPress', async () => {
      const mockHost = createMockHost();

      const port = new BrowserControlPort(mockHost);
      await assert.rejects(
        () => port.keyboardPress({ key: 'Escape', tabId: 'tab-active' }),
        (err: unknown) => err instanceof CapabilityError && err.code === 'CAPABILITY_NOT_FOUND',
      );
    });
  });

  describe('CapabilityCatalogue & MCP Integration', () => {
    it('registers browser.keyboard-press and antifan_keyboard_press with policy enforcement', async () => {
      const projectId = makeControlPlaneId('project');
      const workspaceId = makeControlPlaneId('workspace');
      const lease = issueRuntimeLease(projectId, workspaceId, 30_000, 1);
      const catalogue = new CapabilityCatalogue({
        runtime: { mode: 'standalone', lifecycle: 'active' },
        projectId,
        workspaceId,
        runtimeId: lease.runtimeId,
        hostEpoch: 1,
      });

      let hostKeyReceived = '';
      let hostModifiersReceived: string[] = [];

      const mockHost = createMockHost({
        sendKeyboardPress: async (params) => {
          hostKeyReceived = params.key;
          hostModifiersReceived = params.modifiers || [];
          return { success: true, key: params.key, modifiers: params.modifiers || [] };
        },
      });

      const port = new BrowserControlPort(mockHost);
      registerBrowserCapabilities(catalogue, port);

      const browserTarget = {
        projectId,
        workspaceId,
        runtimeId: lease.runtimeId,
        tabId: 'tab-active',
        browserEpoch: 1,
        documentGeneration: 1,
      };

      // Verify write capability requires write grant
      await assert.rejects(
        () => catalogue.dispatch('browser.keyboard-press', { key: 'Tab' }, { lease, leaseToken: lease.token, projectId, workspaceId, browserTarget, grant: 'read' }),
        (err: unknown) => err instanceof CapabilityError && err.code === 'POLICY_DENIED',
      );

      // Verify successful execution with write grant
      const result = (await catalogue.dispatch(
        'browser.keyboard-press',
        { key: 'Tab', modifiers: ['shift'] },
        { lease, leaseToken: lease.token, projectId, workspaceId, browserTarget, grant: 'write' },
      )) as { success: boolean; key: string };
      assert.strictEqual(result.success, true);
      assert.strictEqual(hostKeyReceived, 'Tab');
      assert.deepStrictEqual(hostModifiersReceived, ['shift']);

      // Verify alias antifan_keyboard_press
      const aliasResult = (await catalogue.dispatch(
        'antifan_keyboard_press',
        { key: 'Escape' },
        { lease, leaseToken: lease.token, projectId, workspaceId, browserTarget, grant: 'write' },
      )) as { success: boolean; key: string };
      assert.strictEqual(aliasResult.success, true);
      assert.strictEqual(hostKeyReceived, 'Escape');

      // Verify freeze policy: requiresBrowserTarget and viewport-gate lane
      const keyboardCaps = [
        'browser.keyboard-press',
        'antifan_keyboard_press',
        'browser.send-keyboard-press',
        'browser_press_key',
      ];
      for (const capName of keyboardCaps) {
        const registered = catalogue.get(capName);
        assert.ok(registered, `Capability ${capName} must be registered`);
        assert.strictEqual(registered.requiresBrowserTarget, true, `${capName} must have requiresBrowserTarget: true`);
        assert.strictEqual(registered.policy.requiresBrowserTarget, true, `${capName} policy must have requiresBrowserTarget: true`);
        assert.strictEqual(registered.policy.schedulerLane, 'viewport-gate', `${capName} policy must have schedulerLane: 'viewport-gate'`);
        assert.strictEqual(registered.policy.ownerCancellationBehavior, 'drain-and-persist');
        assert.strictEqual(registered.policy.subscriberDisconnectBehavior, 'detach-and-continue');
        assert.ok(registered.policy.cancellationAckTimeoutMs > 0);
      }
    });
  });
});
