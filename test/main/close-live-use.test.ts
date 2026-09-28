/**
 * Close live-use evidence: the classification the close coordinator refuses on.
 *
 * The port is injected here, so every row below is about one thing: whether a given set of
 * authoritative owners makes a close idle, busy or unknown. The rows that matter are the
 * ones where a wrong answer destroys work:
 *
 * - an unreadable owner answered as idle would close a page whose work is in flight;
 * - an out-of-scope owner answered as busy would refuse a close of an unrelated window;
 * - a binding or a run on an offscreen agent tab of the shell being closed would be missed
 *   by a visible-page-only scope test.
 */

import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import { setImmediate as yieldToLoop } from 'node:timers/promises';
import {
  CLOSE_LIVE_USE_CONTROLS,
  collectCloseLiveUse,
  projectLiveUseAttachments,
  type CloseAdmissionTable,
  type CloseLiveUseAttachment,
  type CloseLiveUseAttachmentRecord,
  type CloseLiveUsePort,
  type PageOperationCounter,
} from '../../src/main/browser/close-live-use';
import { PageCloseReservations, type LiveUseReport, type LiveUseRequest } from '../../src/main/browser/project-close-coordinator';
import { AttachmentRegistry } from '../../src/main/run/attachment-registry';
import { BrowserControlPort, type BrowserHostPort } from '../../src/main/tools/browser-control-port';
import { CapabilityError, issueRuntimeLease, makeControlPlaneId } from '../../src/shared/control-plane-contracts';

/** A close-admission table as the module reads it, so a case names only what it is about. */
function admissionTable(
  snapshot: Partial<{ inFlightOperations: number; reservedTabIds: readonly string[]; applicationReserved: boolean }> = {},
  pageCounts: Record<string, number> = {},
  ownerCounts: Record<string, number> = {}
): CloseAdmissionTable {
  return {
    snapshot: () => ({ inFlightOperations: 0, reservedTabIds: [], applicationReserved: false, ...snapshot }),
    inFlightOperationsOnPage: (tabId: string) => pageCounts[tabId] ?? 0,
    inFlightOperationsOnOwner: (ownerKey: string) => ownerCounts[ownerKey] ?? 0,
  };
}

/**
 * A table whose owner-attributed read fails: whichever scope consults it must answer
 * unknown, so a scope that must not read it can prove the read never happened.
 */
function ownerCountUnreadable(inFlightOperations = 0): CloseAdmissionTable {
  return {
    snapshot: () => ({ inFlightOperations, reservedTabIds: [], applicationReserved: false }),
    inFlightOperationsOnPage: () => 0,
    inFlightOperationsOnOwner: () => {
      throw new Error('the owner-attributed count is unreadable');
    },
  };
}

/** A page counter with a fixed count per page, for the port's own pools and waits. */
function counter(counts: Record<string, number> = {}): PageOperationCounter {
  return { getActiveTabCount: (tabId: string) => counts[tabId] ?? 0 };
}

/** A port with nothing in flight: every case below changes exactly the source it is about. */
function idlePort(overrides: Partial<CloseLiveUsePort> = {}): CloseLiveUsePort {
  return {
    admission: () => admissionTable(),
    operationCounters: () => ({}),
    ledgerInFlight: () => 0,
    runs: () => [],
    attachments: () => [],
    affinities: () => [],
    terminalState: () => ({ available: true, sessions: [] }),
    ...overrides,
  };
}

/** The shell question: which of its member pages the attempt is about. */
const SHELL_A: LiveUseRequest = { scope: 'shell', ownerKey: 'project:a', pageIds: ['tab-1', 'tab-2'], auxiliaryKeys: [] };
/** The application question: every owner is in scope, member pages and auxiliaries alike. */
const APPLICATION: LiveUseRequest = {
  scope: 'application',
  ownerKey: null,
  pageIds: ['tab-1'],
  auxiliaryKeys: ['terminal-window:7'],
};

/** Categories the answer named, so a case asserts the reason and not only the state. */
function categories(report: LiveUseReport): string[] {
  return (report.reasons ?? []).map((reason) => reason.category);
}

function details(report: LiveUseReport): string {
  return (report.reasons ?? []).map((reason) => reason.detail).join(' | ');
}

describe('close live-use evidence', () => {
  it('answers idle when every owner has nothing in flight', () => {
    const report = collectCloseLiveUse(SHELL_A, idlePort());
    assert.equal(report.state, 'idle');
    assert.deepEqual(report.reasons, []);
  });

  it('refuses a shell for an attachment bound to one of its pages, naming the page', () => {
    const report = collectCloseLiveUse(
      SHELL_A,
      idlePort({ attachments: () => [{ attachmentId: 'attachment-1', runId: 'run-1', tabId: 'tab-2' }] })
    );
    assert.equal(report.state, 'busy');
    assert.deepEqual(categories(report), ['attachment-authority']);
    assert.match(details(report), /attachment-1/);
    assert.equal(report.reasons?.[0]?.tabId, 'tab-2');
    assert.equal(report.reasons?.[0]?.control?.id, CLOSE_LIVE_USE_CONTROLS.attachments.id);
  });

  it('refuses a shell for a binding on an offscreen tab it owns but does not list as a member', () => {
    const report = collectCloseLiveUse(
      SHELL_A,
      idlePort({
        attachments: () => [
          { attachmentId: 'attachment-agent', runId: 'run-1', tabId: 'tab-offscreen', ownerKey: 'project:a' },
        ],
      })
    );
    assert.equal(report.state, 'busy');
    assert.deepEqual(categories(report), ['attachment-authority']);
  });

  it('leaves another window alone: an attachment of one shell does not refuse a sibling', () => {
    const report = collectCloseLiveUse(
      SHELL_A,
      idlePort({
        attachments: () => [
          { attachmentId: 'attachment-b', runId: 'run-1', tabId: 'tab-9', ownerKey: 'project:b' },
        ],
      })
    );
    assert.equal(report.state, 'idle');
  });

  it('distinguishes a queued, an awaiting and a streaming run in the application scope', () => {
    for (const [state, category] of [
      ['queued', 'run-queued'],
      ['waiting-tool', 'run-awaiting'],
      ['streaming', 'run-active'],
    ] as const) {
      const report = collectCloseLiveUse(APPLICATION, idlePort({ runs: () => [{ runId: 'run-1', state }] }));
      assert.equal(report.state, 'busy', `${state} must be busy`);
      assert.deepEqual(categories(report), [category]);
    }
  });

  it('ignores a run that already reached a terminal state', () => {
    const report = collectCloseLiveUse(
      APPLICATION,
      idlePort({
        runs: () => [
          { runId: 'run-1', state: 'completed' },
          { runId: 'run-2', state: 'failed' },
          { runId: 'run-3', state: 'interrupted' },
        ],
      })
    );
    assert.equal(report.state, 'idle');
  });

  it('protects a run in a shell only through a page that shell actually presents', () => {
    const runs: Partial<CloseLiveUsePort> = { runs: () => [{ runId: 'run-1', state: 'streaming' }] };
    const otherShell = collectCloseLiveUse(
      SHELL_A,
      idlePort({
        ...runs,
        attachments: () => [{ attachmentId: 'attachment-b', runId: 'run-1', tabId: 'tab-9', ownerKey: 'project:b' }],
      })
    );
    assert.equal(otherShell.state, 'idle', 'another window\'s run is not this window\'s work');
    const thisShell = collectCloseLiveUse(
      SHELL_A,
      idlePort({
        ...runs,
        attachments: () => [{ attachmentId: 'attachment-a', runId: 'run-1', tabId: 'tab-1', ownerKey: 'project:a' }],
      })
    );
    assert.equal(thisShell.state, 'busy');
    assert.deepEqual(categories(thisShell), ['attachment-authority', 'run-active']);
  });

  it('treats the run service\'s own unverified outcome as terminal, not as unreadable evidence', () => {
    // 'unknown' is how the run service reports a run whose backend outcome could not be verified:
    // the attempt has ended (run-service's terminal set includes it). Reading it as evidence that
    // cannot be interpreted held every quit open for the record's whole life, against a control
    // (`antifan:workflow:abort`) that cannot settle a run that is already finished.
    const report = collectCloseLiveUse(APPLICATION, idlePort({ runs: () => [{ runId: 'run-1', state: 'unknown' }] }));
    assert.equal(report.state, 'idle');
  });

  it('answers unknown for a run state it cannot interpret', () => {
    const report = collectCloseLiveUse(APPLICATION, idlePort({ runs: () => [{ runId: 'run-1', state: 'mystery' }] }));
    assert.equal(report.state, 'unknown');
    assert.deepEqual(categories(report), ['evidence-unavailable']);
  });

  it('counts admitted operations for the application scope and page-attributed ones for a shell', () => {
    const admissionBusy = collectCloseLiveUse(
      APPLICATION,
      idlePort({ admission: () => admissionTable({ inFlightOperations: 2 }) })
    );
    assert.equal(admissionBusy.state, 'busy');
    assert.deepEqual(categories(admissionBusy), ['in-flight-operation']);
    assert.equal(
      admissionBusy.reasons?.[0]?.control?.id,
      CLOSE_LIVE_USE_CONTROLS.runs.id,
      'an in-flight operation names the control that stops the work that owns it'
    );

    // The same process-wide counter cannot be attributed to one window, so it does not by
    // itself refuse that window's close: a sibling's admitted work is a sibling's problem.
    const shellWithGlobalCounter = collectCloseLiveUse(
      SHELL_A,
      idlePort({ admission: () => admissionTable({ inFlightOperations: 2 }) })
    );
    assert.equal(shellWithGlobalCounter.state, 'idle');

    // A page-scoped question reads the port's own counters, per page.
    const pageBusy = collectCloseLiveUse(
      SHELL_A,
      idlePort({ operationCounters: () => ({ pools: counter({ 'tab-2': 1 }) }) })
    );
    assert.equal(pageBusy.state, 'busy');
    assert.equal(pageBusy.reasons?.[0]?.tabId, 'tab-2');

    // ...and the admission table's page-attributed count, which is how an admitted
    // operation (a capability dispatch that named this page) is seen by a shell question
    // instead of being averaged into a process-wide number.
    const admittedOnPage = collectCloseLiveUse(
      SHELL_A,
      idlePort({ admission: () => admissionTable({ inFlightOperations: 3 }, { 'tab-2': 2 }) })
    );
    assert.equal(admittedOnPage.state, 'busy');
    assert.deepEqual(categories(admittedOnPage), ['in-flight-operation']);
    assert.equal(admittedOnPage.reasons?.[0]?.tabId, 'tab-2');
    assert.match(details(admittedOnPage), /2 background operation/);
    assert.equal(admittedOnPage.reasons?.[0]?.control?.id, CLOSE_LIVE_USE_CONTROLS.runs.id);

    // The three sources compose: a question cannot be answered from some of them.
    const composed = collectCloseLiveUse(
      SHELL_A,
      idlePort({
        operationCounters: () => ({ pools: counter({ 'tab-1': 1 }), waits: counter({ 'tab-1': 1 }) }),
        admission: () => admissionTable({}, { 'tab-1': 1 }),
      })
    );
    assert.equal(composed.state, 'busy');
    assert.match(details(composed), /3 background operation/);
  });

  it('counts owner-attributed admitted operations for the shell question only', () => {
    // A mint a window's chrome asked for names the owner and no page, so only the
    // owner-attributed count can see it: page and process-wide counts stay zero.
    const shell = collectCloseLiveUse(
      SHELL_A,
      idlePort({ admission: () => admissionTable({}, {}, { 'project:a': 1 }) })
    );
    assert.equal(shell.state, 'busy', 'a PTY being minted for this window refuses its close');
    assert.deepEqual(categories(shell), ['in-flight-operation']);
    assert.match(details(shell), /Window project:a has 1 admitted operation/);
    assert.equal(shell.reasons?.[0]?.tabId, undefined, 'window work refuses the window, not a page');
    assert.equal(shell.reasons?.[0]?.control?.id, CLOSE_LIVE_USE_CONTROLS.runs.id);

    // Another window's owner is out of scope: its mint refuses its own close, not this one.
    const sibling = collectCloseLiveUse(
      SHELL_A,
      idlePort({ admission: () => admissionTable({}, {}, { 'project:b': 1 }) })
    );
    assert.equal(sibling.state, 'idle');

    // A page question must not read the owner count at all: closing one page does not
    // destroy work the window as a whole is having created. An unreadable count is the
    // proof the read never happens — consulting it could only answer unknown or busy.
    const PAGE_A: LiveUseRequest = { scope: 'page', ownerKey: 'project:a', pageIds: ['tab-1'], auxiliaryKeys: [] };
    const page = collectCloseLiveUse(PAGE_A, idlePort({ admission: () => admissionTable({}, {}, { 'project:a': 1 }) }));
    assert.equal(page.state, 'idle', 'the whole window\'s mint must not refuse one page\'s close');
    assert.equal(collectCloseLiveUse(PAGE_A, idlePort({ admission: () => ownerCountUnreadable() })).state, 'idle');

    // The application question reads the process-wide count, which the owner-attributed
    // read cannot change — and does not need the owner read at all.
    assert.equal(collectCloseLiveUse(APPLICATION, idlePort({ admission: () => ownerCountUnreadable() })).state, 'idle');
    const quitBusy = collectCloseLiveUse(
      APPLICATION,
      idlePort({ admission: () => ownerCountUnreadable(1) })
    );
    assert.equal(quitBusy.state, 'busy', 'the process-wide count refuses the quit on its own');
    assert.deepEqual(categories(quitBusy), ['in-flight-operation']);
  });

  it('answers a shell question unknown, never idle, when the owner-attributed count cannot be read', () => {
    const report = collectCloseLiveUse(SHELL_A, idlePort({ admission: () => ownerCountUnreadable() }));
    assert.equal(report.state, 'unknown', 'a window whose admitted work cannot be counted cannot close');
    assert.deepEqual(categories(report), ['evidence-unavailable']);
    assert.match(details(report), /Close reservations for window project:a could not be read/);
  });

  it('counts in-flight invocation records for the application scope only', () => {
    const busy = collectCloseLiveUse(APPLICATION, idlePort({ ledgerInFlight: () => 1 }));
    assert.equal(busy.state, 'busy');
    assert.equal(collectCloseLiveUse(SHELL_A, idlePort({ ledgerInFlight: () => 1 })).state, 'idle');
  });

  it('treats an unreadable owner as unknown, never as idle', () => {
    const thrower = (): never => {
      throw new Error('owner unavailable');
    };
    for (const port of [
      idlePort({ attachments: thrower }),
      idlePort({ runs: thrower }),
      idlePort({ admission: thrower }),
      idlePort({ affinities: thrower }),
      idlePort({ terminalState: thrower }),
      idlePort({ ledgerInFlight: thrower }),
    ]) {
      const report = collectCloseLiveUse(APPLICATION, port);
      assert.equal(report.state, 'unknown', 'a thrown read must refuse');
      assert.match(details(report), /could not be read/);
    }
    // The per-page sources are only read for a page-scoped question, so that is the scope
    // whose failure has to refuse: another window's admitted work must not, and its read
    // is never attempted.
    const countersFail = collectCloseLiveUse(SHELL_A, idlePort({ operationCounters: thrower }));
    assert.equal(countersFail.state, 'unknown');
    assert.match(details(countersFail), /operation counters could not be read/);
    const admittedFail = collectCloseLiveUse(
      SHELL_A,
      idlePort({
        admission: () => ({
          snapshot: () => ({ inFlightOperations: 0, reservedTabIds: [], applicationReserved: false }),
          inFlightOperationsOnPage: () => {
            throw new Error('admission table unavailable');
          },
          inFlightOperationsOnOwner: () => 0,
        }),
      })
    );
    assert.equal(admittedFail.state, 'unknown', 'a page-attributed read that fails refuses the page');
    assert.match(details(admittedFail), /Background operations on page tab-1/);
    const malformed = collectCloseLiveUse(APPLICATION, idlePort({ runs: () => [{ runId: '', state: 'streaming' }] }));
    assert.equal(malformed.state, 'unknown');
    assert.match(details(malformed), /without an id/);
  });

  it('refuses an application quit for an active binding without a page', () => {
    const report = collectCloseLiveUse(
      APPLICATION,
      idlePort({ attachments: () => [{ attachmentId: 'attachment-1', runId: 'run-1' }] })
    );
    assert.equal(report.state, 'busy');
    assert.match(details(report), /without a page binding/);
  });

  it('protects a page from a live agent affinity and ignores a closed one', () => {
    const alive = collectCloseLiveUse(
      SHELL_A,
      idlePort({ affinities: () => [{ terminalId: 'term-1', status: 'alive', tabIds: ['tab-1'] }] })
    );
    assert.equal(alive.state, 'busy');
    assert.deepEqual(categories(alive), ['agent-affinity']);
    assert.equal(alive.reasons?.[0]?.control?.id, CLOSE_LIVE_USE_CONTROLS.terminalPanel.id);

    const closed = collectCloseLiveUse(
      SHELL_A,
      idlePort({ affinities: () => [{ terminalId: 'term-1', status: 'closed', tabIds: ['tab-1'] }] })
    );
    assert.equal(closed.state, 'idle');

    const unreadable = collectCloseLiveUse(
      SHELL_A,
      idlePort({
        affinities: () => [{ terminalId: 'term-1', status: 'unknown' as unknown as 'alive', tabIds: ['tab-1'] }],
      })
    );
    assert.equal(unreadable.state, 'unknown');
  });

  it('protects a shell whose agent affinity lives on an offscreen tab it owns', () => {
    const report = collectCloseLiveUse(
      SHELL_A,
      idlePort({ affinities: () => [{ terminalId: 'term-1', status: 'alive', tabIds: ['tab-offscreen'], ownerKey: 'project:a' }] })
    );
    assert.equal(report.state, 'busy');
  });

  it('answers unknown, not idle, when the terminal session state cannot be established', () => {
    const unavailable = collectCloseLiveUse(
      APPLICATION,
      idlePort({ terminalState: () => ({ available: false, detail: 'the terminal host is not connected' }) })
    );
    assert.equal(unavailable.state, 'unknown');
    assert.match(details(unavailable), /terminal host is not connected/);

    const missingState = collectCloseLiveUse(
      APPLICATION,
      idlePort({ terminalState: () => ({ available: true, sessions: [{ id: 'term-1' }] }) })
    );
    assert.equal(missingState.state, 'unknown');
    assert.match(details(missingState), /reports no state/);
  });

  it('does not treat an existing terminal session as work by itself', () => {
    const report = collectCloseLiveUse(
      APPLICATION,
      idlePort({
        terminalState: () => ({
          available: true,
          sessions: [{ id: 'term-1', state: 'running' }, { id: 'term-2', state: 'sleeping' }, { id: 'term-3', state: 'exited' }],
        }),
      })
    );
    assert.equal(report.state, 'idle');
  });

  it('reports busy work ahead of unreadable evidence, and keeps the evidence reasons', () => {
    const report = collectCloseLiveUse(
      APPLICATION,
      idlePort({
        runs: () => [{ runId: 'run-1', state: 'queued' }],
        terminalState: () => ({ available: false, detail: 'the terminal host is not connected' }),
      })
    );
    assert.equal(report.state, 'unknown');
    assert.deepEqual(categories(report), ['evidence-unavailable', 'run-queued']);
  });
});

/**
 * The shell question over the real owners.
 *
 * These rows drive the shipping seam between the owners and this module — the close
 * reservation table, the browser port (including its viewport gate) and the attachment
 * registry — because that seam is where a wrong `idle` came from: the port registered the
 * operation it admitted but the shell question never read the page-attributed count back.
 * The same seam carries the owner-attributed count, which is the only evidence a mint
 * asked for from a window's chrome can produce.
 * A stand-in port cannot prove the seam; these rows use the owners the composition root
 * actually injects (see `closeLiveUsePort` in `src/main/index.ts`).
 */

/** The live-use port as the composition root assembles it, so only the seam is under test. */
function wiredPort(sources: {
  admission: CloseAdmissionTable;
  browser?: BrowserControlPort;
  attachments?: () => readonly CloseLiveUseAttachment[];
}): CloseLiveUsePort {
  return {
    admission: () => sources.admission,
    operationCounters: () => ({ pools: sources.browser?.passivePool, waits: sources.browser?.waitRegistry }),
    ledgerInFlight: () => 0,
    runs: () => [],
    attachments: sources.attachments ?? (() => []),
    affinities: () => [],
    terminalState: () => ({ available: true, sessions: [] }),
  };
}

/**
 * A browser host whose agent click settles at once, or is held open until the case
 * releases it, so a query runs while the action is really in flight.
 */
function agentHost(options?: { hold?: boolean }) {
  const state = { clicks: 0 };
  let settle: (value: boolean) => void = () => {};
  const gate = options?.hold
    ? new Promise<boolean>((resolve) => {
        settle = resolve;
      })
    : null;
  const host: BrowserHostPort = {
    hasTab: () => true,
    resolveTargetTabId: (tabId?: string | null) => (tabId ? tabId : undefined),
    getTabList: () => [],
    navigate: () => true,
    reload: () => true,
    getDom: async () => '<html></html>',
    captureScreenshot: async () => '',
    evalJs: async () => null,
    agentClick: async () => {
      state.clicks += 1;
      return await (gate ?? Promise.resolve(true));
    },
  };
  return { host, settle: (value: boolean) => settle(value), clicks: () => state.clicks };
}

/** Mint a binding on `tabId`, optionally owned by a named process. */
async function mintAttachment(registry: AttachmentRegistry, tabId: string, boundPid?: number) {
  const projectId = makeControlPlaneId('project');
  const workspaceId = makeControlPlaneId('workspace');
  const lease = issueRuntimeLease(projectId, workspaceId, 3_600_000, 1);
  return await registry.issueAttachment(makeControlPlaneId('run'), makeControlPlaneId('attempt'), projectId, workspaceId, {
    backendId: 'test-backend',
    lease,
    leaseToken: lease.token,
    tabId,
    ...(boundPid === undefined ? {} : { boundPid }),
  });
}

/** The registry read the composition root performs, through the same projection it uses. */
function attachmentEvidence(registry: AttachmentRegistry): CloseLiveUseAttachment[] {
  const records: CloseLiveUseAttachmentRecord[] = [];
  for (const attachmentId of registry.getActiveRecordIds()) {
    const record = registry.getRecord(attachmentId);
    if (!record) continue;
    records.push({
      id: record.id,
      state: record.state,
      expiresAt: record.expiresAt,
      runId: record.runId,
      tabId: record.tabId,
      browserTarget: record.browserTarget ? { tabId: record.browserTarget.tabId } : undefined,
    });
  }
  return projectLiveUseAttachments(records, Date.now(), () => undefined);
}

describe('close live-use evidence — the shell question over the real owners', () => {
  it('answers busy for a shell while an agent action runs on its page, and idle once it settles', async () => {
    const reservations = new PageCloseReservations();
    const { host, settle } = agentHost({ hold: true });
    const browser = new BrowserControlPort(host);
    // The seam the composition root injects: without it the port admits work that no
    // close can see, which is exactly the `idle` this row exists to prevent.
    browser.setCloseAdmission(reservations);
    const port = wiredPort({ admission: reservations, browser });

    const action = browser.agentClick({ selector: '#submit', tabId: 'tab-1' });
    await yieldToLoop();

    const during = collectCloseLiveUse(SHELL_A, port);
    assert.equal(during.state, 'busy', 'an agent action in flight is work, not an idle shell');
    assert.deepEqual(categories(during), ['in-flight-operation']);
    assert.equal(during.reasons?.[0]?.tabId, 'tab-1');
    assert.equal(during.reasons?.[0]?.control?.id, CLOSE_LIVE_USE_CONTROLS.runs.id);
    assert.equal(collectCloseLiveUse(APPLICATION, port).state, 'busy', 'and the quit question sees it too');

    settle(true);
    assert.deepEqual(await action, { clicked: true }, 'the held action completed once it was released');

    assert.equal(collectCloseLiveUse(SHELL_A, port).state, 'idle', 'the release is what the close waits for');
  });

  it('refuses a shell close for a mint the window asked for, and leaves its pages out of the refusal', () => {
    const reservations = new PageCloseReservations();
    const port = wiredPort({ admission: reservations });
    const PAGE_A: LiveUseRequest = { scope: 'page', ownerKey: 'project:a', pageIds: ['tab-1'], auxiliaryKeys: [] };

    // What the terminal RPC hands its host's admission: the window's owner and no page, because
    // a sidebar sender is chrome. Only the owner-attributed read can see this mint.
    const release = reservations.beginAdmittedOperation(undefined, 'project:a');

    const shell = collectCloseLiveUse(SHELL_A, port);
    assert.equal(shell.state, 'busy', 'the shell close must wait for the PTY being minted for it');
    assert.deepEqual(categories(shell), ['in-flight-operation']);
    assert.equal(shell.reasons?.[0]?.control?.id, CLOSE_LIVE_USE_CONTROLS.runs.id);
    assert.equal(collectCloseLiveUse(APPLICATION, port).state, 'busy', 'and the quit question sees it too');

    // The page question is about pages, and the mint is not: closing one of them must not be
    // refused for the terminal the window as a whole is having created.
    assert.equal(collectCloseLiveUse(PAGE_A, port).state, 'idle');

    release();
    assert.equal(collectCloseLiveUse(SHELL_A, port).state, 'idle', 'the release is what the close waits for');
  });

  it('answers a shell question idle for work another window admitted', () => {
    const reservations = new PageCloseReservations();
    const port = wiredPort({ admission: reservations });

    const release = reservations.beginAdmittedOperation('tab-9', 'project:b');
    assert.equal(collectCloseLiveUse(SHELL_A, port).state, 'idle', 'another window\'s work refuses its own close, not this one');

    release();
    assert.equal(collectCloseLiveUse(SHELL_A, port).state, 'idle');
  });

  it('refuses an agent action on a page reserved for close, and admits it again after the release', async () => {
    const reservations = new PageCloseReservations();
    const { host, clicks } = agentHost();
    const browser = new BrowserControlPort(host);
    browser.setCloseAdmission(reservations);

    const release = reservations.reservePages(['tab-1']);
    await assert.rejects(
      () => browser.agentClick({ selector: '#submit', tabId: 'tab-1' }),
      (err: unknown) => err instanceof CapabilityError && err.code === 'TARGET_STALE',
      'a page an attempt is closing accepts no new action'
    );
    assert.equal(clicks(), 0, 'the reserved page never saw the action');

    release();
    assert.deepEqual(await browser.agentClick({ selector: '#submit', tabId: 'tab-1' }), { clicked: true }, 'the release reopens it');
    assert.equal(clicks(), 1);
  });

  it('refuses an agent action while application admission is reserved for a quit', async () => {
    const reservations = new PageCloseReservations();
    const { host, clicks } = agentHost();
    const browser = new BrowserControlPort(host);
    browser.setCloseAdmission(reservations);

    const release = reservations.reserveApplicationAdmission();
    await assert.rejects(
      () => browser.agentClick({ selector: '#submit', tabId: 'tab-1' }),
      (err: unknown) => err instanceof CapabilityError && err.code === 'RUNTIME_DRAINING',
      'a quitting application admits no new work'
    );
    assert.equal(clicks(), 0, 'the page never saw the action');

    release();
    assert.deepEqual(await browser.agentClick({ selector: '#submit', tabId: 'tab-1' }), { clicked: true }, 'a cancelled quit reopens admission');
  });

  it('clears the refusal through the release the named control performs', async () => {
    const registry = new AttachmentRegistry();
    const minted = await mintAttachment(registry, 'tab-1');
    const port = wiredPort({
      admission: new PageCloseReservations(),
      attachments: () => attachmentEvidence(registry),
    });

    const busy = collectCloseLiveUse(SHELL_A, port);
    assert.equal(busy.state, 'busy');
    assert.equal(busy.reasons?.[0]?.control?.id, CLOSE_LIVE_USE_CONTROLS.attachments.id);

    // Exactly what `antifan.cli.endSession` does: RunService.endCliSession revokes the
    // binding, and the same durable mutation both clears the record and disposes its owner.
    await registry.revokeForAttempt(minted.launch.attemptId);

    assert.equal(collectCloseLiveUse(SHELL_A, port).state, 'idle', 'the named control clears the state it was named for');
  });

  it('releases a binding whose owner process is gone, and keeps one whose owner may still be alive', async () => {
    const gone = new AttachmentRegistry({ isOwnerProcessAlive: () => false });
    await mintAttachment(gone, 'tab-1', 4242);
    const gonePort = wiredPort({ admission: new PageCloseReservations(), attachments: () => attachmentEvidence(gone) });
    assert.equal(collectCloseLiveUse(SHELL_A, gonePort).state, 'busy', 'a dead owner still refuses until it is reclaimed');

    const released = await gone.revokeGoneOwnerAttachments();
    assert.equal(released.revoked.length, 1, 'the dead owner is the only reason to reclaim it');
    assert.equal(released.retained, 0);
    assert.equal(collectCloseLiveUse(SHELL_A, gonePort).state, 'idle', 'the reclaim is what makes the refusal reachable');

    // The other direction: an owner that is alive (or cannot be read) keeps its binding, so
    // the cleanup path cannot steal a live session's page.
    const alive = new AttachmentRegistry({ isOwnerProcessAlive: () => true });
    await mintAttachment(alive, 'tab-1', 4242);
    const kept = await alive.revokeGoneOwnerAttachments();
    assert.deepEqual(kept, { revoked: [], expired: [], retained: 1 });
    assert.equal(
      collectCloseLiveUse(SHELL_A, wiredPort({ admission: new PageCloseReservations(), attachments: () => attachmentEvidence(alive) })).state,
      'busy'
    );
  });
});
