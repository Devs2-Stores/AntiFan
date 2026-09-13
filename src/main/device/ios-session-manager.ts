import type { DeviceSession, WdaTransport } from './device-control-port';
import { createSafariSession } from './wda-rest-client';

/**
 * =========================================================================================
 * NON-OBVIOUS WEBDRIVERAGENT (WDA) AUTOMATION RULES
 * =========================================================================================
 *
 * RULE 1: WDA self-kills previous session on create.
 * Creating a session via WDA POST /session terminates any previously active session
 * on the physical device. The manager uses a monotonic generation counter (starting at 1)
 * so that whenever a session is created or recreated, any capability operations holding a
 * target with an older sessionGeneration are promptly rejected with DEVICE_TARGET_STALE.
 *
 * RULE 2: POST /session/:id/url never waits for load.
 * MobileSafari navigation via WDA issues an asynchronous openURL deep-link through
 * XCUIDevice. It returns HTTP 200 immediately without waiting for DOMContentLoaded,
 * network quiescence, or rendering, and WDA provides no GET /url status readback.
 * Callers and upstream orchestrators must NOT treat POST /url completion as navigation
 * finished; downstream wait and settle gates must explicitly be applied.
 * =========================================================================================
 */

export class IosSessionManager {
  private _current: DeviceSession | undefined = undefined;
  private _nextGeneration: number = 1;
  private _pendingSession: Promise<DeviceSession> | undefined = undefined;

  /**
   * The currently active device automation session, or undefined if no session is open or
   * the active session was marked lost.
   */
  get current(): DeviceSession | undefined {
    return this._current;
  }

  /**
   * Reuses the live session when present; otherwise creates a new MobileSafari automation
   * session and increments the stored generation counter (monotonic, starts at 1 and only
   * ever increases).
   *
   * Guards against concurrent creation calls by sharing a single in-flight Promise.
   */
  async ensureSafariSession(
    transport: WdaTransport,
    options: { initialUrl?: string; osVersion?: string } = {}
  ): Promise<DeviceSession> {
    if (this._current) {
      return this._current;
    }

    if (this._pendingSession) {
      return await this._pendingSession;
    }

    this._pendingSession = (async () => {
      try {
        const result = await createSafariSession(transport, options);
        const session: DeviceSession = {
          sessionId: result.sessionId,
          generation: this._nextGeneration++,
          createdAt: Date.now(),
        };
        this._current = session;
        console.log(
          `[antifan:device] Safari session established: ${session.sessionId} (generation ${session.generation})`
        );
        return session;
      } finally {
        this._pendingSession = undefined;
      }
    })();

    return await this._pendingSession;
  }

  /**
   * Best-effort session release. Sends DELETE /session/:id to WDA and clears the current
   * session immediately, even if the remote DELETE request fails or times out.
   */
  async releaseSession(transport: WdaTransport): Promise<void> {
    const session = this._current;
    this._current = undefined;

    if (session) {
      console.log(
        `[antifan:device] Releasing Safari session ${session.sessionId} (generation ${session.generation})...`
      );
      try {
        await transport.request('DELETE', `/session/${encodeURIComponent(session.sessionId)}`);
      } catch (err) {
        console.log(
          `[antifan:device] Best-effort DELETE /session/${session.sessionId} failed (ignored):`,
          err
        );
      }
    }
  }

  /**
   * Records that the session died (e.g. WDA restart, process crash, device disconnect)
   * so the next ensureSafariSession invocation creates a fresh session with a higher generation counter.
   */
  markLost(): void {
    if (this._current) {
      console.log(
        `[antifan:device] Safari session marked lost: ${this._current.sessionId} (generation ${this._current.generation})`
      );
    }
    this._current = undefined;
  }
}
