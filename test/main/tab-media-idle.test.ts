/**
 * Idle-media policy: pausing has to be reversible and must never touch the tab the user is on, a
 * tab an agent is driving, or a page that vetoed unloading. The sweep acts on `pause: true`, so the
 * refusals matter as much as the decision.
 */
import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import {
  MEDIA_IDLE_MS,
  MEDIA_FREEZE_CSS,
  MEDIA_PAUSE_SCRIPT,
  MEDIA_RESUME_SCRIPT,
  shouldPauseIdleMedia,
  type MediaIdleFacts,
} from '../../src/main/browser/tab-media-idle';
import { NativeTabHost } from '../../src/main/browser/native-tab-host';

const idle: MediaIdleFacts = {
  presented: false,
  windowVisibleAndFocused: false,
  idleMs: MEDIA_IDLE_MS,
  playing: true,
  agentPlane: false,
  unloadVetoed: false,
};

describe('shouldPauseIdleMedia', () => {
  it('pauses media in a window nobody is looking at once it is idle', () => {
    assert.deepEqual(shouldPauseIdleMedia(idle), { pause: true });
  });

  it('never touches a tab while its window is focused and visible', () => {
    assert.deepEqual(shouldPauseIdleMedia({ ...idle, windowVisibleAndFocused: true }), { pause: false, reason: 'window-in-use' });
    assert.deepEqual(shouldPauseIdleMedia({ ...idle, windowVisibleAndFocused: true, idleMs: MEDIA_IDLE_MS * 10 }), { pause: false, reason: 'window-in-use' });
  });

  it('waits out the idle floor exactly', () => {
    assert.deepEqual(shouldPauseIdleMedia({ ...idle, idleMs: MEDIA_IDLE_MS - 1 }), { pause: false, reason: 'not-idle' });
    assert.deepEqual(shouldPauseIdleMedia({ ...idle, idleMs: MEDIA_IDLE_MS }), { pause: true });
  });

  it('leaves an agent-driven tab alone', () => {
    assert.deepEqual(shouldPauseIdleMedia({ ...idle, agentPlane: true }), { pause: false, reason: 'agent-plane' });
  });

  it('leaves a page that vetoed unloading alone', () => {
    assert.deepEqual(shouldPauseIdleMedia({ ...idle, unloadVetoed: true }), { pause: false, reason: 'unload-veto' });
  });

  it('does not warm-freeze a silent background tab that is not presented', () => {
    assert.deepEqual(shouldPauseIdleMedia({ ...idle, playing: false }), { pause: false, reason: 'not-playing' });
    assert.deepEqual(shouldPauseIdleMedia({ ...idle, playing: false, presented: true }), { pause: true });
  });

  // Approved scope: an unfocused window counts as out of sight even when its page is presented and
  // still on screen, because that page can sit beside the focused window and keep a core busy. The
  // host exempts agent/MCP/CDP-bound tabs, so a theme QA capture never runs against a frozen page,
  // and activating the tab thaws it immediately.
  it('freezes the presented page of an unfocused window, but never of a focused one', () => {
    assert.deepEqual(shouldPauseIdleMedia({ ...idle, presented: true }), { pause: true });
    assert.deepEqual(shouldPauseIdleMedia({ ...idle, presented: true, windowVisibleAndFocused: true }), { pause: false, reason: 'window-in-use' });
    assert.deepEqual(shouldPauseIdleMedia({ ...idle, presented: true, agentPlane: true }), { pause: false, reason: 'agent-plane' });
  });
});

describe('NativeTabHost pauseIdleMedia / resumeIdleMedia', () => {
  const buildHost = (opts: {
    activeTabId: string;
    focused: boolean;
    onDuringProbe?: (tab: { lastActiveAt: number }, winState: { focused: boolean }) => void;
  }) => {
    const winState = { focused: opts.focused };
    const inserted: string[] = [];
    const removed: string[] = [];
    const scripts: string[] = [];
    const tab = {
      lastActiveAt: 1000,
      state: { hibernated: false },
      view: {
        webContents: {
          id: 42,
          isDestroyed: () => false,
          insertCSS: async (css: string) => {
            inserted.push(css);
            return 'css-key-1';
          },
          removeInsertedCSS: (key: string) => {
            removed.push(key);
          },
          executeJavaScript: async (script: string) => {
            scripts.push(script);
            opts.onDuringProbe?.(tab, winState);
            return 1;
          },
        },
      },
      mobileView: null,
    };
    const raw = Object.create(NativeTabHost.prototype) as Record<string, unknown>;
    raw.tabs = new Map([['tab-1', tab]]);
    raw.activeTabId = opts.activeTabId;
    raw.mediaFrozenTabs = new Map<string, string[]>();
    raw.shell = {
      window: {
        isDestroyed: () => false,
        isVisible: () => true,
        isMinimized: () => false,
        isFocused: () => winState.focused,
      },
    };
    return {
      host: raw as unknown as {
        pauseIdleMedia: (id: string) => Promise<void>;
        resumeIdleMedia: (id: string) => void;
        mediaFrozenTabs: Map<string, string[]>;
      },
      inserted,
      removed,
      scripts,
    };
  };

  it('keeps a background tab of an unfocused window frozen until it is resumed', async () => {
    const { host, inserted, removed, scripts } = buildHost({ activeTabId: 'other-tab', focused: false });
    await host.pauseIdleMedia('tab-1');
    assert.deepEqual(inserted, [MEDIA_FREEZE_CSS]);
    assert.deepEqual(removed, []);
    assert.deepEqual(scripts, [MEDIA_PAUSE_SCRIPT]);
    assert.deepEqual(host.mediaFrozenTabs.get('tab-1'), ['css-key-1']);

    host.resumeIdleMedia('tab-1');
    assert.deepEqual(removed, ['css-key-1']);
    assert.deepEqual(scripts, [MEDIA_PAUSE_SCRIPT, MEDIA_RESUME_SCRIPT]);
    assert.equal(host.mediaFrozenTabs.has('tab-1'), false);
  });

  it('undoes the freeze at once when the window regains focus while the pause probe is in flight', async () => {
    const { host, removed, scripts } = buildHost({
      activeTabId: 'other-tab',
      focused: false,
      onDuringProbe: (_tab, winState) => { winState.focused = true; },
    });
    await host.pauseIdleMedia('tab-1');
    assert.deepEqual(removed, ['css-key-1']);
    assert.deepEqual(scripts, [MEDIA_PAUSE_SCRIPT, MEDIA_RESUME_SCRIPT]);
    assert.equal(host.mediaFrozenTabs.has('tab-1'), false);
  });

  it('undoes the freeze at once when the tab gets input while the pause probe is in flight', async () => {
    const { host, removed, scripts } = buildHost({
      activeTabId: 'other-tab',
      focused: false,
      onDuringProbe: (tab) => { tab.lastActiveAt = 2000; },
    });
    await host.pauseIdleMedia('tab-1');
    assert.deepEqual(removed, ['css-key-1']);
    assert.deepEqual(scripts, [MEDIA_PAUSE_SCRIPT, MEDIA_RESUME_SCRIPT]);
    assert.equal(host.mediaFrozenTabs.has('tab-1'), false);
  });
});
