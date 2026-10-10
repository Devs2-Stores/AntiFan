/**
 * AntiFan Browser Desktop — Tab authority directory
 *
 * One NativeTabHost per project window owns that window's tabs. This directory
 * is how shared services (control plane, bridge, attachments, automation, the
 * chrome IPC resolver) find the host that owns a tab or a sender without each
 * of them holding one window's host.
 *
 * It is deliberately not a second tab registry: membership questions are
 * answered by the hosts themselves (`hasTab`, `surfaceForWebContents`), so tab
 * identity keeps exactly one owner.
 */
import type { ProjectWindowShell } from './project-window-shell';
import type { NativeTabHost } from './native-tab-host';
import type { RoutedSender, RoutedSurface } from './ipc-router';
import { parseOwnerKey } from '../project/project-context';

/**
 * The host gains `surfaceForWebContents` in the same phase as this directory.
 * Declaring it optional here keeps this module compilable on its own; the
 * runtime answer is always the host's, never a fallback guess.
 */
type AuxiliarySurfaceLookup = { surfaceForWebContents?(webContentsId: number): RoutedSurface | undefined };

export class TabAuthorityDirectory {
  private readonly hostsByShell = new Map<ProjectWindowShell, NativeTabHost>();

  /** Bind a host to the shell it presents. A re-registered shell replaces its entry. */
  public register(shell: ProjectWindowShell, host: NativeTabHost): void {
    this.hostsByShell.set(shell, host);
  }

  /**
   * Forget a shell. Ownership of deciding whether that destruction was allowed
   * stays with the caller; this only stops routing to a dead window.
   */
  public unregister(shell: ProjectWindowShell): void {
    this.hostsByShell.delete(shell);
  }

  public hostForShell(shell: ProjectWindowShell): NativeTabHost | undefined {
    return this.hostsByShell.get(shell);
  }

  /** Every live host, in registration order. */
  public hosts(): NativeTabHost[] {
    const live: NativeTabHost[] = [];
    for (const [shell, host] of this.hostsByShell) {
      if (!shell.window.isDestroyed()) live.push(host);
    }
    return live;
  }

  /** The host owning a tab, or undefined when no live window presents it. */
  public hostForTab(tabId: string): NativeTabHost | undefined {
    for (const [shell, host] of this.hostsByShell) {
      if (shell.window.isDestroyed()) continue;
      if (host.hasTab(tabId)) return host;
    }
    return undefined;
  }

  /** Whether some live window's tab carries a live agent affinity to a terminal — the one
   *  membership the agent planes drive a terminal through (MCP `terminalAuthority`, the bridge's
   *  attachment check). */
  public terminalHasLiveAgentAffinity(terminalId: string): boolean {
    return this.hosts().some((host) => host.getTerminalAgentAffinity(terminalId)?.status === 'alive');
  }

  /**
   * Whether an agent still holds an `agent:` row, which is what keeps it read-only to the shared
   * manager. Held means a live affinity, or the tab the owner key names is still open in some
   * window: a bridge mint (`antifan.terminalNewSession`) stamps `agent:<tab>` without binding an
   * affinity, and its agent is alive for as long as that tab is. The `agent:` stamp alone is not
   * enough — it outlives the tab that minted it, and a row whose agent is gone would otherwise be
   * refused to every caller for as long as its shell runs. `agent:unbound` names no tab, so only
   * an affinity can hold it.
   */
  public agentHoldsTerminal(terminalId: string, ownerKey: string | undefined): boolean {
    if (this.terminalHasLiveAgentAffinity(terminalId)) return true;
    const owner = parseOwnerKey(ownerKey ?? '');
    return owner.kind === 'agent' && owner.tabId !== 'unbound' && this.hostForTab(owner.tabId) !== undefined;
  }

  /**
   * The host and surface role for a sending renderer. Resolution is computed
   * from live windows on every call, so a destroyed renderer's numeric id can
   * never be served from a stale mapping.
   */
  public resolveSender(webContentsId: number): RoutedSender | undefined {
    for (const [shell, host] of this.hostsByShell) {
      if (shell.window.isDestroyed()) continue;
      const surface = shell.chromeSurfaceFor(webContentsId);
      if (surface) return { host, surface };
      const auxiliary = (host as NativeTabHost & AuxiliarySurfaceLookup).surfaceForWebContents?.(webContentsId);
      if (auxiliary) return { host, surface: auxiliary };
    }
    return undefined;
  }

  /** Live window count; auxiliary windows are not project shells and are not counted. */
  public liveShellCount(): number {
    let live = 0;
    for (const shell of this.hostsByShell.keys()) {
      if (!shell.window.isDestroyed()) live += 1;
    }
    return live;
  }
}
