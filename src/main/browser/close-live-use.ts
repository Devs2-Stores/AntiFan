/**
 * AntiFan Browser Desktop — Close live-use evidence
 *
 * The close coordinator never guesses whether shared work is active: it asks this module,
 * which reads the process's authoritative owners and answers `idle`, `busy` or `unknown`
 * for the scope it was asked about. It is deliberately electron-free and every owner is
 * injected, so the classification is deterministic under test while the real wiring stays
 * in `src/main/index.ts`.
 *
 * Contract notes the wiring MUST honor:
 * - A source that throws, disappears or answers something malformed is UNKNOWN, never
 *   idle. Fail-closed is the whole point: a close may not destroy work because an
 *   evidence owner failed to answer.
 * - Busy evidence is named work: an active attachment binding a page, a non-terminal run,
 *   an admitted operation, or a verified live agent affinity. Terminal session existence
 *   alone is NOT evidence of work — an idle shell prompt is not agent activity — but a
 *   terminal state that cannot be read is, and answers unknown instead of idle.
 * - Only evidence attributable to the pages in scope is considered for `shell`/`page`
 *   scope. The process-wide counters (admitted operations, ledger in-flight records) are
 *   the authority for `application` scope only, because they cannot be attributed to one
 *   page and would otherwise refuse a close of an unrelated window. A `shell`/`page`
 *   question instead reads the per-page counters, which include every admitted operation
 *   that named its page: work aimed at this window's pages refuses the close, work aimed
 *   somewhere else does not.
 * - A `shell` question additionally reads the owner-attributed count, because not every
 *   operation a window asks for has a page: a PTY minted from the window's own sidebar is
 *   that window's work and no page's, so nothing else would see it. A `page` question must
 *   NOT read that count — closing one page does not destroy work the window as a whole is
 *   having created — and `application` scope does not need it, since its process-wide
 *   count already covers every admitted operation.
 * - A non-terminal run counts for `shell`/`page` scope only when one of its attachments
 *   binds a page in scope: a run with no page of this window is another window's work.
 */
import type {
  LiveUseCategory,
  LiveUseControl,
  LiveUseReason,
  LiveUseReport,
  LiveUseRequest,
} from './project-close-coordinator';

/** One run of this process, as the evidence needs it: identity and current state. */
export interface CloseLiveUseRun {
  readonly runId: string;
  readonly state: string;
}

/** One attachment binding a page right now. */
export interface CloseLiveUseAttachment {
  readonly attachmentId: string;
  readonly runId: string;
  readonly tabId?: string;
  /**
   * Owner key of the shell that presents the bound page. It is the scope link for a binding
   * whose tab is associated with the shell: closing that shell destroys the binding.
   */
  readonly ownerKey?: string;
  readonly backendId?: string;
}

/** One terminal affinity entry, with every page it may address. */
export interface CloseLiveUseAffinity {
  readonly terminalId: string;
  readonly status: 'alive' | 'closed';
  readonly tabIds: readonly string[];
  /** Owner key of the shell that presents the affinity's pages; see `CloseLiveUseAttachment`. */
  readonly ownerKey?: string;
}

/** One terminal session, with the state the manager reports for it. */
export interface CloseLiveUseTerminalSession {
  readonly id: string;
  /** Absent means the terminal state could not be established — unknown, never idle. */
  readonly state?: string;
}

/**
 * Terminal state, three-valued like every other source: `available: false` means the
 * sessions that exist cannot be enumerated (an unreachable terminal host), so no
 * affinity can be verified and the answer is unknown.
 */
export type CloseLiveUseTerminalState =
  | { readonly available: true; readonly sessions: readonly CloseLiveUseTerminalSession[] }
  | { readonly available: false; readonly detail: string };

/**
 * The close-admission table as this module reads it. `PageCloseReservations` (the singleton
 * table of `project-close-coordinator`) satisfies it as it stands, and a test can answer
 * with a hand-built table because the type is structural.
 *
 * All three reads live on ONE object deliberately. A shell question is answered from
 * the same authority as the process-wide one, so a consumer cannot wire the process-wide
 * count and forget the attributed counts: the per-page read is what makes an admitted
 * operation that named its page visible, and the per-owner read is what makes a mint
 * asked for by a window's chrome — which names no page at all — visible to that
 * window's close. A wiring that dropped either answered `idle` under real work.
 */
export interface CloseAdmissionTable {
  /** Process-wide state: admitted operations in flight, reserved pages, application reservation. */
  snapshot(): {
    readonly inFlightOperations: number;
    readonly reservedTabIds: readonly string[];
    readonly applicationReserved: boolean;
  };
  /** Admitted operations that named ONE page and have not released it. */
  inFlightOperationsOnPage(tabId: string): number;
  /**
   * Admitted operations that named ONE owner and have not released it. Read for `shell`
   * scope only, because the owner is a whole window's identity: work a window asks for
   * through its chrome (a PTY being minted from its sidebar) names no page, so the
   * page-attributed count above cannot see it, while the process-wide count would refuse
   * unrelated windows. A `page` question must not read it — closing one page does not
   * destroy work the window as a whole is having created.
   */
  inFlightOperationsOnOwner(ownerKey: string): number;
}

/**
 * The authoritative owners this module reads. Every method is a raw read: no
 * classification, no policy, no caching — a throw from any of them becomes `unknown`.
 */
export interface CloseLiveUsePort {
  /** The singleton close-admission table (see {@link CloseAdmissionTable}). */
  admission(): CloseAdmissionTable;
  /**
   * The browser port's own per-page counters, when the process has one. This module
   * composes them with the admission table through `countPageOperations`, so no scope can
   * silently drop a source: a question that counted only some of them would answer `idle`
   * under work it never saw.
   */
  operationCounters(): { readonly pools?: PageOperationCounter; readonly waits?: PageOperationCounter };
  /** In-flight invocation records the control plane holds, or null before it exists. */
  ledgerInFlight(): number | null;
  /** Every run this process knows, from the control plane's run service. */
  runs(): readonly CloseLiveUseRun[];
  /** Every attachment currently binding a page. */
  attachments(): readonly CloseLiveUseAttachment[];
  /** Every agent affinity entry, verified against a live terminal session. */
  affinities(): readonly CloseLiveUseAffinity[];
  /** Terminal session state, or why it cannot be read. */
  terminalState(): CloseLiveUseTerminalState;
}

/**
 * Existing stop/release controls a refusal points at. The close gate never offers a force
 * override: the user finishes or stops the named work through the surface that owns it.
 *
 * Every id below is an action that exists in this codebase and really releases the state
 * the reason names — a refusal that pointed at a control nobody implements would leave the
 * user with a dead close button (see the source comment on each entry).
 */
export const CLOSE_LIVE_USE_CONTROLS: {
  readonly terminalPanel: LiveUseControl;
  readonly attachments: LiveUseControl;
  readonly runs: LiveUseControl;
} = {
  /**
   * The terminal workbench's close. `antifan:terminal:close-session` (registered in
   * `browser/native-tab-host.ts`, wired to the ✕ on the terminal tab) clears the session's
   * affinity before closing it, and the host reports no affinity for a session that no
   * longer exists — which is what the `agent-affinity` evidence reads. Sleeping a session
   * keeps its affinity, so sleep is not a release.
   */
  terminalPanel: {
    id: 'antifan:terminal:close-session',
    label: 'Close the terminal session that owns this page (✕ on the terminal tab in the terminal workbench), or stop the agent session running in it',
  },
  /**
   * The agent session that minted the binding. `antifan.cli.endSession` (bridge-server)
   * ends its run and attempt and revokes the binding; the same release happens without
   * anyone asking when the lease ends or the bound owner process is gone, which is what
   * `AttachmentRegistry.revokeGoneOwnerAttachments` performs before a close measures it.
   */
  attachments: {
    id: 'antifan.cli.endSession',
    label: 'Stop the agent session that holds this page where it was started; a binding whose owner process is gone is released automatically',
  },
  /**
   * A run stops where it was started: `antifan:workflow:abort` is the toolbar stop button
   * for a workflow run, and an agent run ends with its own session
   * (`antifan.cli.endSession`), which is also what settles the attachment behind it.
   *
   * This is also the control for admitted work that is in flight: an operation belongs to
   * the run that dispatched it, and stopping that run aborts the operation's own signal,
   * which releases the counter a close measured (capability dispatch clears its admission
   * on cancellation — see `close-admission-seam`); an operation nobody stops settles on its
   * own deadline, which is why the label ends with it.
   */
  runs: {
    id: 'antifan:workflow:abort',
    label: 'Stop the run where it was started (the toolbar stop button for a workflow, the agent client for its own run), or wait for it to finish',
  },
};

/** A per-page in-flight counter, as the browser port's pools and waits expose it. */
export interface PageOperationCounter {
  getActiveTabCount(tabId: string): number;
}

/** The close-admission table's page-attributed read (see `PageCloseReservations`). */
export interface PageAdmittedOperationCounter {
  inFlightOperationsOnPage(tabId: string): number;
}

/**
 * In-flight operations on one page, composed from every seam that admits work onto it:
 *
 * - the browser port's background pool and wait registry, which count their own work per
 *   tab (`getActiveTabCount`);
 * - the close-admission table's page-attributed admitted operations, which is how a
 *   capability dispatch and every operation admitted through the port's viewport gate
 *   become visible to a shell or page question even outside the pool windows (authority
 *   checks, target healing, inspection and post-processing, agent actions).
 *
 * `collectCloseLiveUse` calls this with the sources it was handed, so the composition
 * happens in this module rather than in the wiring: a consumer that supplied only some of
 * the seams would answer `idle` under the work it never counted.
 *
 * A source that cannot be read or answers something that is not a count throws: the
 * caller answers `unknown`, never idle. A missing source contributes nothing, which is the
 * honest answer for a process with no browser port or no admission table yet.
 */
export function countPageOperations(
  tabId: string,
  sources: {
    readonly pools?: PageOperationCounter;
    readonly waits?: PageOperationCounter;
    readonly admitted?: PageAdmittedOperationCounter;
  }
): number {
  let total = 0;
  for (const source of [sources.pools, sources.waits]) {
    if (!source) continue;
    total += readCount(source.getActiveTabCount(tabId), 'the background operation counters');
  }
  if (sources.admitted) {
    total += readCount(sources.admitted.inFlightOperationsOnPage(tabId), 'the close-admission table');
  }
  return total;
}

/** One attachment record as the registry keeps it, for the projection below. */
export interface CloseLiveUseAttachmentRecord {
  readonly id: string;
  readonly state: string;
  readonly expiresAt: number;
  readonly runId: string;
  readonly tabId?: string;
  readonly browserTarget?: { readonly tabId?: string };
  readonly backendId?: string;
}

/**
 * Project the attachment registry's records into close evidence.
 *
 * An active record whose lease has not run out is a live binding and holds its page; a
 * revoked record, or one whose deadline already passed, holds nothing — its owner cannot
 * dispatch (`renewAttachment` and `validateLiveExecution` both refuse past the deadline)
 * and the registry keeps the row for audit, so a close must not be refused by history.
 * `ownerOfPage` supplies the presentation owner; a binding on a page the host no longer
 * presents keeps no owner link, so it is scoped by its page id alone (a dead page cannot
 * be closed and a shell close does not present it).
 */
export function projectLiveUseAttachments(
  records: readonly CloseLiveUseAttachmentRecord[],
  now: number,
  ownerOfPage: (tabId: string) => string | undefined
): CloseLiveUseAttachment[] {
  const attachments: CloseLiveUseAttachment[] = [];
  for (const record of records) {
    if (record.state !== 'active') continue;
    if (typeof record.expiresAt === 'number' && record.expiresAt <= now) continue;
    const tabId = record.browserTarget?.tabId ?? record.tabId;
    if (!tabId) {
      attachments.push({ attachmentId: record.id, runId: record.runId, backendId: record.backendId });
      continue;
    }
    const owner = ownerOfPage(tabId);
    attachments.push(
      owner
        ? { attachmentId: record.id, runId: record.runId, tabId, ownerKey: owner, backendId: record.backendId }
        : { attachmentId: record.id, runId: record.runId, tabId, backendId: record.backendId }
    );
  }
  return attachments;
}

/**
 * Terminal states this module can interpret: a live shell prompt and the states a session
 * rests in. Anything else — including a missing state — is unknown, never idle.
 */
const READABLE_TERMINAL_STATES: Record<string, true> = {
  running: true,
  exited: true,
  closed: true,
  sleeping: true,
};

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** A source answered something that is not the list it promised. */
function assertArray(value: unknown, source: string): readonly unknown[] {
  if (!Array.isArray(value)) throw new Error(`${source} did not return an array`);
  return value;
}

function readCount(value: unknown, source: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw new Error(`${source} did not return a count`);
  }
  return Math.trunc(value);
}

/** Page ids a request is about, trimmed and deduplicated so membership is exact. */
function scopePages(request: LiveUseRequest): Set<string> {
  const pages = new Set<string>();
  for (const raw of request.pageIds ?? []) {
    if (typeof raw !== 'string') continue;
    const id = raw.trim();
    if (id.length > 0) pages.add(id);
  }
  return pages;
}

/**
 * Is this evidence in scope for the question? Application scope protects everything. A
 * page-scoped question is about the pages it names, and about anything presented by the
 * shell it names: an agent tab or a binding on it dies with that shell.
 */
function evidenceInScope(
  request: LiveUseRequest,
  application: boolean,
  pages: ReadonlySet<string>,
  tabIds: readonly string[],
  ownerKey: string | undefined
): boolean {
  if (application) return true;
  if (tabIds.some((tabId) => pages.has(tabId))) return true;
  return ownerKey !== undefined && request.ownerKey !== null && ownerKey === request.ownerKey;
}

class Evidence {
  private readonly busy: LiveUseReason[] = [];
  private readonly unavailable: LiveUseReason[] = [];

  public refuseWork(category: LiveUseCategory, detail: string, control?: LiveUseControl, tabId?: string): void {
    const reason: { category: LiveUseCategory; detail: string; tabId?: string; control?: LiveUseControl } = { category, detail };
    if (tabId !== undefined && tabId.length > 0) reason.tabId = tabId;
    if (control) reason.control = control;
    this.busy.push(reason);
  }

  /** The evidence itself failed: the answer must be unknown, never idle. */
  public cannotTell(detail: string, control?: LiveUseControl): void {
    const reason: { category: LiveUseCategory; detail: string; control?: LiveUseControl } = {
      category: 'evidence-unavailable',
      detail,
    };
    if (control) reason.control = control;
    this.unavailable.push(reason);
  }

  public report(): LiveUseReport {
    if (this.unavailable.length > 0) return { state: 'unknown', reasons: [...this.unavailable, ...this.busy] };
    if (this.busy.length > 0) return { state: 'busy', reasons: [...this.busy] };
    return { state: 'idle', reasons: [] };
  }
}

/**
 * The state reported for a run this process cannot resolve through the project registry: an
 * orphaned run, or a run behind a live binding whose project is gone. It is deliberately not a
 * run-service state — the run service's own terminal set contains 'unknown', so folding an
 * unresolvable run into it would answer "finished" for work nobody can see.
 */
export const ORPHANED_RUN_STATE = 'unverifiable';

/**
 * Classify one run state. `null` means terminal (nothing in flight); `undefined` means the
 * state cannot be interpreted, which refuses rather than assuming completion. The run service's
 * own terminal set is completed/failed/interrupted/unknown — 'unknown' is how it reports a run
 * whose backend outcome could not be verified, so it is finished work and must not hold the
 * process open against a control (`antifan:workflow:abort`) that cannot settle it.
 */
function runCategory(state: unknown): LiveUseCategory | null | undefined {
  if (state === 'queued') return 'run-queued';
  if (state === 'waiting-tool') return 'run-awaiting';
  if (state === 'starting' || state === 'streaming' || state === 'cancelling') return 'run-active';
  if (state === 'completed' || state === 'failed' || state === 'interrupted' || state === 'unknown') return null;
  return undefined;
}

/**
 * Answer one live-use question for the close coordinator. Reads only; the caller decides
 * what a `busy` or `unknown` answer means (both refuse).
 */
export function collectCloseLiveUse(request: LiveUseRequest, port: CloseLiveUsePort): LiveUseReport {
  const evidence = new Evidence();
  const application = request.scope === 'application';
  const pages = scopePages(request);

  // 1. Admitted operations. The process-wide counter covers every consumer that registers
  //    work (capability dispatch, background pools, waits, the viewport gate) but cannot be
  //    attributed to a page, so it is the application-scope authority. A page-scoped
  //    question composes the same table's page-attributed count with the port's own
  //    counters below, so work aimed at one of its pages is real evidence rather than a
  //    process-wide guess.
  let admissionTable: CloseAdmissionTable | undefined;
  try {
    const table = port.admission();
    if (!table || typeof table !== 'object') throw new Error('the close-admission table is missing');
    admissionTable = table;
    const inFlight = readCount(table.snapshot().inFlightOperations, 'close reservations');
    if (application && inFlight > 0) {
      evidence.refuseWork(
        'in-flight-operation',
        `${inFlight} admitted operation(s) are still in flight; their results would be destroyed with the pages`,
        CLOSE_LIVE_USE_CONTROLS.runs
      );
    }
  } catch (error) {
    evidence.cannotTell(`Close reservations could not be read: ${errorText(error)}`, CLOSE_LIVE_USE_CONTROLS.runs);
  }

  if (application) {
    try {
      const ledgerInFlight = port.ledgerInFlight();
      if (ledgerInFlight !== null) {
        const count = readCount(ledgerInFlight, 'the invocation ledger');
        if (count > 0) {
          evidence.refuseWork(
            'in-flight-operation',
            `${count} connector invocation(s) are recorded in flight and would be settled by a shutdown`,
            CLOSE_LIVE_USE_CONTROLS.runs
          );
        }
      }
    } catch (error) {
      evidence.cannotTell(`In-flight invocations could not be read: ${errorText(error)}`, CLOSE_LIVE_USE_CONTROLS.runs);
    }
  } else {
    // The port's own counters are read once, and a failure of that read is unknown rather
    // than a silent zero: the pages below are still checked against what could be read, and
    // the failure itself refuses the question.
    let counters: { pools?: PageOperationCounter; waits?: PageOperationCounter } = {};
    try {
      counters = port.operationCounters() ?? {};
    } catch (error) {
      evidence.cannotTell(
        `The browser port's operation counters could not be read: ${errorText(error)}`,
        CLOSE_LIVE_USE_CONTROLS.runs
      );
    }
    for (const tabId of pages) {
      try {
        // Every seam that admits work onto a page is composed here, including the
        // admission table's page-attributed count: the module owns this composition because
        // a scope that read only the port's own pools would answer `idle` under an admitted
        // dispatch or an agent action running through the viewport gate.
        const operations = countPageOperations(tabId, {
          ...counters,
          ...(admissionTable ? { admitted: admissionTable } : {}),
        });
        if (operations > 0) {
          evidence.refuseWork(
            'in-flight-operation',
            `Page ${tabId} has ${operations} background operation(s) in flight`,
            CLOSE_LIVE_USE_CONTROLS.runs,
            tabId
          );
        }
      } catch (error) {
        evidence.cannotTell(
          `Background operations on page ${tabId} could not be read: ${errorText(error)}`,
          CLOSE_LIVE_USE_CONTROLS.runs
        );
      }
    }
  }

  // 1a. Owner-attributed admitted operations, for a shell question only. Work a window asks
  //     for through its own chrome — a PTY being minted for that shell — names no page, so the
  //     page-attributed counts above cannot see it, while the process-wide count would refuse
  //     unrelated windows. It is keyed by the window's owner, the identity the shell's own
  //     close attempt carries, and a page question must not read it: closing one page does not
  //     destroy work the window as a whole is having created.
  const shellOwnerKey = typeof request.ownerKey === 'string' ? request.ownerKey.trim() : '';
  if (!application && request.scope === 'shell' && shellOwnerKey.length > 0 && admissionTable) {
    try {
      const count = readCount(admissionTable.inFlightOperationsOnOwner(shellOwnerKey), 'close reservations (owner scope)');
      if (count > 0) {
        evidence.refuseWork(
          'in-flight-operation',
          `Window ${shellOwnerKey} has ${count} admitted operation(s) in flight; their results would be destroyed with its pages`,
          CLOSE_LIVE_USE_CONTROLS.runs
        );
      }
    } catch (error) {
      evidence.cannotTell(
        `Close reservations for window ${shellOwnerKey} could not be read: ${errorText(error)}`,
        CLOSE_LIVE_USE_CONTROLS.runs
      );
    }
  }

  // 2. Attachments. An attachment is authority to work on a page: while it is active the
  //    page must not be destroyed under it. Page scope considers only pages in scope.
  const attachmentsByPage = new Map<string, string[]>();
  const runPages = new Map<string, { tabs: Set<string>; owners: Set<string> }>();
  try {
    for (const entry of assertArray(port.attachments(), 'the attachment registry')) {
      if (!entry || typeof entry !== 'object') throw new Error('the attachment registry returned a non-object entry');
      const attachment = entry as Partial<CloseLiveUseAttachment>;
      if (typeof attachment.attachmentId !== 'string' || attachment.attachmentId.length === 0) {
        throw new Error('the attachment registry returned an entry without an id');
      }
      const tabId = typeof attachment.tabId === 'string' && attachment.tabId.length > 0 ? attachment.tabId : undefined;
      const ownerKey = typeof attachment.ownerKey === 'string' && attachment.ownerKey.length > 0 ? attachment.ownerKey : undefined;
      if (typeof attachment.runId === 'string' && attachment.runId.length > 0) {
        const bound = runPages.get(attachment.runId) ?? { tabs: new Set<string>(), owners: new Set<string>() };
        if (tabId) bound.tabs.add(tabId);
        if (ownerKey) bound.owners.add(ownerKey);
        runPages.set(attachment.runId, bound);
      }
      if (!tabId) {
        // An unbound MCP bridge transport connection (backendId === 'mcp' or 'omp') has no bound page,
        // no admitted turn, and is waiting for capability commands. It does not hold any page and must
        // not block application close.
        if (application && attachment.backendId !== 'mcp' && attachment.backendId !== 'omp') {
          evidence.refuseWork(
            'attachment-authority',
            `Attachment ${attachment.attachmentId} is active without a page binding`,
            CLOSE_LIVE_USE_CONTROLS.attachments
          );
        }
        continue;
      }
      if (!evidenceInScope(request, application, pages, [tabId], ownerKey)) continue;
      const ids = attachmentsByPage.get(tabId) ?? [];
      ids.push(attachment.attachmentId);
      attachmentsByPage.set(tabId, ids);
    }
  } catch (error) {
    evidence.cannotTell(`Active attachments could not be read: ${errorText(error)}`, CLOSE_LIVE_USE_CONTROLS.attachments);
  }
  for (const [tabId, ids] of attachmentsByPage) {
    evidence.refuseWork(
      'attachment-authority',
      `${ids.length} active attachment(s) hold page ${tabId}: ${ids.join(', ')}`,
      CLOSE_LIVE_USE_CONTROLS.attachments,
      tabId
    );
  }

  // 3. Runs. Application scope protects every non-terminal run; a shell/page question only
  //    counts a run whose attachment is in scope (a page of this shell, or the shell itself).
  try {
    for (const entry of assertArray(port.runs(), 'the run service')) {
      if (!entry || typeof entry !== 'object') throw new Error('the run service returned a non-object entry');
      const run = entry as Partial<CloseLiveUseRun>;
      if (typeof run.runId !== 'string' || run.runId.length === 0) {
        throw new Error('the run service returned a run without an id');
      }
      const bound = runPages.get(run.runId);
      const runOwner = request.ownerKey !== null && bound?.owners.has(request.ownerKey) ? request.ownerKey : undefined;
      const runScope = bound ? evidenceInScope(request, application, pages, [...bound.tabs], runOwner) : false;
      if (!application && !runScope) continue;
      const category = runCategory(run.state);
      if (category === null) continue;
      if (category === undefined) {
        evidence.cannotTell(
          `Run ${run.runId} reports state '${String(run.state)}', which is not a live-use state`,
          CLOSE_LIVE_USE_CONTROLS.runs
        );
        continue;
      }
      evidence.refuseWork(
        category,
        `Run ${run.runId} is ${String(run.state)}${bound && bound.tabs.size > 0 ? ` on page(s) ${[...bound.tabs].join(', ')}` : ''}`,
        CLOSE_LIVE_USE_CONTROLS.runs
      );
    }
  } catch (error) {
    evidence.cannotTell(`Runs could not be read: ${errorText(error)}`, CLOSE_LIVE_USE_CONTROLS.runs);
  }

  // 4. Agent affinities: an agent owns a terminal and the pages it may address. Verified
  //    against terminal state below, which is what makes this evidence rather than a guess.
  try {
    for (const entry of assertArray(port.affinities(), 'the terminal affinity map')) {
      if (!entry || typeof entry !== 'object') throw new Error('the terminal affinity map returned a non-object entry');
      const affinity = entry as Partial<CloseLiveUseAffinity>;
      if (typeof affinity.terminalId !== 'string' || affinity.terminalId.length === 0) {
        throw new Error('the terminal affinity map returned an entry without a terminal id');
      }
      if (affinity.status !== 'alive' && affinity.status !== 'closed') {
        evidence.cannotTell(
          `Agent affinity for terminal ${affinity.terminalId} reports status '${String(affinity.status)}'`,
          CLOSE_LIVE_USE_CONTROLS.terminalPanel
        );
        continue;
      }
      if (affinity.status !== 'alive') continue;
      const tabIds = (Array.isArray(affinity.tabIds) ? affinity.tabIds : []).filter(
        (tabId): tabId is string => typeof tabId === 'string' && tabId.length > 0
      );
      const affinityOwner =
        typeof affinity.ownerKey === 'string' && affinity.ownerKey.length > 0 ? affinity.ownerKey : undefined;
      if (!evidenceInScope(request, application, pages, tabIds, affinityOwner)) continue;
      evidence.refuseWork(
        'agent-affinity',
        `Agent terminal ${affinity.terminalId} owns page(s) ${tabIds.length > 0 ? tabIds.join(', ') : '(unknown)'}`,
        CLOSE_LIVE_USE_CONTROLS.terminalPanel,
        tabIds[0]
      );
    }
  } catch (error) {
    evidence.cannotTell(
      `Agent terminal affinities could not be read: ${errorText(error)}`,
      CLOSE_LIVE_USE_CONTROLS.terminalPanel
    );
  }

  // 5. Terminal state. Session existence is not work — an idle shell prompt is not agent
  //    activity — so this source only reports unknown: an unreachable terminal host means
  //    the affinities above cannot be verified, and an unreadable per-session state means
  //    the process cannot tell a live session from an archived one.
  try {
    const terminal = port.terminalState();
    if (terminal.available !== true) {
      evidence.cannotTell(`Terminal state is unavailable: ${terminal.detail}`, CLOSE_LIVE_USE_CONTROLS.terminalPanel);
    } else {
      for (const session of assertArray(terminal.sessions, 'the terminal session list') as CloseLiveUseTerminalSession[]) {
        if (!session || typeof session !== 'object') {
          evidence.cannotTell('The terminal session list returned a non-object entry', CLOSE_LIVE_USE_CONTROLS.terminalPanel);
          break;
        }
        if (session.state === undefined) {
          evidence.cannotTell(
            `Terminal session ${String(session.id)} reports no state, so the process cannot tell whether it is in use`,
            CLOSE_LIVE_USE_CONTROLS.terminalPanel
          );
          break;
        }
        if (READABLE_TERMINAL_STATES[session.state] !== true) {
          evidence.cannotTell(
            `Terminal session ${String(session.id)} reports an unknown state '${String(session.state)}'`,
            CLOSE_LIVE_USE_CONTROLS.terminalPanel
          );
          break;
        }
      }
    }
  } catch (error) {
    evidence.cannotTell(`Terminal state could not be read: ${errorText(error)}`, CLOSE_LIVE_USE_CONTROLS.terminalPanel);
  }

  return evidence.report();
}
