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

describe('device emulation and the pane surface', () => {
  type Size = { width: number; height: number };
  const same = (a: Size | null, b: Size | null): boolean => Boolean(a && b && a.width === b.width && a.height === b.height);

  // Chromium's bookkeeping for the surface a webContents draws into, ported from content/browser:
  // EmulationHandler::SetDeviceMetricsOverride / ClearDeviceMetricsOverride with
  // WebContentsImpl::SetDeviceEmulationSize / ClearDeviceEmulationSize. Pane bounds reach the surface
  // only when they change (WebContentsViewAura::OnBoundsChanged), so re-applying the same bounds
  // cannot undo a resize the override made.
  const chromiumSurface = (initial: Size) => {
    let bounds = initial;
    let surface = initial;
    let emulationEnabled = false;
    let emulationSize: Size | null = null;
    let sizeBeforeEmulation: Size | null = null;
    return {
      surface: (): Size => surface,
      setViewBounds(next: Size): void {
        if (same(next, bounds)) return;
        bounds = next;
        surface = next;
      },
      command(method: string, params: Record<string, unknown> = {}): void {
        if (method === 'Emulation.setDeviceMetricsOverride') {
          const width = Number(params.width);
          const height = Number(params.height);
          if (params.dontSetVisibleSize !== true && width > 0 && height > 0) {
            emulationSize = { width, height };
            if (!sizeBeforeEmulation) sizeBeforeEmulation = surface;
            surface = { width, height };
          }
          emulationEnabled = true;
        } else if (method === 'Emulation.clearDeviceMetricsOverride') {
          if (!emulationEnabled) return;
          if (sizeBeforeEmulation && same(surface, emulationSize)) surface = sizeBeforeEmulation;
          emulationSize = null;
          sizeBeforeEmulation = null;
          emulationEnabled = false;
        }
      },
    };
  };

  const preset = (width: number, height: number, mobile: boolean) => ({
    id: `custom-${width}x${height}`, name: 'w', width, height, deviceScaleFactor: mobile ? 2 : 1, mobile, category: mobile ? 'mobile' : 'desktop',
  });

  it('leaves a background pane at the box the restore gave it after a width sweep', async () => {
    // Measured on a background agent tab after compare_candidates [375, 1440]: bounds back at
    // 1344x765, override cleared, page laid out at 375x812 until something resized the pane.
    const chromium = chromiumSurface({ width: 1344, height: 765 });
    let hold: Promise<void> | null = null;
    const raw = Object.create(NativeTabHost.prototype) as Record<string, unknown>;
    raw.defaultUserAgent = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36';
    raw.getDevToolsHost = () => ({
      sendCdpCommand: async (_wc: unknown, method: string, params?: Record<string, unknown>) => {
        if (hold && method === 'Emulation.setUserAgentOverride') {
          const held = hold;
          hold = null;
          await held;
        }
        chromium.command(method, params);
      },
    });
    const wc = { isDestroyed: () => false, isCrashed: () => false, getURL: () => 'https://shop.example.com/', debugger: { isAttached: () => true } };
    const apply = (raw as unknown as { applyCdpDeviceEmulationState: (w: unknown, preset: unknown) => Promise<void> }).applyCdpDeviceEmulationState.bind(raw);

    // Every width sizes the pane to the requested viewport, then emulates it.
    chromium.setViewBounds({ width: 375, height: 812 });
    await apply(wc, preset(375, 812, true));
    chromium.setViewBounds({ width: 1440, height: 900 });
    await apply(wc, preset(1440, 900, false));
    // An evaluate's temporary attach queued one more 1440 application; it is still in flight when
    // the restore puts the window's box back on the pane and clears the override.
    let release: () => void = () => {};
    hold = new Promise<void>((resolve) => { release = resolve; });
    const late = apply(wc, preset(1440, 900, false));
    chromium.setViewBounds({ width: 1344, height: 765 });
    const clear = apply(wc, null);
    release();
    await Promise.all([late, clear]);
    // What every later layout of the background tab does: the same box again.
    chromium.setViewBounds({ width: 1344, height: 765 });

    assert.deepStrictEqual(chromium.surface(), { width: 1344, height: 765 });
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
