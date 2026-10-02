/**
 * Session Pet: one small always-on-top window that mirrors terminal-session
 * activity so a finished or waiting chat surfaces even when the Terminal
 * Manager is closed.
 *
 * - It is an auxiliary BrowserWindow, not a project shell: it never enters
 *   `browserShellCount`, the close coordinator's surface list, or window-owner
 *   routing. Closing it ends nothing but itself; quit semantics are unchanged.
 * - State comes from `SessionActivityTracker` — the same classifier the tab
 *   strip uses — fed straight from TerminalManager events, so it works in both
 *   in-process and daemon modes (the proxy re-emits the same event names).
 * - The window is chromeless: every gesture is a `PET_CHANNELS.ACTION` message
 *   accepted only from its own webContents, and every repaint is a pushed
 *   `PET_CHANNELS.STATE` snapshot.
 */
import { BrowserWindow, Menu, ipcMain, screen } from 'electron';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { SessionActivityTracker, sessionActivityLevel, type SessionActivityLevel, type TimerHandle } from '../../shared/session-activity';
import { PET_CHANNELS, type PetSessionRow, type PetStatePush } from '../../shared/contracts';
import { TerminalManager } from './terminal-manager';
import { safeSendWebContents } from './web-contents-guard';
import { StorageLocations } from '../config/storage-locations';

const PET_WIDTH = 176;
const PET_HEIGHT = 176;

interface PetPersistedState {
  enabled?: boolean;
  pinned?: boolean;
  x?: number;
  y?: number;
}

export interface PetWindowDeps {
  /** Asset resolvers, same convention as project-window-shell's. */
  rendererFile(fileName: string): string;
  preloadFile(fileName: string): string;
  /** What a click on the pet means: surface the shared Terminal Manager. */
  openTerminalManager(): void;
  /**
   * Fired after enabled flips so the caller can refresh surfaces that render
   * the state (the app menu's Session Pet checkbox drifts otherwise when the
   * pet's own context menu hides it).
   */
  onEnabledChanged?(): void;
  /**
   * Authoritative run-state cards (`waiting_user` from the agent's run file).
   * PTY-output heuristics miss TUI prompts whose last line is a hint bar, so
   * the pet waits on this, not on tail regexes.
   */
  getRunCards?(): Array<{ terminalSessionId: string; state: string }>;
  /** Subscribe to run-card changes; returns an unsubscribe. */
  onRunCardsChange?(listener: () => void): void | (() => void);
}

interface PetActionPayload {
  action?: unknown;
  pinned?: unknown;
}

interface TerminalDataLike {
  sessionId?: unknown;
  data?: unknown;
}
interface TerminalSessionIdLike {
  sessionId?: unknown;
}

interface TerminalClosedLike {
  id?: unknown;
  sessionId?: unknown;
}

interface TerminalListLike {
  id?: unknown;
  name?: unknown;
  state?: unknown;
}

/** Daemon proxies may differ structurally; reads go through `in` narrowing. */
function asEmitter(candidate: unknown): NodeJS.EventEmitter | undefined {
  if (candidate && typeof candidate === 'object' && 'on' in candidate && 'removeListener' in candidate) {
    const emitter = candidate as { on: unknown; removeListener: unknown };
    if (typeof emitter.on === 'function' && typeof emitter.removeListener === 'function') {
      return candidate as NodeJS.EventEmitter;
    }
  }
  return undefined;
}

function readPersisted(file: string): PetPersistedState {
  try {
    const raw: unknown = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (raw && typeof raw === 'object') {
      const out: PetPersistedState = {};
      if ('enabled' in raw && typeof raw.enabled === 'boolean') out.enabled = raw.enabled;
      if ('pinned' in raw && typeof raw.pinned === 'boolean') out.pinned = raw.pinned;
      if ('x' in raw && typeof raw.x === 'number') out.x = raw.x;
      if ('y' in raw && typeof raw.y === 'number') out.y = raw.y;
      return out;
    }
  } catch {}
  return {};
}

export class PetWindowController {
  private readonly stateFile: string;
  private window: BrowserWindow | null = null;
  private readonly tracker: SessionActivityTracker;
  private enabled: boolean;
  private readonly runCardsReleases: Array<() => void> = [];
  private pinned: boolean;
  private pushTimer: TimerHandle | null = null;
  private persistedBounds: PetPersistedState;
  private readonly listeners: Array<{ event: string; handler: (...args: unknown[]) => void }> = [];

  private readonly onAction = (event: Electron.IpcMainEvent, payload: unknown): void => {
    // Only the pet's own webContents may drive it: the channel is unscoped, so
    // any other sender (a page, another surface) is ignored outright.
    if (!this.window || this.window.isDestroyed() || event.sender.id !== this.window.webContents.id) return;
    const p: PetActionPayload = payload && typeof payload === 'object' ? payload : {};
    switch (p.action) {
      case 'open-manager':
        this.deps.openTerminalManager();
        break;
      case 'set-pinned':
        this.setPinned(p.pinned === true);
        break;
      case 'hide':
        this.setEnabled(false);
        break;
      case 'context-menu':
        this.popupMenu();
        break;
      default:
        break;
    }
  };

  constructor(private readonly deps: PetWindowDeps) {
    this.stateFile = path.join(StorageLocations.getConfigDir(), 'session-pet.json');
    const persisted = readPersisted(this.stateFile);
    this.enabled = persisted.enabled !== false;
    this.pinned = persisted.pinned !== false;
    this.persistedBounds = persisted;

    this.tracker = new SessionActivityTracker(() => this.schedulePush());
    const manager = asEmitter(this.terminalSeam());
    if (manager) {
      const wire = (event: string, handler: (...args: unknown[]) => void): void => {
        manager.on(event, handler);
        this.listeners.push({ event, handler });
      };
      wire('data', (payload: unknown) => {
        // PTY output is the hot path: with the pet off there is no consumer, so
        // the classification work (regex/ANSI scans per chunk) is pure waste.
        // Re-enable re-seeds from session state, so no signal is lost.
        if (!this.enabled) return;
        let sessionId: unknown;
        let data: unknown;
        if (typeof payload === 'string') {
          sessionId = this.activeSessionId();
          data = payload;
        } else if (payload && typeof payload === 'object') {
          const p: TerminalDataLike = payload;
          sessionId = p.sessionId;
          data = p.data;
        }
        if (typeof sessionId === 'string' && typeof data === 'string') {
          this.tracker.ingest(sessionId, data);
        }
      });
      wire('exit', (payload: unknown) => {
        if (payload && typeof payload === 'object' && 'sessionId' in payload) {
          const p: TerminalSessionIdLike = payload;
          if (typeof p.sessionId === 'string') this.tracker.noteExited(p.sessionId);
        }
      });
      wire('session-closed', (payload: unknown) => {
        if (payload && typeof payload === 'object') {
          const p: TerminalClosedLike = payload;
          const id = p.id ?? p.sessionId;
          if (typeof id === 'string') this.tracker.noteClosed(id);
        }
        this.schedulePush();
      });
      wire('session', () => this.schedulePush());
      wire('session-created', () => this.schedulePush());
      wire('session-restarted', () => this.schedulePush());
      wire('session-woken', () => this.schedulePush());
      // A daemon reconnect re-fetches getSessionState: resync presence levels.
      wire('reconnected', () => this.schedulePush());
      // Sessions that predate this controller never emitted a chunk on this
      // process — hydrate their rows from the daemon's session list now.
      this.syncSessionState();
    }

    // Authoritative wait signal: a run card in `waiting_user` marks the
    // session even when zero PTY bytes classified (TUI ask panels end on a
    // hint bar, not a question mark). Repaint on every card change; the fold
    // itself runs inside syncSessionState at the head of each push.
    if (this.deps.onRunCardsChange) {
      const release = this.deps.onRunCardsChange(() => this.schedulePush());
      if (typeof release === 'function') this.runCardsReleases.push(release);
    }

    ipcMain.on(PET_CHANNELS.ACTION, this.onAction);
    if (this.enabled) this.show();
  }

  /** The singleton may be the in-process manager or the daemon proxy facade. */
  private terminalSeam(): unknown {
    try {
      return TerminalManager.getInstance();
    } catch {
      return undefined;
    }
  }

  private activeSessionId(): string {
    const seam = this.terminalSeam();
    if (seam && typeof seam === 'object' && 'getActiveSessionId' in seam) {
      const candidate = (seam as { getActiveSessionId: unknown }).getActiveSessionId;
      if (typeof candidate === 'function') {
        const id = (candidate as () => unknown).call(seam);
        return typeof id === 'string' ? id : '';
      }
    }
    return '';
  }

  public isEnabled(): boolean {
    return this.enabled;
  }

  public isPinned(): boolean {
    return this.pinned;
  }

  public setPinned(pinned: boolean): void {
    this.pinned = pinned;
    this.persist();
    try {
      this.window?.setAlwaysOnTop(pinned, 'screen-saver');
    } catch {}
  }

  public setEnabled(enabled: boolean): void {
    if (enabled === this.enabled) return;
    this.enabled = enabled;
    this.persist();
    if (enabled) {
      this.show();
      this.pushNow();
    } else {
      this.window?.destroy();
      this.window = null;
    }
    try { this.deps.onEnabledChanged?.(); } catch {}
  }

  public toggle(): boolean {
    this.setEnabled(!this.enabled);
    return this.enabled;
  }

  private show(): void {
    if (this.window && !this.window.isDestroyed()) {
      this.window.showInactive();
      return;
    }
    const bounds = this.initialBounds();
    const win = new BrowserWindow({
      width: PET_WIDTH,
      height: PET_HEIGHT,
      x: bounds.x,
      y: bounds.y,
      frame: false,
      transparent: true,
      resizable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      skipTaskbar: true,
      alwaysOnTop: this.pinned,
      show: false,
      autoHideMenuBar: true,
      webPreferences: {
        preload: this.deps.preloadFile('pet-preload.js'),
        contextIsolation: true,
        sandbox: false,
        nodeIntegration: false,
      },
    });
    try {
      win.setAlwaysOnTop(this.pinned, 'screen-saver');
    } catch {}
    win.setMenuBarVisibility(false);
    this.window = win;
    win.once('ready-to-show', () => {
      if (!win.isDestroyed()) win.showInactive();
    });
    win.webContents.once('did-finish-load', () => this.pushNow());
    win.on('closed', () => {
      if (this.window === win) this.window = null;
    });
    win.on('moved', () => {
      if (win.isDestroyed()) return;
      const [x, y] = win.getPosition();
      this.persistedBounds = { x, y };
      this.persist();
    });
    void win.loadFile(this.deps.rendererFile('pet.html'));
  }

  private initialBounds(): { x?: number; y?: number } {
    const { x, y } = this.persistedBounds;
    if (typeof x === 'number' && typeof y === 'number') {
      const onScreen = screen.getAllDisplays().some((d) => {
        const a = d.workArea;
        return x >= a.x - 8 && y >= a.y - 8 && x < a.x + a.width && y < a.y + a.height;
      });
      if (onScreen) return { x, y };
    }
    const area = screen.getPrimaryDisplay().workArea;
    return { x: area.x + area.width - PET_WIDTH - 24, y: area.y + area.height - PET_HEIGHT - 24 };
  }

  private popupMenu(): void {
    if (!this.window || this.window.isDestroyed()) return;
    Menu.buildFromTemplate([
      {
        label: 'Mở Terminal Manager',
        click: () => this.deps.openTerminalManager(),
      },
      {
        label: 'Ghim trên cùng (Always on top)',
        type: 'checkbox',
        checked: this.pinned,
        click: (item) => this.setPinned(item.checked),
      },
      { type: 'separator' },
      { label: 'Ẩn Pet', click: () => this.setEnabled(false) },
    ]).popup({ window: this.window });
  }

  /**
   * Hydrate presence from the daemon's session list: rows for sessions that
   * never emitted output on this process (created before boot, sleeping, or
   * quiet while the pet was off), sleeping flags from the daemon's liveness
   * ('sleeping' is authoritative — an idle shell emits nothing), and pruning
   * for rows whose session no longer exists. Cheap: listSessions is the
   * proxy's cached array, so this runs at the head of every push.
   */
  private syncSessionState(): void {
    const seam = this.terminalSeam();
    let live: Set<string> | null = null;
    if (seam && typeof seam === 'object' && 'listSessions' in seam) {
      const listFn = (seam as { listSessions: unknown }).listSessions;
      if (typeof listFn === 'function') {
        const list = (listFn as () => unknown).call(seam);
        if (Array.isArray(list)) {
          live = new Set();
          for (const entry of list) {
            if (!entry || typeof entry !== 'object' || !('id' in entry)) continue;
            const s: TerminalListLike = entry;
            if (typeof s.id !== 'string') continue;
            live.add(s.id);
            if (s.state === 'sleeping') this.tracker.noteSleeping(s.id);
            else if (s.state === 'running') this.tracker.noteRunning(s.id);
          }
        }
      }
    }
    // Fold the authoritative run-card wait flag: a session whose agent is
    // parked on an ask tool reads 'waiting' even when its PTY tail is a hint
    // bar the heuristics never match. Cards absent for a session (no agent,
    // or pruned) leave heuristics alone.
    const cards = this.deps.getRunCards?.();
    if (Array.isArray(cards)) {
      const cardById = new Map(cards.map((c) => [c.terminalSessionId, c]));
      for (const [id] of this.tracker.sessions) {
        const card = cardById.get(id);
        if (card) this.tracker.noteWaiting(id, card.state === 'waiting_user');
      }
      // A waiting session with zero PTY output may not have a tracker row yet.
      for (const card of cards) {
        if (card.state === 'waiting_user' && !this.tracker.sessions.has(card.terminalSessionId)) {
          this.tracker.noteWaiting(card.terminalSessionId, true);
        }
      }
    }
    if (!live) return;
    for (const id of [...this.tracker.sessions.keys()]) {
      if (!live.has(id)) this.tracker.noteClosed(id);
    }
  }


  private schedulePush(): void {
    if (this.pushTimer) return;
    this.pushTimer = setTimeout(() => {
      this.pushTimer = null;
      this.pushNow();
    }, 150);
  }

  private pushNow(): void {
    this.syncSessionState();
    if (!this.window || this.window.isDestroyed()) return;
    const names = new Map<string, string>();
    const seam = this.terminalSeam();
    if (seam && typeof seam === 'object' && 'listSessions' in seam) {
      const listFn = (seam as { listSessions: unknown }).listSessions;
      if (typeof listFn === 'function') {
        const list = (listFn as () => unknown).call(seam);
        if (Array.isArray(list)) {
          for (const entry of list) {
            if (entry && typeof entry === 'object' && 'id' in entry) {
              const s: TerminalListLike = entry;
              if (typeof s.id === 'string') {
                names.set(s.id, typeof s.name === 'string' && s.name ? s.name : s.id);
              }
            }
          }
        }
      }
    }
    const RANK: Record<SessionActivityLevel, number> = {
      waiting: 4, streaming: 3, thinking: 2, completed: 1, sleeping: 0, idle: -1,
    };
    const sessions: PetSessionRow[] = [];
    let level: SessionActivityLevel = 'idle';
    for (const [id, act] of this.tracker.sessions) {
      const rowLevel = sessionActivityLevel(act);
      // Sleeping rows never reach the row list: the daemon keeps the session
      // alive but the pet only lists work the user can act on. An AI turn gone
      // quiet is still working — it surfaces as 'streaming', not a separate
      // thinking face the user cannot act on.
      if (rowLevel !== 'sleeping') {
        sessions.push({ id, name: names.get(id) ?? id, level: rowLevel === 'thinking' ? 'streaming' : rowLevel });
      }
      const promoted = rowLevel === 'thinking' ? 'streaming' : rowLevel;
      if (RANK[promoted] > RANK[level]) level = promoted;
    }
    const push: PetStatePush = { level, sessions };
    safeSendWebContents(this.window.webContents, PET_CHANNELS.STATE, push);
  }

  private persist(): void {
    try {
      fs.mkdirSync(path.dirname(this.stateFile), { recursive: true });
      fs.writeFileSync(this.stateFile, JSON.stringify({
        enabled: this.enabled,
        pinned: this.pinned,
        x: this.persistedBounds.x,
        y: this.persistedBounds.y,
      }));
    } catch {}
  }

  public dispose(): void {
    ipcMain.removeListener(PET_CHANNELS.ACTION, this.onAction);
    for (const release of this.runCardsReleases) {
      try { release(); } catch {}
    }
    this.runCardsReleases.length = 0;
    const manager = asEmitter(this.terminalSeam());
    if (manager) {
      for (const { event, handler } of this.listeners) {
        try {
          manager.removeListener(event, handler);
        } catch {}
      }
    }
    this.listeners.length = 0;
    this.tracker.dispose();
    if (this.pushTimer) clearTimeout(this.pushTimer);
    this.pushTimer = null;
    this.window?.destroy();
    this.window = null;
  }
}
