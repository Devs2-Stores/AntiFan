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
  private _currentDeviceId: string | undefined = undefined;
  private _nextGeneration: number = 1;
  private _pendingSession: Promise<DeviceSession> | undefined = undefined;
  private _pendingDeviceId: string | undefined = undefined;

  /**
   * The currently active device automation session, or undefined if no session is open or
   * the active session was marked lost.
   */
  get current(): DeviceSession | undefined {
    return this._current;
  }

  /**
   * Which device owns the live session. The adapter needs this to drop the session record of the
   * device that actually died, instead of assuming it is the device currently being talked about.
   */
  get currentDeviceId(): string | undefined {
    return this._currentDeviceId;
  }

  /**
   * Reuses the live session when present; otherwise creates a new MobileSafari automation
   * session and increments the stored generation counter (monotonic, starts at 1 and only
   * ever increases).
   *
   * Single-flight per device: concurrent callers for the same device share one POST /session,
   * because WDA kills the previous session the instant a new one is created — a second create would
   * hand the first caller a sessionId that is already dead.
   */
  async ensureSafariSession(
    transport: WdaTransport,
    deviceId: string,
    options: { initialUrl?: string; osVersion?: string } = {}
  ): Promise<DeviceSession> {
    // Snapshot the state into locals before testing it. TypeScript narrows the false branch of a property
    // `A && B` test to "A is falsy" and keeps that narrowing for the rest of the method, which makes the
    // later reads of exactly these fields statically dead code.
    const pending: Promise<DeviceSession> | undefined = this._pendingSession;
    const pendingDeviceId: string | undefined = this._pendingDeviceId;
    const live: DeviceSession | undefined = this._current;
    const liveDeviceId: string | undefined = this._currentDeviceId;

    if (pending && pendingDeviceId === deviceId) return await pending;
    if (live && liveDeviceId === deviceId) return live;

    if (live) {
      // The caller is switching phones. The adapter releases the old session before it gets here, so
      // this is a safety net: never hand a session established on device A to a request for device B.
      console.log(
        `[antifan:device] Abandoning Safari session ${live.sessionId} owned by ${String(
          liveDeviceId
        )} because ${deviceId} asked for one`
      );
      this._current = undefined;
      this._currentDeviceId = undefined;
    }

    if (pending) {
      // A create for another device is in flight; let it settle so generations stay ordered and the
      // single-owner invariant stays observable instead of interleaving two device sessions.
      const foreign = await pending.catch(() => undefined);
      if (foreign && this._currentDeviceId !== deviceId) {
        // That create produced a session for the other phone. Holding it as `current` would let a caller
        // for this device observe another device's session for the duration of this create, so only the
        // reference is dropped here (the adapter already released it on the wire).
        console.log(
          `[antifan:device] Dropping Safari session ${foreign.sessionId} owned by ${String(
            this._currentDeviceId
          )} while establishing one on ${deviceId}`
        );
        this._current = undefined;
        this._currentDeviceId = undefined;
      }
    }

    this._pendingDeviceId = deviceId;
    this._pendingSession = (async () => {
      try {
        const result = await createSafariSession(transport, options);
        const session: DeviceSession = {
          sessionId: result.sessionId,
          generation: this._nextGeneration++,
          createdAt: Date.now(),
        };
        this._current = session;
        this._currentDeviceId = deviceId;
        console.log(
          `[antifan:device] Safari session established on ${deviceId}: ${session.sessionId} (generation ${session.generation})`
        );
        return session;
      } finally {
        this._pendingSession = undefined;
        this._pendingDeviceId = undefined;
      }
    })();

    return await this._pendingSession;
  }

  /**
   * Best-effort session release. Sends DELETE /session/:id to WDA and clears the current
   * session immediately, even if the remote DELETE request fails or times out.
   */
  async releaseSession(transport: WdaTransport | undefined): Promise<void> {
    const session = this._current;
    this._current = undefined;
    this._currentDeviceId = undefined;

    if (session && transport) {
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
    this._currentDeviceId = undefined;
  }
}
