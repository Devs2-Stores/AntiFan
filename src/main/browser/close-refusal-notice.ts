/**
 * AntiFan Browser Desktop — Refused close/quit presentation
 *
 * A refusal already decided by the close coordinator has to be readable by the user, or the
 * window simply stays open and says nothing. This module is that one surface: it maps a
 * refused report to the wire notice (`CloseRefusalNotice`) and delivers it to the chrome
 * that must explain itself.
 *
 * Contract notes the wiring MUST honor:
 * - Presentation never decides anything. It cannot approve a close, defer it, or offer a
 *   way around the named work: the reasons are shown verbatim and the controls they name
 *   are guidance, not buttons this path could press.
 * - Presentation never changes the outcome, and never throws into the close/quit path.
 *   Every failure — a report that cannot be mapped, a chrome that cannot take the message, a
 *   dialog that will not open, a journal that is unavailable — is journaled and swallowed. An
 *   outcome whose only surface failed is still the outcome the coordinator reported.
 * - Delivery is not focus. A refusal is delivered to shells that are already open, and the
 *   one native fallback exists because there is a refused quit and no browser shell left to
 *   show it in; nothing here raises, selects or focuses a window.
 * - The latest refusal is the current state: a later notice is delivered as-is, and a
 *   surface that has one already replaces it rather than accumulating history.
 *
 * It is deliberately electron-free and every seam is injected, so the delivery decision is
 * deterministic under test while the real shells, dialog and journal stay in
 * `src/main/index.ts`.
 */
import type { CloseRefusalNotice, CloseRefusalReasonWire } from '../../shared/contracts';

/** Which request was refused. `close` is one shell's window close; `quit` is the application. */
export type CloseRefusalKind = 'close' | 'quit';

/**
 * The report fields a notice is built from. Both report kinds satisfy it structurally, so
 * the mapping reads exactly the facts it shows and cannot invent any others.
 */
export interface CloseRefusalReportFacts {
  /** Present on a close report only; a quit names no single shell. */
  readonly ownerKey?: string;
  /** The stop reason that ended the attempt; `null` means nothing stopped it. */
  readonly haltedBy: string | null;
  /** The coordinator's own account of the attempt. */
  readonly summary: string;
  readonly refusals: readonly {
    readonly code: string;
    readonly detail: string;
    readonly tabId?: string;
    readonly controls: readonly { readonly id: string; readonly label: string }[];
  }[];
}

/**
 * One chrome that can display a notice. `send` answers whether THIS chrome took the message:
 * a destroyed or crashed toolbar says no, and a quit with no chrome left is what makes the
 * native fallback the honest route.
 */
export interface CloseRefusalSurface {
  /** Owner key of the shell this chrome belongs to (see `ownerKey`). */
  readonly ownerKey: string;
  send(notice: CloseRefusalNotice): boolean;
}

/** Everything the presentation needs from the process, injected so it stays testable. */
export interface CloseRefusalPresentationPort {
  /** Every browser shell whose chrome could display a notice right now. */
  surfaces(): readonly CloseRefusalSurface[];
  /**
   * The native fallback, used only when a refused quit has no chrome to report through. The
   * rejection of a dialog that will not open is caught here like any other failure.
   */
  showDialog(notice: CloseRefusalNotice): void | Promise<void>;
  journal(event: string, fields?: Record<string, unknown>): void;
}

/**
 * Map a refused report to its wire notice. Pure: every field is copied from the report, no
 * refusal is dropped or reordered, and `ownerKey` is carried for a close only — a quit
 * belongs to the application, and a key there would name a shell the user did not close.
 */
export function buildCloseRefusalNotice(
  report: CloseRefusalReportFacts,
  kind: CloseRefusalKind
): CloseRefusalNotice {
  const reasons: CloseRefusalReasonWire[] = report.refusals.map((refusal) => ({
    code: refusal.code,
    detail: refusal.detail,
    ...(refusal.tabId === undefined ? {} : { tabId: refusal.tabId }),
    controls: refusal.controls.map((control) => ({ id: control.id, label: control.label })),
  }));
  return {
    kind,
    ...(kind === 'close' && report.ownerKey !== undefined ? { ownerKey: report.ownerKey } : {}),
    haltedBy: report.haltedBy,
    summary: report.summary,
    reasons,
  };
}

/**
 * Build and deliver the refusal for one report, swallowing every failure while recording it.
 *
 * This is the function the close and quit paths call: mapping the report is part of
 * presenting it, so a report this module cannot read produces a journaled failure instead of
 * an exception raised into the path it came from. `presentCloseRefusalNotice` below owns the
 * delivery decision and its own guarded boundary.
 */
export function presentCloseRefusal(
  report: CloseRefusalReportFacts,
  kind: CloseRefusalKind,
  port: CloseRefusalPresentationPort
): void {
  let notice: CloseRefusalNotice;
  try {
    notice = buildCloseRefusalNotice(report, kind);
  } catch (err) {
    journalCloseRefusal(port, 'close-refusal.failed', {
      kind,
      ...(kind === 'close' && report.ownerKey !== undefined ? { ownerKey: report.ownerKey } : {}),
      detail: describeError(err),
    });
    return;
  }
  presentCloseRefusalNotice(notice, port);
}

/**
 * Deliver one refusal notice, and swallow every failure while recording it.
 *
 * The returned-value-free shape is the contract: a caller's close/quit promise chain cannot
 * be broken by presentation, whatever the chrome, the dialog or the journal does.
 *
 * `kind === 'close'` targets the refusing shell's own chrome, because that shell is the one
 * that stayed open and therefore the surface that has to explain itself. `kind === 'quit'`
 * targets every shell, so the reason for a refused quit is visible wherever the user is
 * looking. A quit that no chrome could take falls back to the native dialog: the user asked
 * to quit and would otherwise get silence, and that dialog is the only focus-affecting step
 * in the whole path.
 */
export function presentCloseRefusalNotice(
  notice: CloseRefusalNotice,
  port: CloseRefusalPresentationPort
): void {
  try {
    const surfaces = port.surfaces();
    const targeted = notice.kind === 'close'
      ? surfaces.filter((surface) => notice.ownerKey !== undefined && surface.ownerKey === notice.ownerKey)
      : surfaces.slice();
    let delivered = 0;
    let failed = 0;
    for (const surface of targeted) {
      // One chrome that cannot take the message must not silence the others: a refused quit
      // is one refusal that has to reach every shell still open.
      try {
        if (surface.send(notice)) delivered += 1;
        else failed += 1;
      } catch {
        failed += 1;
      }
    }
    if (delivered > 0) {
      journalCloseRefusal(port, 'close-refusal.presented', {
        kind: notice.kind,
        ...(notice.ownerKey === undefined ? {} : { ownerKey: notice.ownerKey }),
        reasonCount: notice.reasons.length,
        surface: 'toolbar',
        delivered,
        failed,
      });
      return;
    }
    if (notice.kind === 'quit') {
      // Recorded as presented only once the dialog is really on screen: a dialog that never
      // opened is a refusal the user never saw, and the journal must not say otherwise.
      void Promise.resolve(port.showDialog(notice)).then(
        () => {
          journalCloseRefusal(port, 'close-refusal.presented', {
            kind: notice.kind,
            reasonCount: notice.reasons.length,
            surface: 'dialog',
            failed,
          });
        },
        (err: unknown) => {
          journalCloseRefusal(port, 'close-refusal.failed', {
            kind: notice.kind,
            surface: 'dialog',
            detail: describeError(err),
          });
        }
      );
      return;
    }
    // A refused close with no chrome to show it in has nowhere left to go, and a dialog is
    // not offered here: the user did not ask to quit, so nothing may take their focus.
    journalCloseRefusal(port, 'close-refusal.failed', {
      kind: notice.kind,
      ...(notice.ownerKey === undefined ? {} : { ownerKey: notice.ownerKey }),
      failed,
      detail: 'no shell chrome could display the refusal',
    });
  } catch (err) {
    journalCloseRefusal(port, 'close-refusal.failed', {
      kind: notice.kind,
      ...(notice.ownerKey === undefined ? {} : { ownerKey: notice.ownerKey }),
      detail: describeError(err),
    });
  }
}

/**
 * The journal is the one seam that must not be able to raise: a failure to record a
 * presentation failure would otherwise escape into the close/quit path it just protected.
 */
function journalCloseRefusal(
  port: CloseRefusalPresentationPort,
  event: string,
  fields: Record<string, unknown>
): void {
  try {
    port.journal(event, fields);
  } catch {
    // Nothing left to report through.
  }
}

function describeError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
