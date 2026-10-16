// Device emulation is applied with several CDP commands and most callers fire it without waiting:
// two applications on one webContents must reach CDP in call order, or a restore that clears the
// override can land between a sweep's commands and the sweep's override wins.
import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import { NativeTabHost } from '../../src/main/browser/native-tab-host';

describe('device emulation ordering', () => {
  it('applies emulation on one webContents strictly in call order', async () => {
    const sent: string[] = [];
    let releaseFirst: () => void = () => {};
    const firstHeld = new Promise<void>((resolve) => { releaseFirst = resolve; });
    let first = true;
    const raw = Object.create(NativeTabHost.prototype) as Record<string, unknown>;
    raw.defaultUserAgent = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36';
    raw.getDevToolsHost = () => ({
      sendCdpCommand: async (_wc: unknown, method: string, params?: { width?: number }) => {
        sent.push(method + (params && params.width ? ':' + params.width : ''));
        // The sweep's first command is slow, so the restore is issued while it is in flight.
        if (first) { first = false; await firstHeld; }
      },
    });
    const wc = { isDestroyed: () => false, isCrashed: () => false, getURL: () => 'https://shop.example.com/', debugger: { isAttached: () => true } };
    const apply = (raw as unknown as { applyCdpDeviceEmulationState: (w: unknown, preset: unknown) => Promise<void> }).applyCdpDeviceEmulationState.bind(raw);
    const sweep = apply(wc, { id: 'custom-1440x900', name: 'w', width: 1440, height: 900, deviceScaleFactor: 1, mobile: false, category: 'desktop' });
    const restore = apply(wc, null);
    releaseFirst();
    await Promise.all([sweep, restore]);
    assert.deepStrictEqual(sent, [
      'Emulation.setUserAgentOverride',
      'Emulation.setDeviceMetricsOverride:1440',
      'Emulation.clearDeviceMetricsOverride',
      'Emulation.setUserAgentOverride',
    ]);
  });
});

describe('settleTabEmulation', () => {
  const hostWith = (activeTabId: string) => {
    const events: string[] = [];
    const wc = { isDestroyed: () => false };
    const raw = Object.create(NativeTabHost.prototype) as Record<string, unknown>;
    raw.tabs = new Map([['agent-tab', { view: { webContents: wc } }]]);
    raw.activeTabId = activeTabId;
    raw.updateLayout = () => { events.push('layout'); };
    raw.applyTabDeviceEmulationForTab = (id: string) => { events.push('emulate ' + id); };
    raw.runWithAttachedTabView = async (_view: unknown, action: () => Promise<void>) => {
      events.push('attach');
      await action();
      events.push('release');
    };
    return { host: raw as unknown as NativeTabHost, events };
  };

  it('emulates a background tab inside a temporary attach and waits before releasing it', async () => {
    const { host, events } = hostWith('user-tab');
    await host.settleTabEmulation('agent-tab');
    assert.deepStrictEqual(events, ['attach', 'emulate agent-tab', 'release']);
  });

  it('re-lays out the active tab in place', async () => {
    const { host, events } = hostWith('agent-tab');
    await host.settleTabEmulation('agent-tab');
    assert.deepStrictEqual(events, ['layout']);
  });
});
