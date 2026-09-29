/**
 * Refused close/quit presentation — the decision, not the transport.
 *
 * A refusal the coordinator already decided has to reach a surface the user can read, and
 * this suite pins the decisions that choose which one: a refused quit goes to every browser
 * shell, a refused close goes only to the shell that was refused, and a refused quit with no
 * chrome left falls back to the one native dialog. It also pins the failure contract — a
 * presentation that throws is journaled and swallowed, so the close/quit outcome the
 * coordinator reported is the outcome the caller still receives, unchanged.
 *
 * The rows build real `CloseReport`/`QuitReport` values (the mapping is asserted against the
 * coordinator's own shape, not a hand-made subset) and drive the real control records from
 * `CLOSE_LIVE_USE_CONTROLS`, so a control that a refusal points at is proven to survive the
 * trip to the notice verbatim.
 *
 * No row asserts "send was called with what we passed": what is asserted here is where a
 * refusal is delivered, which surfaces are left alone, and what the journal says when no
 * delivery was possible.
 */
import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import {
  buildCloseRefusalNotice,
  presentCloseRefusal,
  presentCloseRefusalNotice,
  type CloseRefusalPresentationPort,
  type CloseRefusalSurface,
} from '../../src/main/browser/close-refusal-notice';
import { CLOSE_LIVE_USE_CONTROLS } from '../../src/main/browser/close-live-use';
import type { CloseRefusal, CloseReport, QuitReport } from '../../src/main/browser/project-close-coordinator';
import type { CloseRefusalNotice } from '../../src/shared/contracts';

const BUSY_REFUSAL: CloseRefusal = {
  code: 'busy',
  detail: '2 in-flight operations are admitted on tab-acme-1',
  tabId: 'tab-acme-1',
  controls: [CLOSE_LIVE_USE_CONTROLS.runs],
};

const AFFINITY_REFUSAL: CloseRefusal = {
  code: 'busy',
  detail: 'A verified agent affinity holds tab-acme-2 through terminal session term-7',
  tabId: 'tab-acme-2',
  controls: [CLOSE_LIVE_USE_CONTROLS.terminalPanel, CLOSE_LIVE_USE_CONTROLS.attachments],
};

/** A refused close of one shell, as the coordinator reports it. */
const REFUSED_CLOSE: CloseReport = {
  attemptId: 7,
  ownerKey: 'project:acme',
  intent: 'user',
  coalescedRequests: 1,
  coalesced: false,
  disposition: 'retained',
  phase: 'open',
  closed: [],
  skipped: [
    { tabId: 'tab-acme-1', outcome: 'skipped', reason: 'busy', attempted: false },
    { tabId: 'tab-acme-2', outcome: 'skipped', reason: 'busy', attempted: false },
  ],
  failed: [],
  refusals: [BUSY_REFUSAL, AFFINITY_REFUSAL],
  haltedBy: 'busy',
  surface: { key: 'project:acme', kind: 'browser', outcome: 'closed' },
  survivingTabIds: ['tab-acme-1', 'tab-acme-2'],
  partial: false,
  lastBrowserShellGone: false,
  warnings: ['No page was closed: the shell was refused before its first close (busy).'],
  summary:
    'Close of project:acme: shell retained, stopped by busy (closed 0, skipped 2, failed 0); earlier closes stand and are not transactional.',
};

/** A refused application quit, as the coordinator reports it: one shell retained it. */
const REFUSED_QUIT: QuitReport = {
  attemptId: 9,
  coalescedRequests: 1,
  coalesced: false,
  shutdown: 'not-committed',
  phase: 'open',
  admissionReserved: false,
  shells: [REFUSED_CLOSE],
  auxiliaries: [],
  closedShells: [],
  survivingShells: ['project:acme', 'project:beta'],
  refusals: [BUSY_REFUSAL],
  haltedBy: 'busy',
  warnings: ['Shell project:acme was retained; later surfaces were left untouched.'],
  summary:
    'Application quit: not committed, 0 browser shell(s) closed, 0 auxiliary surface(s) closed, stopped by busy; services remain available for recovery.',
};

interface SurfaceLog {
  readonly ownerKey: string;
  readonly notices: CloseRefusalNotice[];
}

interface JournalRow {
  readonly event: string;
  readonly fields?: Record<string, unknown>;
}

/**
 * A recording port: every seam of the real presentation, with nothing electron in it.
 * `surfaces` may be a function so a row can make the shell directory itself unavailable, and
 * `extraJournal` is what lets a row assert behavior when the real journal is not writable.
 */
function recordingPort(options: {
  surfaces: readonly CloseRefusalSurface[] | (() => readonly CloseRefusalSurface[]);
  showDialog?: (notice: CloseRefusalNotice) => void | Promise<void>;
  extraJournal?: (event: string, fields?: Record<string, unknown>) => void;
}) {
  const journal: JournalRow[] = [];
  const dialogs: CloseRefusalNotice[] = [];
  const port: CloseRefusalPresentationPort = {
    surfaces: () => (typeof options.surfaces === 'function' ? options.surfaces() : options.surfaces),
    showDialog: (notice) => {
      dialogs.push(notice);
      return options.showDialog?.(notice);
    },
    journal: (event, fields) => {
      journal.push(fields === undefined ? { event } : { event, fields });
      options.extraJournal?.(event, fields);
    },
  };
  return { port, journal, dialogs };
}

/** Shell chromes that record what they were handed and answer honestly. */
function recordingSurfaces(...ownerKeys: string[]): { surfaces: CloseRefusalSurface[]; log: SurfaceLog[] } {
  const log: SurfaceLog[] = ownerKeys.map((ownerKey) => ({ ownerKey, notices: [] }));
  const surfaces = log.map((entry) => ({
    ownerKey: entry.ownerKey,
    send: (notice: CloseRefusalNotice) => {
      entry.notices.push(notice);
      return true;
    },
  }));
  return { surfaces, log };
}

function presentedRow(rows: readonly JournalRow[], surface: string): JournalRow | undefined {
  return rows.find((row) => row.event === 'close-refusal.presented' && row.fields?.surface === surface);
}

function failedRow(rows: readonly JournalRow[]): JournalRow | undefined {
  return rows.find((row) => row.event === 'close-refusal.failed');
}

describe('refusal notice mapping', () => {
  it('maps every refusal of a refused close, carrying the shell key it belongs to', () => {
    const notice = buildCloseRefusalNotice(REFUSED_CLOSE, 'close');

    assert.deepEqual(notice, {
      kind: 'close',
      ownerKey: 'project:acme',
      haltedBy: 'busy',
      summary: REFUSED_CLOSE.summary,
      reasons: [
        {
          code: 'busy',
          detail: '2 in-flight operations are admitted on tab-acme-1',
          tabId: 'tab-acme-1',
          controls: [{ id: CLOSE_LIVE_USE_CONTROLS.runs.id, label: CLOSE_LIVE_USE_CONTROLS.runs.label }],
        },
        {
          code: 'busy',
          detail: 'A verified agent affinity holds tab-acme-2 through terminal session term-7',
          tabId: 'tab-acme-2',
          controls: [
            { id: CLOSE_LIVE_USE_CONTROLS.terminalPanel.id, label: CLOSE_LIVE_USE_CONTROLS.terminalPanel.label },
            { id: CLOSE_LIVE_USE_CONTROLS.attachments.id, label: CLOSE_LIVE_USE_CONTROLS.attachments.label },
          ],
        },
      ],
    });
    // The wire carries exactly the facts a surface displays: nothing to approve, nothing to
    // force, and no field a chrome could turn into a way past the refusal.
    assert.deepEqual(Object.keys(notice).sort(), ['haltedBy', 'kind', 'ownerKey', 'reasons', 'summary']);
    assert.deepEqual(notice.reasons[1]?.controls.map((control) => control.id), [
      'antifan:terminal:close-session',
      'antifan.cli.endSession',
    ]);
  });

  it('carries no shell key for a refused quit, and a page-less refusal keeps its reason', () => {
    const notice = buildCloseRefusalNotice(REFUSED_QUIT, 'quit');

    assert.equal(notice.kind, 'quit');
    assert.equal('ownerKey' in notice, false, 'a quit belongs to the application, not to one shell');
    assert.equal(notice.haltedBy, 'busy');
    assert.equal(notice.summary, REFUSED_QUIT.summary);
    assert.deepEqual(Object.keys(notice).sort(), ['haltedBy', 'kind', 'reasons', 'summary']);
  });

  it('maps a refusal that concerns no page without inventing one', () => {
    const surfaceRefusal: CloseRefusal = {
      code: 'surface-missing',
      detail: 'No live surface is registered for project:none',
      controls: [],
    };
    const notice = buildCloseRefusalNotice(
      { haltedBy: 'surface-missing', summary: 'retained', refusals: [surfaceRefusal] },
      'close'
    );

    assert.deepEqual(notice.reasons, [{ code: 'surface-missing', detail: 'No live surface is registered for project:none', controls: [] }]);
    assert.equal('tabId' in (notice.reasons[0] ?? {}), false);
  });
});

describe('refusal notice delivery', () => {
  it('presents a refused quit to every browser shell', () => {
    const { surfaces, log } = recordingSurfaces('project:acme', 'project:beta');
    const { port, journal, dialogs } = recordingPort({ surfaces });
    const notice = buildCloseRefusalNotice(REFUSED_QUIT, 'quit');

    presentCloseRefusalNotice(notice, port);

    assert.equal(log[0]?.notices.length, 1, 'the shell the user was looking at is told');
    assert.equal(log[1]?.notices.length, 1, 'every other shell is told too, not just the first');
    assert.equal(log[0]?.notices[0], notice, 'a shell is handed the refusal itself');
    assert.equal(log[1]?.notices[0], notice);
    assert.deepEqual(dialogs, [], 'a shell that took the notice is why no dialog appears');
    assert.deepEqual(presentedRow(journal, 'toolbar')?.fields, {
      kind: 'quit',
      reasonCount: 1,
      surface: 'toolbar',
      delivered: 2,
      failed: 0,
    });
  });

  it('presents a refused close only to the shell that was refused', () => {
    const { surfaces, log } = recordingSurfaces('project:acme', 'project:beta');
    const { port, journal, dialogs } = recordingPort({ surfaces });

    presentCloseRefusalNotice(buildCloseRefusalNotice(REFUSED_CLOSE, 'close'), port);

    assert.equal(log[0]?.notices.length, 1, 'the shell that stayed open explains itself');
    assert.equal(log[1]?.notices.length, 0, 'an unrelated window is not told about another window refusal');
    assert.deepEqual(dialogs, []);
    assert.deepEqual(presentedRow(journal, 'toolbar')?.fields, {
      kind: 'close',
      ownerKey: 'project:acme',
      reasonCount: 2,
      surface: 'toolbar',
      delivered: 1,
      failed: 0,
    });
  });

  it('falls back to the native dialog when a refused quit has no browser shell to show it in', async () => {
    const { port, journal, dialogs } = recordingPort({ surfaces: [] });

    presentCloseRefusalNotice(buildCloseRefusalNotice(REFUSED_QUIT, 'quit'), port);
    // The dialog is recorded as presented once it is really on screen, so the row is written
    // after its promise settles rather than at the call.
    await Promise.resolve();

    assert.equal(dialogs.length, 1, 'the user asked to quit and is told why it did not happen');
    assert.equal(dialogs[0]?.summary, REFUSED_QUIT.summary);
    assert.equal(dialogs[0]?.reasons.length, 1);
    assert.deepEqual(presentedRow(journal, 'dialog')?.fields, {
      kind: 'quit',
      reasonCount: 1,
      surface: 'dialog',
      failed: 0,
    });
  });

  it('falls back to the native dialog when the surviving chrome cannot take the message', async () => {
    const chromes: CloseRefusalSurface[] = [
      { ownerKey: 'project:acme', send: () => false },
      {
        ownerKey: 'project:beta',
        send: () => {
          throw new Error('the toolbar webContents is gone');
        },
      },
    ];
    const { port, journal, dialogs } = recordingPort({ surfaces: chromes });

    presentCloseRefusalNotice(buildCloseRefusalNotice(REFUSED_QUIT, 'quit'), port);
    await Promise.resolve();

    assert.equal(dialogs.length, 1, 'a quit nobody could be told about is still reported somewhere');
    assert.deepEqual(presentedRow(journal, 'dialog')?.fields, {
      kind: 'quit',
      reasonCount: 1,
      surface: 'dialog',
      failed: 2,
    });
    assert.equal(presentedRow(journal, 'toolbar'), undefined);
  });

  it('never opens a dialog for a refused close, which is not a request to leave', () => {
    const { port, journal, dialogs } = recordingPort({ surfaces: [] });

    presentCloseRefusalNotice(buildCloseRefusalNotice(REFUSED_CLOSE, 'close'), port);

    assert.deepEqual(dialogs, [], 'a refused window close must not take focus with a dialog');
    const failure = journal.find((row) => row.event === 'close-refusal.failed');
    assert.equal(failure?.fields?.ownerKey, 'project:acme');
    assert.equal(failure?.fields?.detail, 'no shell chrome could display the refusal');
  });

  it('delivers to the remaining shells when one chrome fails, and journals the failure count', () => {
    const surviving: CloseRefusalNotice[] = [];
    const surfaces: CloseRefusalSurface[] = [
      {
        ownerKey: 'project:acme',
        send: () => {
          throw new Error('renderer is gone');
        },
      },
      {
        ownerKey: 'project:beta',
        send: (notice) => {
          surviving.push(notice);
          return true;
        },
      },
    ];
    const { port, journal } = recordingPort({ surfaces });

    presentCloseRefusalNotice(buildCloseRefusalNotice(REFUSED_QUIT, 'quit'), port);

    assert.equal(surviving.length, 1, 'one broken chrome does not silence the others');
    assert.deepEqual(presentedRow(journal, 'toolbar')?.fields, {
      kind: 'quit',
      reasonCount: 1,
      surface: 'toolbar',
      delivered: 1,
      failed: 1,
    });
  });
});

describe('presentation failure contract', () => {
  it('journals a presentation that throws and never raises it into the close path', () => {
    const { port, journal } = recordingPort({
      surfaces: () => {
        throw new Error('the shell directory is unavailable');
      },
    });

    assert.doesNotThrow(() => presentCloseRefusalNotice(buildCloseRefusalNotice(REFUSED_QUIT, 'quit'), port));
    const failure = failedRow(journal);
    assert.equal(failure?.fields?.kind, 'quit');
    assert.equal(failure?.fields?.detail, 'the shell directory is unavailable');
  });

  it('guards the mapping too: a report it cannot read is journaled, never raised', () => {
    // The coordinator always sends these fields; the cast is how a boundary that hands over
    // something else is simulated, and the guarantee is that no such caller can break the
    // close path it called from.
    const unreadable = { ...REFUSED_CLOSE, refusals: undefined } as unknown as CloseReport;
    const { port, journal, dialogs } = recordingPort({ surfaces: [] });

    assert.doesNotThrow(() => presentCloseRefusal(unreadable, 'close', port));
    const failure = failedRow(journal);
    assert.equal(failure?.fields?.kind, 'close');
    assert.equal(failure?.fields?.ownerKey, 'project:acme', 'the failure still names the shell it was about');
    assert.match(String(failure?.fields?.detail), /cannot read properties of undefined/i);
    assert.deepEqual(dialogs, []);
  });

  it('cannot be made to raise by a journal that is itself unavailable', () => {
    const { port } = recordingPort({
      surfaces: [],
      extraJournal: () => {
        throw new Error('the lifecycle log is not writable');
      },
    });

    assert.doesNotThrow(() => presentCloseRefusalNotice(buildCloseRefusalNotice(REFUSED_QUIT, 'quit'), port));
    assert.doesNotThrow(() => presentCloseRefusalNotice(buildCloseRefusalNotice(REFUSED_CLOSE, 'close'), port));
  });

  it('journals a dialog that will not open instead of claiming the user was told', async () => {
    const { port, journal } = recordingPort({
      surfaces: [],
      showDialog: () => Promise.reject(new Error('no display is available')),
    });

    presentCloseRefusalNotice(buildCloseRefusalNotice(REFUSED_QUIT, 'quit'), port);
    await Promise.resolve();
    await Promise.resolve();

    assert.equal(presentedRow(journal, 'dialog'), undefined, 'a dialog that never opened is not a presentation');
    const failure = failedRow(journal);
    assert.equal(failure?.fields?.surface, 'dialog');
    assert.equal(failure?.fields?.detail, 'no display is available');
  });

  it('is not awaited by the outcome it reports: the reported outcome still resolves', async () => {
    // The shape both call sites in `src/main/index.ts` use: the refusal is presented inside
    // the settlement handler of the close/quit promise, never in place of its value.
    const { port, journal } = recordingPort({
      surfaces: () => {
        throw new Error('presentation failed');
      },
    });

    const resolved = await Promise.resolve(REFUSED_QUIT).then((report) => {
      presentCloseRefusal(report, 'quit', port);
      return report;
    });

    assert.equal(resolved.shutdown, 'not-committed', 'the honest outcome survives a failed presentation');
    assert.equal(resolved.survivingShells.length, 2);
    assert.equal(journal.some((row) => row.event === 'close-refusal.failed'), true, 'and it was not silent');
  });
});
