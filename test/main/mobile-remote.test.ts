import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as vm from 'node:vm';
import { getLocalLanIps } from '../../src/main/bridge/bridge-server';
import { generateQrSvg } from '../../src/main/bridge/qr-generator';
import { renderMobileRemoteHtml } from '../../src/main/bridge/mobile-remote-html';

test('getLocalLanIps returns at least one valid IPv4 address', () => {
  const ips = getLocalLanIps();
  assert.ok(Array.isArray(ips));
  assert.ok(ips.length > 0);
  for (const ip of ips) {
    assert.match(ip, /^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/);
  }
});

test('generateQrSvg creates a valid clean standard SVG QR Code for short and long URLs', () => {
  const shortUrl = 'http://192.168.1.5:20130/?token=abc';
  const longUrl = 'http://192.168.1.50:20130/?token=78a83d7f90c8129e7162534f9a0b1c2d3e4f5';
  const svgShort = generateQrSvg(shortUrl, 240);
  const svgLong = generateQrSvg(longUrl, 240);
  assert.ok(typeof svgShort === 'string');
  assert.ok(svgShort.startsWith('<svg'));
  assert.ok(svgShort.includes('fill="#ffffff"'));
  assert.ok(svgShort.includes('fill="#0a0f1d"'));

  assert.ok(typeof svgLong === 'string');
  assert.ok(svgLong.startsWith('<svg'));
  assert.ok(svgLong.includes('</svg>'));
});

test('renderMobileRemoteHtml generates complete Pure Mobile Remote Terminal HTML', () => {
  const port = 20129;
  const html = renderMobileRemoteHtml(port);

  assert.ok(typeof html === 'string');
  assert.ok(html.includes('<!DOCTYPE html>'));
  assert.ok(html.includes('AntiFan Mobile Terminal'));
  assert.ok(html.includes('view-terminal'));
  assert.ok(html.includes('termSessionsStrip'));
  assert.ok(html.includes('terminalScreen'));
  assert.ok(html.includes('virtual-keypad'));
  assert.ok(html.includes('ansiToHtml'));
  assert.ok(html.includes('sendKey'));
  assert.ok(html.includes('ctrl_c'));
  assert.ok(html.includes('antifan.getTerminalSessions'));
  assert.ok(html.includes('antifan.terminalInput'));
  assert.ok(html.includes('antifan.terminalSendKey'));
  assert.ok(html.includes('antifan.terminalSwitchSession'));
  assert.ok(html.includes('antifan.terminalNewSession'));
  assert.ok(html.includes('antifan.terminalCloseSession'));
  assert.ok(html.includes('antifan.terminalRenameSession'));
  assert.ok(html.includes('btnModeToggle'));
  assert.ok(html.includes('terminalInput'));
  assert.ok(html.includes('initWebSocket'));
  // Dual-plane pairing contract (Phase 4): the mobile companion must NOT embed the
  // bridge master token into HTML; pairing happens via a bounded loopback code + WS subprotocol.
  assert.ok(html.includes('pairingCodeInput'), 'Mobile HTML must render the pairing code input');
  assert.ok(html.includes('pairingSubmitBtn') || html.includes('Ghép Nối'), 'Mobile HTML must render the pairing submit action');
  assert.ok(!html.includes('sample-bridge-token-xyz'), 'Mobile HTML must not embed a provided token literal');
  assert.ok(html.includes('antifan_mobile_token'), 'Mobile HTML must reference sessionStorage token for subprotocol auth, never a URL query token');
});

/* ------------------------------------------------------------------------- *
 * Behavioural harness for the mobile remote surface.
 *
 * `renderMobileRemoteHtml` returns one self-contained document, so the only
 * honest way to test what a phone renders is to execute the embedded script for
 * real and read the DOM it produces. The document, storage, and WebSocket are
 * stubbed platform boundaries; every line of the shipped mobile client runs
 * unmodified. Element ids are seeded from the generated markup itself, so a
 * surface element the markup forgot to declare resolves to `null` exactly as it
 * would in a browser.
 * ------------------------------------------------------------------------- */

/** Minimal DOM node: enough of the real API for the mobile client's writes. */
class FakeNode {
  public readonly children: FakeNode[] = [];
  public title = '';
  public textContent = '';
  public value = '';
  public placeholder = '';
  public disabled = false;
  public scrollTop = 0;
  public scrollHeight = 0;
  public clientHeight = 0;
  public onclick: ((event?: unknown) => void) | null = null;
  public ontouchstart: (() => void) | null = null;
  public ontouchend: (() => void) | null = null;
  public ontouchcancel: (() => void) | null = null;
  public readonly style: Record<string, string> = {};
  private markup = '';
  private readonly classes = new Set<string>();

  constructor(public readonly tagName: string, public readonly elementId = '') {}

  public get className(): string {
    return [...this.classes].join(' ');
  }

  public set className(value: string) {
    this.classes.clear();
    for (const name of String(value).split(/\s+/).filter(Boolean)) this.classes.add(name);
  }

  public get classList() {
    const classes = this.classes;
    return {
      add: (...names: string[]) => { for (const name of names) classes.add(name); },
      remove: (...names: string[]) => { for (const name of names) classes.delete(name); },
      contains: (name: string) => classes.has(name),
      toggle: (name: string, force?: boolean) => {
        const next = force === undefined ? !classes.has(name) : force;
        if (next) classes.add(name); else classes.delete(name);
        return next;
      },
    };
  }

  /** Mirrors the DOM: assigning markup replaces the element's content. */
  public get innerHTML(): string {
    return this.markup;
  }

  public set innerHTML(value: string) {
    this.markup = String(value);
    this.children.length = 0;
  }

  public appendChild<T extends FakeNode>(child: T): T {
    this.children.push(child);
    return child;
  }

  public append(...nodes: FakeNode[]): void {
    for (const node of nodes) this.children.push(node);
  }

  /** `beforeend` only: the client appends transcript chunks to the screen. */
  public insertAdjacentHTML(_position: string, markup: string): void {
    this.markup += String(markup);
  }

  public addEventListener(): void {}
  public removeEventListener(): void {}
  public focus(): void {}
  public remove(): void {}
  public contains(node: unknown): boolean {
    return node === this;
  }

  public descendants(): FakeNode[] {
    const found: FakeNode[] = [];
    for (const child of this.children) found.push(child, ...child.descendants());
    return found;
  }
}

interface SentFrame {
  id?: string;
  method?: string;
  params?: Record<string, unknown>;
}

class FakeWebSocket {
  public static readonly OPEN = 1;
  public static readonly CLOSED = 3;
  public static instances: FakeWebSocket[] = [];

  public readyState = FakeWebSocket.OPEN;
  public onopen: (() => void) | null = null;
  public onmessage: ((event: { data: string }) => void) | null = null;
  public onclose: ((event: { code?: number }) => void) | null = null;
  public onerror: (() => void) | null = null;
  public readonly sent: SentFrame[] = [];

  constructor(public readonly url: string, public readonly protocols?: string[]) {
    FakeWebSocket.instances.push(this);
  }

  public send(data: string): void {
    this.sent.push(JSON.parse(data) as SentFrame);
  }

  public close(): void {}
}

/** Payload shapes the bridge actually publishes, as the mobile client sees them. */
interface MobileSurface {
  html: string;
  element(id: string): FakeNode;
  screen(): FakeNode;
  strip(): FakeNode;
  banner(): FakeNode;
  bannerText(): FakeNode;
  pills(): FakeNode[];
  pillForTitle(title: string): FakeNode | undefined;
  lastSent(method: string): SentFrame | undefined;
  /** Fire DOMContentLoaded, open the socket, and answer the boot session RPC. */
  open(sessions: unknown[], activeSessionId?: string): Promise<void>;
  emitInitialSessions(sessions: unknown[], activeSessionId?: string): Promise<void>;
  emitSessionBroadcast(payload: Record<string, unknown>): Promise<void>;
  emitDataBroadcast(payload: Record<string, unknown>): Promise<void>;
}

const flush = async (): Promise<void> => {
  await new Promise<void>(resolve => setImmediate(resolve));
  await new Promise<void>(resolve => setImmediate(resolve));
};

function createMobileSurface(): MobileSurface {
  const html = renderMobileRemoteHtml(20129);
  const scriptMatch = /<script>([\s\S]*)<\/script>/.exec(html);
  assert.ok(scriptMatch, 'the mobile document must embed its client script');
  const script = scriptMatch[1]!;

  const elements = new Map<string, FakeNode>();
  for (const idMatch of html.matchAll(/id="([^"]+)"/g)) {
    const id = idMatch[1]!;
    if (!elements.has(id)) elements.set(id, new FakeNode('div', id));
  }
  const element = (id: string): FakeNode => {
    const found = elements.get(id);
    assert.ok(found, `the generated markup must declare #${id}`);
    return found;
  };

  const socketInstances: FakeWebSocket[] = [];
  FakeWebSocket.instances = [];
  const domReadyListeners: Array<() => void> = [];
  const storage = new Map<string, string>([['antifan_mobile_token', 'test-token']]);

  const documentStub = {
    getElementById: (id: string) => elements.get(id) ?? null,
    createElement: (tagName: string) => new FakeNode(tagName),
    addEventListener: () => {},
    removeEventListener: () => {},
    querySelector: () => null,
    querySelectorAll: () => [],
  };
  const windowStub: Record<string, unknown> = {
    document: documentStub,
    location: { hash: '', pathname: '/', hostname: '127.0.0.1' },
    addEventListener: (type: string, listener: () => void) => {
      if (type === 'DOMContentLoaded') domReadyListeners.push(listener);
    },
    removeEventListener: () => {},
  };
  windowStub.window = windowStub;

  class SurfaceWebSocket extends FakeWebSocket {
    constructor(url: string, protocols?: string[]) {
      super(url, protocols);
      socketInstances.push(this);
    }
  }

  const context = vm.createContext({
    window: windowStub,
    document: documentStub,
    sessionStorage: {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => { storage.set(key, String(value)); },
      removeItem: (key: string) => { storage.delete(key); },
    },
    history: { replaceState: () => {} },
    WebSocket: SurfaceWebSocket,
    console,
    // Inert timers: the client's reconnect/rename delays must never fire inside a
    // test, and its RPC deadline is irrelevant once the response is delivered.
    setTimeout: () => 0,
    clearTimeout: () => {},
    fetch: async () => ({ ok: false, json: async () => ({}) }),
    alert: () => {},
    confirm: () => true,
  });
  vm.runInContext(script, context, { filename: 'mobile-remote-inline.js' });
  assert.equal(socketInstances.length, 0, 'the client must not connect before DOMContentLoaded');

  const socket = (): FakeWebSocket => {
    // The client only connects from its DOMContentLoaded handler; any helper that
    // needs the socket first runs that boot path exactly as the browser would.
    if (socketInstances.length === 0) {
      for (const listener of [...domReadyListeners]) listener();
    }
    const ws = socketInstances[0];
    assert.ok(ws, 'the client must open a WebSocket on load');
    return ws;
  };

  const surface: MobileSurface = {
    html,
    element,
    screen: () => element('terminalScreen'),
    strip: () => element('termSessionsStrip'),
    banner: () => element('sleepingBanner'),
    bannerText: () => element('sleepingBannerText'),
    pills: () => surface.strip().children.filter(child => child.className.startsWith('terminal-tab-pill')),
    pillForTitle: (title: string) => surface.pills().find(pill => (pill.title || '').startsWith(title)),
    lastSent: (method: string) => [...socket().sent].reverse().find(frame => frame.method === method),
    open: async (sessions, activeSessionId) => {
      const ws = socket();
      ws.onopen?.();
      const boot = surface.lastSent('antifan.getTerminalSessions');
      assert.ok(boot, 'the client must request terminal sessions on connect');
      ws.onmessage?.({
        data: JSON.stringify({
          id: boot.id,
          success: true,
          data: { sessions, activeSessionId: activeSessionId ?? (sessions[0] as { id?: string } | undefined)?.id },
        }),
      });
      await flush();
    },
    emitInitialSessions: async (sessions, activeSessionId) => {
      socket().onmessage?.({
        data: JSON.stringify({
          type: 'antifan:init',
          data: { terminalSessions: sessions, activeTerminalSessionId: activeSessionId },
        }),
      });
      await flush();
    },
    emitSessionBroadcast: async payload => {
      socket().onmessage?.({ data: JSON.stringify({ type: 'antifan:terminal:session', data: payload }) });
      await flush();
    },
    emitDataBroadcast: async payload => {
      socket().onmessage?.({ data: JSON.stringify({ type: 'antifan:terminal:data', data: payload }) });
      await flush();
    },
  };
  return surface;
}

/**
 * Rendered output of the mobile surface BEFORE the sleep work, captured from this
 * same harness against the unmodified `mobile-remote-html.ts` (set the constant to
 * `null`, run this test once, and it prints the baseline it observed). Frozen here
 * so the ordinary running/closed rendering is proven byte-for-byte unchanged: any
 * drift in the tab strip, the transcript screen, or the append path fails loudly.
 */
interface RunningRenderBaseline {
  bootScreenHtml: string;
  appendedScreenHtml: string;
  broadcastScreenHtml: string;
  bootPillClasses: string[];
}

const PRE_CHANGE_RUNNING_RENDER: RunningRenderBaseline | null = {
  bootScreenHtml: 'PS E:\\Work\\apps\\AntiFan&gt; npm run build\r\nbuilding...\r\n',
  appendedScreenHtml: 'PS E:\\Work\\apps\\AntiFan&gt; npm run build\r\nbuilding...\r\ndone in 4s\r\n',
  broadcastScreenHtml: 'one-live\r\n',
  bootPillClasses: ['terminal-tab-pill active'],
};

test('running/closed sessions render byte-for-byte as before the sleep work', async () => {
  const surface = createMobileSurface();

  // A plain running session, exactly the shape listSessions() publishes.
  const running = {
    id: 'term-1',
    name: 'powershell',
    cwd: 'E:\\Work\\apps\\AntiFan',
    active: true,
    buffer: 'PS E:\\Work\\apps\\AntiFan> npm run build\r\nbuilding...\r\n',
    bufferLength: 51,
    sessionGeneration: 1,
    state: 'running',
    cols: 120,
    rows: 30,
  };
  await surface.open([running], 'term-1');
  const bootScreenHtml = surface.screen().innerHTML;
  const bootPillClasses = surface.pills().map(pill => pill.className);

  await surface.emitDataBroadcast({ sessionId: 'term-1', data: 'done in 4s\r\n', seq: 9 });
  const appendedScreenHtml = surface.screen().innerHTML;

  // A second surface for the `antifan:terminal:session` broadcast shape
  // (getSessionState(): activeSessionId + sessions + snapshot).
  const surface2 = createMobileSurface();
  const twoRunning = [
    { id: 'term-1', name: 'one', buffer: 'one-live\r\n', bufferLength: 10, sessionGeneration: 1, state: 'running' },
    { id: 'term-2', name: 'two', buffer: 'two-live\r\n', bufferLength: 10, sessionGeneration: 1, state: 'running' },
  ];
  await surface2.open(twoRunning, 'term-1');
  await surface2.emitSessionBroadcast({
    activeSessionId: 'term-1',
    sessions: twoRunning,
    snapshot: 'one-live\r\n',
    snapshotThroughSeq: 12,
  });
  const broadcastScreenHtml = surface2.screen().innerHTML;

  if (PRE_CHANGE_RUNNING_RENDER === null) {
    // Re-capture mode: set the constant to null to freeze a fresh baseline.
    console.log('PRE_CHANGE_RUNNING_RENDER=' + JSON.stringify({
      bootScreenHtml,
      appendedScreenHtml,
      broadcastScreenHtml,
      bootPillClasses,
    }));
    return;
  }

  const baseline = PRE_CHANGE_RUNNING_RENDER as RunningRenderBaseline;
  assert.equal(bootScreenHtml, baseline.bootScreenHtml);
  assert.equal(appendedScreenHtml, baseline.appendedScreenHtml);
  assert.equal(broadcastScreenHtml, baseline.broadcastScreenHtml);
  assert.deepEqual(bootPillClasses, baseline.bootPillClasses);
});

/**
 * The sleep contract, as the mobile surface must honour it:
 *  - a sleeping session has no live PTY, so nothing will ever stream into its pane;
 *  - `SessionSummary.buffer` is `composeTranscript(s)`, i.e. the retained transcript;
 *  - `SessionSummary.bufferLength` is the LIVE buffer length and is therefore 0 for a
 *    sleeping session even when a whole transcript is retained. Reading it as a
 *    "has content" test is the exact mistake that renders a sleeping tab blank.
 */
const RETAINED_TRANSCRIPT = 'PS E:\\Work> git status\r\nnothing to commit\r\n';
/**
 * The exact string the frozen contract says a sleeping session serves:
 * composeTranscript(s) = restoredTail + '\r\n── phiên trước ──\r\n' + buffer.
 */
const COMPOSED_SLEEPING_TRANSCRIPT = RETAINED_TRANSCRIPT + '\r\n── phiên trước ──\r\nPS E:\\Work> ';
const SLEEPING_SESSION = {
  id: 'term-sleep',
  name: 'build',
  cwd: 'E:\\Work\\apps\\AntiFan',
  active: true,
  buffer: COMPOSED_SLEEPING_TRANSCRIPT,
  bufferLength: 0,
  sessionGeneration: 4,
  state: 'sleeping',
  sleptAt: 1757900000000,
  cols: 120,
  rows: 30,
};

test('a sleeping session renders its retained transcript instead of a blank pane', async () => {
  const surface = createMobileSurface();
  await surface.open([SLEEPING_SESSION], 'term-sleep');

  const rendered = surface.screen().innerHTML;
  assert.notEqual(rendered, '', 'a sleeping session with a retained transcript must not render blank');
  assert.ok(
    rendered.includes('nothing to commit'),
    `the retained transcript must be on screen, got: ${JSON.stringify(rendered)}`,
  );
  assert.ok(rendered.includes('git status'));
  assert.ok(
    rendered.includes('── phiên trước ──'),
    'the composeTranscript() separator must survive ansiToHtml on the way to the pane',
  );

  // The same must hold for the boot broadcast shape (`antifan:init`).
  const surface2 = createMobileSurface();
  await surface2.emitInitialSessions([SLEEPING_SESSION], 'term-sleep');
  assert.ok(surface2.screen().innerHTML.includes('nothing to commit'));
});

test('a sleeping session is visibly marked as sleeping, not merely empty', async () => {
  const surface = createMobileSurface();
  await surface.open([SLEEPING_SESSION], 'term-sleep');

  const banner = surface.banner();
  assert.ok(banner.classList.contains('visible'), 'the sleeping banner must be shown');
  assert.ok(!banner.classList.contains('no-transcript'), 'a session with a transcript is not the empty case');
  const text = surface.bannerText().textContent;
  assert.match(text, /ngủ/, `the banner must name the sleeping state, got: ${JSON.stringify(text)}`);
  assert.match(text, /transcript/i);

  const pill = surface.pillForTitle('build');
  assert.ok(pill, 'the sleeping tab must still be listed in the strip');
  assert.ok(pill.classList.contains('is-sleeping'), `pill classes: ${pill.className}`);
  const badge = pill.descendants().find(node => node.className === 'tab-sleep-badge');
  assert.ok(badge, 'the sleeping tab pill must carry a sleep badge');
  assert.equal(badge.textContent, '💤');

  // A running tab keeps the untouched pill contract: no sleep class, no badge.
  const runningSurface = createMobileSurface();
  await runningSurface.open(
    [{ id: 'term-run', name: 'live', buffer: 'live\r\n', bufferLength: 6, sessionGeneration: 1, state: 'running' }],
    'term-run',
  );
  const runningPill = runningSurface.pillForTitle('live');
  assert.ok(runningPill);
  assert.equal(runningPill.className, 'terminal-tab-pill active');
  assert.equal(runningPill.descendants().filter(node => node.className === 'tab-sleep-badge').length, 0);
  assert.ok(!runningSurface.banner().classList.contains('visible'));
});

test('a sleeping session whose transcript arrives in a session broadcast is not left blank', async () => {
  const surface = createMobileSurface();
  const running = [
    { id: 'term-a', name: 'alpha', buffer: 'alpha-live\r\n', bufferLength: 11, sessionGeneration: 1, state: 'running' },
    { id: 'term-b', name: 'beta', buffer: 'beta-live\r\n', bufferLength: 10, sessionGeneration: 1, state: 'running' },
  ];
  await surface.open(running, 'term-a');
  assert.equal(surface.screen().innerHTML, 'alpha-live\r\n');
  assert.equal(surface.pillForTitle('alpha')?.className, 'terminal-tab-pill active');

  // term-b is put to sleep while the phone is connected: the manager folds its
  // transcript into the composed buffer and re-publishes the session list. The
  // phone still holds term-b's stale live output and no terminal:data frame will
  // ever arrive again, so the broadcast is the only chance to correct the pane.
  await surface.emitSessionBroadcast({
    activeSessionId: 'term-a',
    sessions: [
      running[0],
      { id: 'term-b', name: 'beta', buffer: 'beta-history\r\n', bufferLength: 0, sessionGeneration: 1, state: 'sleeping', sleptAt: 1757900000001 },
    ],
    snapshot: 'alpha-live\r\n',
    snapshotThroughSeq: 3,
  });

  // Running tab untouched byte-for-byte, and its pane content unchanged.
  assert.equal(surface.pillForTitle('alpha')?.className, 'terminal-tab-pill active');
  assert.equal(surface.screen().innerHTML, 'alpha-live\r\n');

  const sleepingPill = surface.pillForTitle('beta');
  assert.ok(sleepingPill, 'the sleeping tab must still be listed in the strip');

  // Tapping the sleeping tab is a read-only preview: the retained transcript must
  // render, with the sleeping affordance, without inventing anything.
  sleepingPill.onclick?.();
  await flush();
  assert.equal(surface.screen().innerHTML, 'beta-history\r\n');
  assert.ok(sleepingPill.classList.contains('is-sleeping'));
  assert.ok(surface.banner().classList.contains('visible'));
  assert.match(surface.bannerText().textContent, /ngủ/);
  assert.equal(surface.lastSent('antifan.terminalSwitchSession')?.params?.sessionId, 'term-b');
});

test('a sleeping session the phone never streamed still renders its transcript, not a blank pane', async () => {
  const surface = createMobileSurface();
  await surface.open(
    [{ id: 'term-a', name: 'alpha', buffer: 'alpha-live\r\n', bufferLength: 11, sessionGeneration: 1, state: 'running' }],
    'term-a',
  );

  // term-c slept before this phone ever rendered it, so no `terminal:data` frame
  // and no snapshot ever arrived for it. `sessions[].buffer` is the only source.
  await surface.emitSessionBroadcast({
    activeSessionId: 'term-a',
    sessions: [
      { id: 'term-a', name: 'alpha', buffer: 'alpha-live\r\n', bufferLength: 11, sessionGeneration: 1, state: 'running' },
      { id: 'term-c', name: 'gamma', buffer: 'gamma-history\r\n', bufferLength: 0, sessionGeneration: 1, state: 'sleeping', sleptAt: 1757900000002 },
    ],
    snapshot: 'alpha-live\r\n',
    snapshotThroughSeq: 3,
  });

  const sleepingPill = surface.pillForTitle('gamma');
  assert.ok(sleepingPill, 'the sleeping tab must be listed in the strip');
  sleepingPill.onclick?.();
  await flush();

  const pane = surface.screen().innerHTML;
  assert.notEqual(pane, '', 'a sleeping session with a retained transcript must not render blank');
  assert.equal(pane, 'gamma-history\r\n');
  assert.ok(sleepingPill.classList.contains('is-sleeping'));
  assert.ok(surface.banner().classList.contains('visible'));
});

test('a sleeping session with no retained transcript says so instead of showing an empty box', async () => {
  const surface = createMobileSurface();
  await surface.open(
    [{ ...SLEEPING_SESSION, buffer: '', bufferLength: 0 }],
    'term-sleep',
  );

  assert.equal(surface.screen().innerHTML, '', 'there is genuinely nothing to render');
  const banner = surface.banner();
  assert.ok(banner.classList.contains('visible'), 'the sleeping state must still be shown');
  assert.ok(banner.classList.contains('no-transcript'), 'the empty case must be distinguishable from the retained case');
  const text = surface.bannerText().textContent;
  assert.match(text, /ngủ/);
  assert.match(text, /không có transcript/i, `must state the emptiness honestly, got: ${JSON.stringify(text)}`);
  assert.ok(surface.pillForTitle('build')?.classList.contains('is-sleeping'));
});

test('waking a session from the phone clears the sleeping affordance', async () => {
  const surface = createMobileSurface();
  await surface.open([SLEEPING_SESSION], 'term-sleep');
  assert.ok(surface.banner().classList.contains('visible'));

  // The manager wakes on input and re-broadcasts the session as running.
  await surface.emitSessionBroadcast({
    activeSessionId: 'term-sleep',
    sessions: [{ ...SLEEPING_SESSION, state: 'running' }],
    snapshot: RETAINED_TRANSCRIPT,
    snapshotThroughSeq: 7,
  });

  assert.ok(!surface.banner().classList.contains('visible'), 'the sleeping banner must hide once the shell is back');
  assert.equal(surface.bannerText().textContent, '');
  assert.equal(surface.pillForTitle('build')?.className, 'terminal-tab-pill active');
  assert.ok(surface.screen().innerHTML.includes('nothing to commit'));
});
