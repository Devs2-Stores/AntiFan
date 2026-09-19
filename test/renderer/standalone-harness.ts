/**
 * Shared harness for driving `src/renderer/standalone.js` under Node.
 *
 * The renderer is a plain browser script with no module boundary, so tests load it into a vm
 * context whose DOM, xterm, and preload-bridge surfaces are stubbed. Everything the renderer
 * itself contains (chunk state machine, split geometry, context menu, key handlers) then runs
 * as shipped code; only the platform boundaries are fake.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vm from 'node:vm';

/**
 * Locate the shipped renderer relative to the compiled harness.
 *
 * Walking up beats a fixed `../../../src` hop: the harness is also compiled into
 * isolated build directories (e.g. `node_modules/.cache/tsc-wsf/...`) whose depth
 * differs from the default `.compiled/`, and a fixed hop would silently load a
 * non-existent path.
 */
function resolveStandalonePath(): string {
  let dir = __dirname;
  for (let depth = 0; depth < 8; depth += 1) {
    const candidate = path.join(dir, 'src', 'renderer', 'standalone.js');
    if (fs.existsSync(candidate)) return candidate;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return path.resolve(__dirname, '..', '..', '..', 'src', 'renderer', 'standalone.js');
}

export const STANDALONE_PATH = resolveStandalonePath();

/** Directory holding the shipped renderer assets (standalone.js/html/css). */
export const RENDERER_DIR = path.dirname(STANDALONE_PATH);

export type SyncState = 'READY' | 'GAPPED' | 'RESYNCING' | 'DEGRADED';

export interface Chunk {
  seq: number;
  generation: number;
  data: string;
}

export interface DeltaResult {
  status: string;
  chunks?: Array<{ seq: number; data: string }>;
  currentGeneration?: number;
}

export interface StandaloneApi {
  getTerminalDelta: (sessionId: string, generation: number, fromSeq: number) => Promise<DeltaResult | null>;
  splitTerminal: (sessionId: string, geometry: { cols: number; rows: number }) => Promise<string>;
  unsplitTerminal: (sessionId: string) => Promise<unknown>;
  syncTerminalView: (payload: unknown) => Promise<unknown>;
  getFullBuffer: (sessionId: string) => Promise<unknown>;
  resizeTerminalTo: (sessionId: string, cols: number, rows: number) => void;
  [key: string]: unknown;
}

export interface SplitGeometry {
  usable: number;
  paneMin: number;
  dividerTotal: number;
  dividerHeight: number;
  dividerMarginTop: number;
  dividerMarginBottom: number;
  contentTopOffset: number;
}

export interface KeyEventLike {
  key: string;
  type?: string;
  keyCode?: number;
  ctrlKey?: boolean;
  metaKey?: boolean;
  shiftKey?: boolean;
  altKey?: boolean;
  /** Pointer fields: the same stub also dispatches pointerdown/move/up events. */
  pointerId?: number;
  clientX?: number;
  clientY?: number;
  preventDefault: () => void;
  stopPropagation: () => void;
  target?: unknown;
  clipboardData?: { getData: (type: string) => string };
  /** Drag & drop payload used by the tab reorder handlers. */
  dataTransfer?: {
    getData: (type: string) => string;
    setData: (type: string, value: string) => void;
    effectAllowed?: string;
    dropEffect?: string;
  };
}

/**
 * Inline style stub. Declared fields cover every property the renderer assigns
 * directly; `setProperty`/`getPropertyValue` cover CSS custom properties (the tab
 * sidebar width is published as `--term-sidebar-w`), which cannot be plain fields.
 */
export class FakeStyle {
  public cssText = '';
  public flex = '';
  public height = '';
  public minHeight = '';
  public maxHeight = '';
  public display = '';
  public width = '';
  public left = '';
  public top = '';
  public cursor = '';
  public userSelect = '';
  public pointerEvents = '';
  public background = '';
  public color = '';
  private readonly customProps = new Map<string, string>();

  public setProperty(name: string, value: string): void {
    if (name.startsWith('--')) {
      this.customProps.set(name, String(value));
      return;
    }
    (this as unknown as Record<string, string>)[name] = String(value);
  }

  public getPropertyValue(name: string): string {
    if (name.startsWith('--')) return this.customProps.get(name) ?? '';
    return (this as unknown as Record<string, string>)[name] ?? '';
  }

  public removeProperty(name: string): void {
    this.customProps.delete(name);
  }
}

export class FakeElement {
  public innerHTML = '';
  public textContent = '';
  public title = '';
  public value = '';
  public draggable = false;
  public style = new FakeStyle();
  public tabIndex = -1;
  public parent: FakeElement | null = null;
  public readonly children: FakeElement[] = [];
  public clientHeight = 400;
  public clientWidth = 800;
  public clientTop = 0;
  public offsetHeight = 7;
  public onclick: (() => unknown) | null = null;
  public disabled = false;
  public readonly attributes: Record<string, string> = {};
  public readonly listeners: Record<string, Array<(event: KeyEventLike) => void>> = {};
  private readonly classes = new Set<string>();

  constructor(public readonly tagName: string, public readonly elementId = '') {}

  public get className(): string {
    return [...this.classes].join(' ');
  }

  public set className(value: string) {
    this.classes.clear();
    for (const name of value.split(/\s+/).filter(Boolean)) this.classes.add(name);
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

  /** Real-DOM alias the renderer may rely on for parent checks. */
  public get parentNode(): FakeElement | null {
    return this.parent;
  }

  public get firstChild(): FakeElement | null {
    return this.children[0] ?? null;
  }

  public get lastChild(): FakeElement | null {
    return this.children[this.children.length - 1] ?? null;
  }

  /**
   * Mirrors the DOM: re-appending an existing child MOVES it to the end instead
   * of duplicating it. Without this, a re-render would grow `children` forever
   * and every `querySelectorAll` would return the same node many times.
   */
  public appendChild<T extends FakeElement>(child: T): T {
    if (child.parent && child.parent !== this) {
      child.parent.removeChild(child);
    } else {
      const existing = this.children.indexOf(child);
      if (existing >= 0) this.children.splice(existing, 1);
    }
    child.parent = this;
    this.children.push(child);
    return child;
  }

  public append(...nodes: FakeElement[]): void {
    for (const node of nodes) this.appendChild(node);
  }

  /** Mirrors Node.insertBefore, including the `null` reference = append case. */
  public insertBefore<T extends FakeElement>(node: T, reference: FakeElement | null): T {
    if (!reference) return this.appendChild(node);
    if (node.parent && node.parent !== this) {
      node.parent.removeChild(node);
    } else {
      const existing = this.children.indexOf(node);
      if (existing >= 0) this.children.splice(existing, 1);
    }
    node.parent = this;
    const index = this.children.indexOf(reference);
    if (index < 0) this.children.push(node);
    else this.children.splice(index, 0, node);
    return node;
  }

  public removeChild(child: FakeElement): void {
    const index = this.children.indexOf(child);
    if (index >= 0) this.children.splice(index, 1);
    child.parent = null;
  }

  public remove(): void {
    this.parent?.removeChild(this);
  }

  public querySelector(selector: string): FakeElement | null {
    const wantsLast = selector.includes(':last-child');
    const base = selector.replace(':last-child', '');
    const matches = this.descendants().filter(element => element.matches(base));
    return (wantsLast ? matches[matches.length - 1] : matches[0]) ?? null;
  }

  public querySelectorAll(selector: string): FakeElement[] {
    const base = selector.replace(':last-child', '');
    return this.descendants().filter(element => element.matches(base));
  }

  public matches(selector: string): boolean {
    const compound = selector.replace(':last-child', '').split(/(?=[.#[])/).filter(Boolean);
    return compound.every(part => {
      if (part.startsWith('.')) return this.classes.has(part.slice(1));
      if (part.startsWith('#')) return this.elementId === part.slice(1);
      if (part.startsWith('[')) {
        const attribute = /^\[([\w-]+)(?:=["']?([^"'\]]*)["']?)?\]$/.exec(part);
        if (!attribute) return false;
        const [, name, expected] = attribute;
        const actual = this.attributes[name!];
        return expected === undefined ? actual !== undefined : actual === expected;
      }
      return this.tagName === part;
    });
  }

  public addEventListener(type: string, listener: (event: KeyEventLike) => void): void {
    (this.listeners[type] ??= []).push(listener);
  }

  public removeEventListener(type: string, listener: (event: KeyEventLike) => void): void {
    const list = this.listeners[type];
    if (!list) return;
    this.listeners[type] = list.filter(entry => entry !== listener);
  }

  public dispatch(type: string, event: Partial<KeyEventLike> = {}): void {
    const payload: KeyEventLike = {
      key: '',
      preventDefault: () => {},
      stopPropagation: () => {},
      ...event,
    };
    for (const listener of [...(this.listeners[type] ?? [])]) listener(payload);
    // A real dispatch invokes the inline handler too, and the renderer mixes the
    // two styles (`onclick = ...` on menu rows, addEventListener elsewhere).
    const inline = (this as unknown as Record<string, unknown>)[`on${type}`];
    if (typeof inline === 'function') (inline as (event: KeyEventLike) => void)(payload);
  }

  public setAttribute(name: string, value: string): void {
    this.attributes[name] = value;
    if (name === 'id') this.attributes.id = value;
  }

  public getAttribute(name: string): string | null {
    return this.attributes[name] ?? null;
  }

  public removeAttribute(name: string): void {
    delete this.attributes[name];
  }

  public contains(node: unknown): boolean {
    if (node === this) return true;
    return this.descendants().includes(node as FakeElement);
  }

  public focus(): void {}
  public blur(): void {}
  public click(): void {
    this.onclick?.();
    this.dispatch('click');
  }

  public getBoundingClientRect() {
    return { width: 185, height: 175, top: 40, left: 60, right: 245, bottom: 215 };
  }

  private descendants(): FakeElement[] {
    const found: FakeElement[] = [];
    for (const child of this.children) {
      found.push(child, ...child.descendants());
    }
    return found;
  }
}

export class FakeTerm {
  public readonly writes: string[] = [];
  public resetCount = 0;
  public scrollToBottomCount = 0;
  public cols = 120;
  public rows = 30;

  public write(data: string, callback?: () => void): void {
    this.writes.push(data);
    callback?.();
  }

  public reset(): void {
    this.resetCount += 1;
  }

  public scrollToBottom(): void {
    this.scrollToBottomCount += 1;
  }

  public focus(): void {}
  public clear(): void {}
  public refresh(): void {}
  public resize(cols: number, rows: number): void {
    this.cols = cols;
    this.rows = rows;
  }
}

/** Minimal xterm terminal: records custom key handlers so shortcut routing can be driven. */
export class FakeTerminal {
  public cols = 120;
  public rows = 30;
  public readonly writes: string[] = [];
  public readonly element = new FakeElement('div');
  public readonly buffer = { active: { viewportY: 0, baseY: 0 } };
  public customKeyHandler: ((event: KeyEventLike) => boolean) | null = null;
  public readonly addons: unknown[] = [];

  constructor(public readonly options: Record<string, unknown> = {}) {}

  public loadAddon(addon: unknown): void {
    this.addons.push(addon);
  }

  public open(): void {}
  public onData(): { dispose: () => void } { return { dispose: () => {} }; }
  public onScroll(): { dispose: () => void } { return { dispose: () => {} }; }
  public attachCustomKeyEventHandler(handler: (event: KeyEventLike) => boolean): void {
    this.customKeyHandler = handler;
  }
  public write(data: string, callback?: () => void): void {
    this.writes.push(data);
    callback?.();
  }
  public reset(): void {}
  public dispose(): void {}
  public focus(): void {}
  public clear(): void {}
  public refresh(): void {}
  public scrollToBottom(): void {}
  public hasSelection(): boolean { return false; }
  public getSelection(): string { return ''; }
  public clearSelection(): void {}
  public resize(cols: number, rows: number): void {
    this.cols = cols;
    this.rows = rows;
  }
}

export class FakeFitAddon {
  public proposeDimensions(): { cols: number; rows: number } { return { cols: 120, rows: 30 }; }
  public dispose(): void {}
  public fit(): void {}
}

export interface StandaloneHarness {
  api: StandaloneApi;
  apiCalls: string[];
  /** Same calls as `apiCalls`, with their arguments, for payload assertions. */
  apiCallArgs: Array<{ name: string; args: unknown[] }>;
  elements: Map<string, FakeElement>;
  terminals: FakeTerminal[];
  webLinksHandlers: Array<(event: unknown, uri: string) => void>;
  container: FakeElement;
  mainPane: FakeElement;
  splitButton: FakeElement;
  contextMenu: FakeElement;
  standaloneRoot: FakeElement;
  tabLayoutButton: FakeElement;
  tabSidebarResizer: FakeElement;
  tabsRoot: FakeElement;
  windowKeydownListeners: Array<(event: KeyEventLike) => boolean | void>;
  documentKeydownListeners: Array<(event: KeyEventLike) => boolean | void>;
  assign(expression: string): void;
  read<T>(expression: string): T;
  processIncomingChunk: (viewState: unknown, chunk: Chunk, isSplit: boolean) => Promise<void>;
  terminalDataListeners: Array<(payload: unknown) => void>;
  terminalSessionListeners: Array<(state: unknown) => void>;
  getSplitGeometry: () => SplitGeometry;
  applySplitRatio: (ratio?: number, resizePty?: boolean) => void;
  mountSplit: (sessionId: string, snapshot?: string, snapshotSeq?: number) => void;
  unmountSplit: () => void;
  showContextMenu: (event: KeyEventLike & { clientX: number; clientY: number }, sessionId: string) => void;
  maxQueueBytes: number;
  maxQueueChunks: number;
  /** Search the whole stubbed document, like `document.querySelectorAll`. */
  queryAll(selector: string): FakeElement[];
  /** Push a session broadcast through the renderer's `onTerminalSession` listener. */
  emitSession(state: unknown): void;
  /** Push a terminal data payload through the renderer's `onTerminalData` listener. */
  emitData(payload: unknown): void;
  /** Replace the renderer's live `sessions` array (plain data only). */
  setSessions(list: unknown[]): void;
  getSessions(): Array<Record<string, unknown>>;
  setActiveId(id: string): void;
  getActiveId(): string;
  renderTabs: () => void;
  syncTerminalPool: (allSessions: unknown[], currentActiveId: string, snapshot?: string, snapshotThroughSeq?: number) => void;
  updateAffinityBadges: (deliveredTabs?: unknown[]) => Promise<void>;
  /** The read-only transcript preview mounted for a sleeping active session. */
  sleepPreview(): FakeElement | null;
  showCategoryPicker: (sessionId: string, anchorEl: FakeElement) => void;
  showAffinityPicker: (sessionId: string, anchorEl: FakeElement) => Promise<void>;
}

function computedStyle(): Record<string, string> {
  return new Proxy({}, {
    get: (_target, property) => (property === 'getPropertyValue' ? () => '' : ''),
  }) as Record<string, string>;
}

export function loadStandalone(options: { initialState?: unknown; contextMenuActions?: string[] } = {}): StandaloneHarness {
  const elements = new Map<string, FakeElement>();
  const elementById = (id: string): FakeElement => {
    if (!elements.has(id)) elements.set(id, new FakeElement('div', id));
    return elements.get(id)!;
  };

  // The renderer captures element references at load time, so the tab-layout
  // nodes must exist before the script runs. The tree mirrors standalone.html:
  //   main.standalone > section.controls > #terminalTabs
  //                   > #tabsSidebarResizer
  //                   > #terminal
  const standaloneElement = new FakeElement('main');
  standaloneElement.className = 'standalone';
  const controlsElement = new FakeElement('section');
  controlsElement.className = 'controls';
  standaloneElement.appendChild(controlsElement);
  const tabsRootElement = elementById('terminalTabs');
  controlsElement.appendChild(tabsRootElement);
  const tabSidebarResizerElement = elementById('tabsSidebarResizer');
  standaloneElement.appendChild(tabSidebarResizerElement);
  standaloneElement.appendChild(elementById('terminal'));
  standaloneElement.appendChild(elementById('terminal-main'));

  // Context-menu rows must exist before the script runs: the renderer binds its
  // single delegated click handler to whatever `.context-item`s are present at
  // load time (exactly as standalone.html provides them).
  const contextMenuElement = elementById('tabContextMenu');
  for (const action of options.contextMenuActions ?? []) {
    const item = new FakeElement('div');
    item.className = 'context-item';
    item.setAttribute('data-action', action);
    item.appendChild(new FakeElement('span'));
    contextMenuElement.appendChild(item);
  }
  standaloneElement.appendChild(elementById('affinityPickerPopover'));
  standaloneElement.appendChild(elementById('categoryPickerPopover'));
  const tabLayoutButtonElement = elementById('btnTerminalTabLayout');

  const documentKeydownListeners: Array<(event: KeyEventLike) => boolean | void> = [];
  const documentStub = {
    getElementById: elementById,
    createElement: (tagName: string) => new FakeElement(tagName),
    createTextNode: (text: string) => ({ textContent: text }),
    body: new FakeElement('body', 'body'),
    documentElement: new FakeElement('html', 'html'),
    head: new FakeElement('head', 'head'),
    addEventListener: (type: string, listener: (event: KeyEventLike) => boolean | void) => {
      if (type === 'keydown') documentKeydownListeners.push(listener);
    },
    removeEventListener: (type: string, listener: (event: KeyEventLike) => boolean | void) => {
      if (type !== 'keydown') return;
      const index = documentKeydownListeners.indexOf(listener);
      if (index >= 0) documentKeydownListeners.splice(index, 1);
    },
    querySelector: (selector: string) => (selector === '.standalone' ? standaloneElement : standaloneElement.querySelector(selector)),
    querySelectorAll: (selector: string) => standaloneElement.querySelectorAll(selector),
    readyState: 'complete',
    hidden: false,
  };

  const windowKeydownListeners: Array<(event: KeyEventLike) => boolean | void> = [];
  const terminals: FakeTerminal[] = [];
  const webLinksHandlers: Array<(event: unknown, uri: string) => void> = [];
  const windowStub: Record<string, unknown> = {
    document: documentStub,
    location: { search: '', href: 'file:///standalone.html', origin: 'file://' },
    innerWidth: 1440,
    innerHeight: 900,
    addEventListener: (type: string, listener: (event: KeyEventLike) => boolean | void) => {
      if (type === 'keydown') windowKeydownListeners.push(listener);
    },
    removeEventListener: () => {},
    requestAnimationFrame: (callback: (time: number) => void) => setTimeout(() => callback(Date.now()), 0),
    cancelAnimationFrame: () => {},
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    queueMicrotask,
    localStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
    navigator: { clipboard: { writeText: async () => {} }, userAgent: 'node' },
    matchMedia: () => ({ matches: false, addEventListener: () => {}, removeEventListener: () => {} }),
    getComputedStyle: () => computedStyle(),
  };
  windowStub.window = windowStub;
  const terminalDataListeners: Array<(payload: unknown) => void> = [];
  const terminalSessionListeners: Array<(state: unknown) => void> = [];
  const bridgeTarget: Record<string, unknown> = {
    getTerminalDelta: async () => null,
    splitTerminal: async () => '',
    unsplitTerminal: async () => undefined,
    syncTerminalView: async () => null,
    getFullBuffer: async () => null,
    // Per-id affinity is deliberately a no-op that still records the call, so a
    // test can prove the bulk `getTerminalAffinities` path replaced the N+1 loop.
    getTerminalAffinity: async () => undefined,
    getTerminalAffinities: async () => ({} as Record<string, unknown>),
    sleepTerminal: async () => true,
    wakeTerminal: async () => true,
    focusTab: async () => undefined,
    setCategory: async () => true,
    // Boot payload for the sidebar/tab-layout prefs, as GET_INITIAL_STATE returns it.
    getInitialState: async () => options.initialState,
    // Capture push-channel listeners so tests can drive the data/session flow.
    onTerminalData: (listener: (payload: unknown) => void) => { terminalDataListeners.push(listener); },
    onTerminalSession: (listener: (state: unknown) => void) => { terminalSessionListeners.push(listener); },
  };
  // The renderer wires its whole preload bridge at load time, so unimplemented members are no-ops.
  // Every invocation is recorded so a test can prove which bridge calls a flow actually made.
  const apiCalls: string[] = [];
  const apiCallArgs: Array<{ name: string; args: unknown[] }> = [];
  const recordCall = (name: string, fn: (...args: unknown[]) => unknown) =>
    (...args: unknown[]): unknown => {
      apiCalls.push(name);
      apiCallArgs.push({ name, args });
      return fn(...args);
    };
  const api = new Proxy(bridgeTarget, {
    get: (target, property) => {
      if (typeof property !== 'string') return () => undefined;
      if (property in target) {
        const member = target[property];
        return typeof member === 'function'
          ? recordCall(property, member as (...args: unknown[]) => unknown)
          : member;
      }
      return recordCall(property, () => undefined);
    },
    set: (target, property, value) => {
      target[String(property)] = value;
      return true;
    },
  }) as unknown as StandaloneApi;
  windowStub.antifanStandalone = api;

  class TerminalGlobal extends FakeTerminal {
    constructor(options: Record<string, unknown> = {}) {
      super(options);
      terminals.push(this);
    }
  }
  class FitAddonGlobal extends FakeFitAddon {}
  type LinkHandler = (event: unknown, uri: string) => void;
  class WebLinksAddonGlobal {
    constructor(public readonly handler: LinkHandler) {
      webLinksHandlers.push(this.handler);
    }
    public dispose(): void {}
  }
  windowStub.WebLinksAddon = { WebLinksAddon: WebLinksAddonGlobal };

  const context = vm.createContext({
    window: windowStub,
    document: documentStub,
    console,
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    queueMicrotask,
    requestAnimationFrame: windowStub.requestAnimationFrame,
    cancelAnimationFrame: windowStub.cancelAnimationFrame,
    URLSearchParams,
    URL,
    TextEncoder,
    TextDecoder,
    Buffer,
    performance,
    crypto: { randomUUID: () => `renderer-test-${terminals.length}` },
    Terminal: TerminalGlobal,
    FitAddon: { FitAddon: FitAddonGlobal },
  });

  vm.runInContext(fs.readFileSync(STANDALONE_PATH, 'utf8'), context, { filename: 'standalone.js' });

  const read = <T>(expression: string): T => vm.runInContext(expression, context) as T;

  return {
    api,
    apiCalls,
    apiCallArgs,
    elements,
    terminals,
    webLinksHandlers,
    container: elementById('terminal'),
    mainPane: elementById('terminal-main'),
    splitButton: elementById('btnSplitTerminal'),
    contextMenu: elementById('tabContextMenu'),
    standaloneRoot: standaloneElement,
    tabLayoutButton: tabLayoutButtonElement,
    tabSidebarResizer: tabSidebarResizerElement,
    tabsRoot: tabsRootElement,
    windowKeydownListeners,
    documentKeydownListeners,
    assign: (expression: string) => {
      vm.runInContext(expression, context);
    },
    read,
    processIncomingChunk: read<StandaloneHarness['processIncomingChunk']>('processIncomingChunk').bind(null) as StandaloneHarness['processIncomingChunk'],
    terminalDataListeners,
    terminalSessionListeners,
    getSplitGeometry: read<StandaloneHarness['getSplitGeometry']>('getSplitGeometry'),
    applySplitRatio: read<StandaloneHarness['applySplitRatio']>('applySplitRatio'),
    mountSplit: read<StandaloneHarness['mountSplit']>('mountSplit'),
    unmountSplit: read<StandaloneHarness['unmountSplit']>('unmountSplit'),
    showContextMenu: read<StandaloneHarness['showContextMenu']>('showContextMenu'),
    maxQueueBytes: read<number>('MAX_RECOVERY_QUEUE_BYTES'),
    maxQueueChunks: read<number>('MAX_RECOVERY_QUEUE_CHUNKS'),
    queryAll: (selector: string) => standaloneElement.querySelectorAll(selector),
    emitSession: (state: unknown) => {
      for (const listener of [...terminalSessionListeners]) listener(state);
    },
    emitData: (payload: unknown) => {
      for (const listener of [...terminalDataListeners]) listener(payload);
    },
    setSessions: (list: unknown[]) => {
      vm.runInContext(`sessions = ${JSON.stringify(list)};`, context);
    },
    getSessions: () => read<Array<Record<string, unknown>>>('sessions'),
    setActiveId: (id: string) => {
      vm.runInContext(`activeId = ${JSON.stringify(id)};`, context);
    },
    getActiveId: () => read<string>('activeId'),
    renderTabs: read<StandaloneHarness['renderTabs']>('renderTabs'),
    syncTerminalPool: read<StandaloneHarness['syncTerminalPool']>('syncTerminalPool'),
    updateAffinityBadges: read<StandaloneHarness['updateAffinityBadges']>('updateAffinityBadges'),
    sleepPreview: () => read<FakeElement | null>('sleepPreviewEl'),
    showCategoryPicker: read<StandaloneHarness['showCategoryPicker']>('showCategoryPicker'),
    showAffinityPicker: read<StandaloneHarness['showAffinityPicker']>('showAffinityPicker'),
  };
}

/** A view state shaped like the renderer's own pane records. */
export function createViewState(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'test-s1',
    term: new FakeTerm(),
    paneEl: new FakeElement('div', 'pane-test-s1'),
    lastRenderedSeq: 0,
    sessionGeneration: 1,
    hydrationEpoch: 0,
    activeHydratingEpoch: null,
    liveQueue: [],
    syncState: 'READY' as SyncState,
    isFetchingDelta: false,
    pendingWriteAckSeq: 0,
    lastAckedSeq: 0,
    gapCount: 0,
    resyncCount: 0,
    degradedCount: 0,
    isUserScrolledUp: false,
    writeTarget: null,
    ...overrides,
  };
}

export function deltaChunks(from: number, to: number): Array<{ seq: number; data: string }> {
  return Array.from({ length: to - from + 1 }, (_unused, offset) => ({ seq: from + offset, data: `delta-${from + offset}` }));
}
