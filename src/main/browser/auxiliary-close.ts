/**
* AntiFan Browser Desktop - Auxiliary window close with a terminal outcome
*
* An application quit closes the auxiliary windows the user owns (terminal popouts and
* extra workbench windows) before it touches shared services, and it must know what
* happened to each one: `closed` commits, a veto retains the window, and anything the
* window did not answer is `unknown` - which refuses the commit and retains the window
* exactly like a veto does.
*
* Waiting for an outcome is where this used to hang. Measured on this platform: a polite
* close the window answers reports back in 1-25ms, while a close issued while a previous
* refusal is still being processed is answered with NOTHING - no `close`, no
* `will-prevent-unload`, no `closed`, ever. A gate that waits on those two events alone
* therefore never settles, and because every later quit request coalesces into the attempt
* that never ends, the application becomes unquittable with application admission held
* closed. That is the fail-closed gate turning into a permanent lockout, which is why the
* wait is bounded here instead of trusted.
*
* The bound never destroys anything: it reports `unknown`, so the attempt is refused and
* the window is left standing for the next request to ask again. Electron types are imported
* as types only, so the state machine is deterministic under test while the real window
* stays the caller's.
*/
import type { BrowserWindow } from 'electron';
import type { SurfaceCloseOutcome } from './project-close-coordinator';

/**
* How long one auxiliary close may stay without an observable outcome.
*
* Far above the measured 1-25ms round trip, so a genuinely closing window - or a slow
* renderer answering a veto - is never cut short, and far below a user's patience, so a
* request the platform swallowed ends in a refusal the user can retry instead of a gate
* that waits forever. A window whose close really is only slow is still gone by the next
* attempt, which asks again with the same listeners.
*/
export const AUXILIARY_CLOSE_OUTCOME_DEADLINE_MS = 1_500;

/**
* Close one auxiliary window and report its terminal outcome.
*
* The veto is read from whichever signal the window produced: `will-prevent-unload` when the
* renderer answered before unloading, or an already-cancelled `close` event when the platform
* carried the cancellation out. That second read happens in a microtask, deliberately:
* whether the platform carried the close out is only final after every listener ran.
*/
export async function closeAuxiliaryWindow(
  window: BrowserWindow,
  deadlineMs: number = AUXILIARY_CLOSE_OUTCOME_DEADLINE_MS
): Promise<SurfaceCloseOutcome> {
  if (window.isDestroyed()) return 'closed';
  const deferred = Promise.withResolvers<SurfaceCloseOutcome>();
  let settled = false;
  let outcomeTimer: NodeJS.Timeout | null = null;
  const contents = window.webContents;
  const finish = (outcome: SurfaceCloseOutcome): void => {
    if (settled) return;
    settled = true;
    if (outcomeTimer) clearTimeout(outcomeTimer);
    window.removeListener('closed', onClosed);
    if (contents && !contents.isDestroyed()) contents.removeListener('will-prevent-unload', onPreventUnload);
    window.removeListener('close', onCloseEvent);
    deferred.resolve(outcome);
  };
  const onClosed = (): void => finish('closed');
  const onPreventUnload = (): void => finish(window.isDestroyed() ? 'closed' : 'vetoed');
  const onCloseEvent = (event: Electron.Event): void => {
    queueMicrotask(() => {
      if (settled || window.isDestroyed()) return;
      if (event.defaultPrevented) finish('vetoed');
    });
  };
  window.once('closed', onClosed);
  if (contents && !contents.isDestroyed()) contents.once('will-prevent-unload', onPreventUnload);
  window.once('close', onCloseEvent);
  // Armed before the request, because a close the platform swallows emits no event at all:
  // a bound that waited for one would never start.
  outcomeTimer = setTimeout(() => {
    if (settled) return;
    finish(window.isDestroyed() ? 'closed' : 'unknown');
  }, Math.max(1, deadlineMs));
  outcomeTimer.unref?.();
  try {
    window.close();
  } catch (err) {
    finish('unknown');
    throw err;
  }
  return deferred.promise;
}
