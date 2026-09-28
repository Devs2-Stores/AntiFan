/**
 * AntiFan Browser Desktop — Chrome IPC router
 *
 * Chrome IPC is registered exactly once per process and dispatched to the host
 * that owns the sending webContents. Registering inside NativeTabHost made the
 * second project window re-register every channel and throw, so registration
 * moved here: the channel table is process-global, the target is per-sender.
 *
 * Resolution is computed from live shells on every message rather than cached —
 * a cached webContents id would keep serving a renderer that is already gone.
 */
import { ipcMain, type IpcMainEvent, type IpcMainInvokeEvent, type WebContents } from 'electron';
import type { NativeTabHost } from './native-tab-host';
import type { ChromeSurface } from './project-window-shell';

/**
 * Which chrome surface a message may come from. `tab` is a member page's own
 * webContents: a page reports its own document mutations and wheel zoom, and
 * those messages are the page's, not any chrome surface's.
 */
export type AuxiliarySurface = 'terminalPopout' | 'devtools' | 'tab';

/** Every surface a route may name. */
export type RoutedSurface = ChromeSurface | AuxiliarySurface;

/** A resolved, trustworthy dispatch target: the owning host plus the surface role. */
export interface RoutedSender {
  host: NativeTabHost;
  surface: RoutedSurface;
}

/** Event is absent on the test seam, so routes must not assume it exists. */
export type IpcEvent = IpcMainInvokeEvent | IpcMainEvent | undefined;

/**
 * One chrome channel. `surface` is the role allowed to invoke it — a renderer
 * presenting a different chrome surface is refused, so the sidebar cannot drive
 * toolbar-only operations even though both surfaces belong to one window.
 *
 * Arguments arrive as one array instead of rest parameters so the table stays a
 * single closed type: every route narrows its own payload explicitly.
 */
export interface IpcRoute {
  channel: string;
  surface: RoutedSurface | readonly RoutedSurface[];
  kind?: 'handle' | 'on';
  /**
   * The sessions this route may be allowed to name in its arguments.
   *
   * A session id from a renderer is never a capability: the router resolves these ids and
   * refuses the whole call before `run` when the calling window cannot attribute one of
   * them to itself. Without the gate a project window could read, type into, rename or kill
   * another project's terminal simply by naming it. A route that acts on "the active
   * session" declares nothing here — the host resolves that from the window's own scope.
   */
  sessionArgs?: (args: readonly unknown[], host: NativeTabHost) => readonly (string | undefined)[];
  run: (target: RoutedSender, event: IpcEvent, args: readonly unknown[]) => unknown;
}

export type ChromeSenderResolver = (webContents: WebContents) => RoutedSender | undefined;

/**
 * The Electron IPC registry this module registers into. Production passes the
 * real `ipcMain`; the default is resolved at call time, and tests inject a fake
 * because the `test:main` lane runs under plain node where `ipcMain` is absent.
 */
export interface ChromeIpcRegistrar {
  handle(channel: string, listener: (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown): unknown;
  on(channel: string, listener: (event: IpcMainEvent, ...args: unknown[]) => void): unknown;
}

let senderResolver: ChromeSenderResolver | undefined;
let installed = false;
const registeredChannels = new Set<string>();

/**
 * Install the sender resolver. index.ts sets it once the project window
 * directory exists; tests may set their own to drive chrome IPC directly.
 */
export function setChromeSenderResolver(resolver: ChromeSenderResolver | undefined): void {
  senderResolver = resolver;
}

/** Channels registered in this process; the two-window probe audits this list. */
export function listRegisteredChromeChannels(): readonly string[] {
  return [...registeredChannels];
}

/** Raised when a renderer that no live shell owns tries to use chrome IPC. */
export class UnknownChromeSenderError extends Error {
  public readonly code = 'UNKNOWN_CHROME_SENDER';
  constructor(channel: string, webContentsId: number | undefined) {
    super(`Refused ${channel}: webContents ${String(webContentsId)} is not a live chrome surface of any project window`);
    this.name = 'UnknownChromeSenderError';
  }
}

/** Raised when the right window calls a channel through the wrong surface. */
export class ChromeSurfaceMismatchError extends Error {
  public readonly code = 'CHROME_SURFACE_MISMATCH';
  constructor(channel: string, surface: RoutedSurface, allowed: RoutedSurface | readonly RoutedSurface[]) {
    super(`Refused ${channel}: surface '${surface}' may not invoke it (allowed: ${Array.isArray(allowed) ? allowed.join(', ') : allowed})`);
    this.name = 'ChromeSurfaceMismatchError';
  }
}

/**
 * Raised when a chrome channel is invoked from a child frame. Chrome pages are
 * not expected to embed frames that talk to the main process, and allowing them
 * would let embedded third-party content inherit the chrome preload's reach.
 */
export class ChromeSubframeRefusalError extends Error {
  public readonly code = 'CHROME_SUBFRAME_REFUSED';
  constructor(channel: string, frameUrl: string) {
    super(`Refused ${channel}: chrome IPC is only accepted from a top-level chrome frame (sender frame: ${frameUrl})`);
    this.name = 'ChromeSubframeRefusalError';
  }
}

/**
 * Raised when a route names a session the calling window cannot attribute to itself.
 *
 * The window scope is the same one its sidebar renders from, so a legitimate call can only
 * fail here if the renderer sent an id it was never shown — a stale view or a forged
 * message. Refusing the whole call, before `run` touches the manager, keeps one project's
 * terminal out of another project's reach.
 */
export class ChromeSessionScopeError extends Error {
  public readonly code = 'CHROME_SESSION_OUT_OF_SCOPE';
  constructor(channel: string, sessionId: string) {
    super(`Refused ${channel}: session '${sessionId}' does not belong to the calling window`);
    this.name = 'ChromeSessionScopeError';
  }
}

/**
 * Refuse a route whose arguments name a session outside the caller's scope.
 * A route declares the ids it may name; anything it declares is checked, so a
 * route cannot opt out of the gate by reading the id in its own body.
 */
function assertSessionScope(route: IpcRoute, target: RoutedSender, args: readonly unknown[]): void {
  const named = route.sessionArgs?.(args, target.host);
  if (!named) return;
  for (const id of named) {
    if (typeof id === 'string' && id && !target.host.admitsSessionForWindow(id)) {
      throw new ChromeSessionScopeError(route.channel, id);
    }
  }
}

/**
 * Resolve and authorize one message. Throws rather than falling back to another
 * window: an unknown or mismatched sender is a refusal, not a routing hint.
 */
function authorize(routes: readonly IpcRoute[], channel: string, sender: WebContents | undefined, event: IpcEvent): { route: IpcRoute; target: RoutedSender } {
  const route = routes.find((entry) => entry.channel === channel);
  if (!route) throw new Error(`No chrome route registered for ${channel}`);
  if (event) {
    const frame = event.senderFrame;
    if (!frame) throw new UnknownChromeSenderError(channel, sender?.id);
    if (frame.parent) throw new ChromeSubframeRefusalError(channel, frame.url);
  }
  const target = sender ? senderResolver?.(sender) : undefined;
  if (!target) throw new UnknownChromeSenderError(channel, sender?.id);
  const allowed = route.surface;
  const permitted = Array.isArray(allowed) ? allowed.includes(target.surface) : allowed === target.surface;
  if (!permitted) throw new ChromeSurfaceMismatchError(channel, target.surface, allowed);
  return { route, target };
}

/**
 * Register the whole chrome table once. Later calls are no-ops, which is what
 * makes a second project window legal.
 */
export function installChromeIpcOnce(routes: readonly IpcRoute[], registrar: ChromeIpcRegistrar = ipcMain): void {
  if (installed) return;

  // Validate before mutating any state: a rejected table must not leave the
  // process marked as installed, or the next (correct) table would be ignored.
  const seen = new Set<string>();
  for (const route of routes) {
    if (seen.has(route.channel)) throw new Error(`Duplicate chrome channel in the route table: ${route.channel}`);
    seen.add(route.channel);
  }

  for (const route of routes) {
    registeredChannels.add(route.channel);

    const dispatch = (event: IpcMainInvokeEvent | IpcMainEvent, ...args: unknown[]): unknown => {
      const { route: matched, target } = authorize(routes, route.channel, event.sender, event);
      assertSessionScope(matched, target, args);
      return matched.run(target, event, args);
    };

    if (route.kind === 'on') {
      // Fire-and-forget channels have no rejection channel back to the sender, so a
      // refusal must not escape as a process-level exception: an unknown, mismatched
      // or subframe sender is refused in the log and nothing else happens.
      registrar.on(route.channel, (event: IpcMainEvent, ...args: unknown[]) => {
        try {
          void dispatch(event, ...args);
        } catch (err) {
          console.warn(
            `[chrome-ipc] refused ${route.channel}: ${err instanceof Error ? `${err.name}: ${err.message}` : String(err)}`
          );
        }
      });
    } else {
      registrar.handle(route.channel, dispatch);
    }
  }

  installed = true;
}

/**
 * Test seam: drive one route outside a real renderer. It shares the production
 * authorization path, so a test cannot bypass the sender or surface gate.
 */
export function dispatchChromeRoute(routes: readonly IpcRoute[], channel: string, sender: WebContents, args: readonly unknown[] = []): unknown {
  const { route, target } = authorize(routes, channel, sender, undefined);
  assertSessionScope(route, target, args);
  return route.run(target, undefined, args);
}
