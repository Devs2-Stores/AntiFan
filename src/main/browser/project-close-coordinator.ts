/**
 * AntiFan Browser Desktop — Project Close Coordinator
 *
 * One state machine owns every destructive close of a browser shell and of
 * the application itself. It is deliberately electron-free: the native shell, the
 * tab authority, the live-use evidence queries and the shutdown routine are injected,
 * so the machine is deterministic under test and the real wiring stays in one place
 * (`src/main/index.ts`, `before-quit` / `window-all-closed`, and each shell's `closed`
 * path, plus surface adapters built on `ProjectWindowManager`).
 *
 * States per shell: `open -> checking -> closing-pages -> closed`, and back to `open`
 * on refusal, veto, failure or an unknown outcome. States per application:
 * `open -> checking -> closing-pages -> closed` (committed shutdown), and back to
 * `open` when the guard refuses or a late veto retains a surface.
 *
 * Contract notes later wiring MUST honor:
 * - The native `close` listener calls `event.preventDefault()` synchronously and only
 *   then `attemptClose(ownerKey, intent)`. By the time that call returns, the attempt
 *   exists, the shell phase is `checking` and every member page is reserved: a binding
 *   arriving during unload is refused instead of binding a page the attempt is about to
 *   destroy.
 * - `closePage` and `closeSelf` own the native side: register the exact-instance
 *   `destroyed` and `will-prevent-unload` observers BEFORE calling
 *   `webContents.close({ waitForBeforeUnload: true })` (close returns no awaitable
 *   result), NEVER call `preventDefault()` on `will-prevent-unload` — that overrides the
 *   page's veto — and settle `'unknown'` when no terminal outcome can be established.
 *   Every injected answer this module waits on is awaited under its own bound (see
 *   `INJECTED_OUTCOME_DEADLINE_MS`): silence is reported `unknown`, which refuses the
 *   attempt and retains the surface exactly like a veto. Nothing is ever destroyed on a
 *   timer, and no attempt can be held open by an answer that never comes — measured on this
 *   platform, a close issued while a previous refusal is still being processed is answered
 *   with no event at all, so a wait that trusts the platform can never settle.
 * - Live-use evidence is injected and three-valued. A failed, absent, malformed or silent
 *   answer is UNKNOWN and refuses; it is never read as idle. Nothing here inspects the shell
 *   process: an idle process is not evidence of agent activity.
 * - Browser shells are counted from the injected surface list, never from
 *   `BrowserWindow.getAllWindows`: capture hosts and terminal popouts are auxiliary
 *   surfaces — outside a shell snapshot, inside application-scope busy checks.
 * - No force override exists anywhere in this module, and a refused attempt never
 *   destroys a page, a shell or a service.
 * - Reservations are released on every terminal path (refusal, veto, failure, success);
 *   no lock is held across an await, so page-unload interaction never blocks another
 *   shell's close.
 */

/** Attempt phase. `closed` is terminal; every non-destructive exit restores `open`. */
export type ClosePhase = 'open' | 'checking' | 'closing-pages' | 'closed';

/** Who asked for the close. The intent is reported, not authoritative over teardown. */
export type CloseIntent = 'user' | 'quit';

export type CloseDisposition = 'closed' | 'retained';

/** Native outcome vocabulary of one page's unload-aware close. */
export type PageCloseOutcome = 'closed' | 'vetoed' | 'unknown';

/** Native outcome vocabulary of one shell's unload-aware close. */
export type SurfaceCloseOutcome = 'closed' | 'vetoed' | 'unknown';

/** Coordinator classification of a shell close; `failed` means the native call threw. */
export type SurfaceOutcomeKind = SurfaceCloseOutcome | 'failed';

/**
 * How long one injected answer may stay without a result before this module reports the
 * honest `unknown`.
 *
 * Measured on this platform: a polite native close is answered in 1-25ms, and a close
 * issued while a previous refusal is still being processed is answered with NOTHING at all
 * — no `close`, no `will-prevent-unload`, no `closed`. A gate that waited on the answer
 * alone therefore never settled, and because every later close or quit request coalesces
 * into the attempt that never ends, the application became unquittable while application
 * admission stayed reserved. The same silence can come from any injected collaborator (a
 * page close, a shell close, a live-use read), so every one of them is awaited under this
 * bound.
 *
 * Far above the measured round trip, so a genuinely closing surface or a slow evidence
 * read is never cut short, and far below a user's patience, so silence ends in a refusal
 * the user can retry instead of a gate that waits forever. A surface that is only slow is
 * still gone on the next attempt, which asks again.
 */
export const INJECTED_OUTCOME_DEADLINE_MS = 1_500;

/**
 * The answer arrived, or the bound expired first. The caller decides what silence means;
 * this type never carries a default that could be mistaken for a result.
 */
type BoundedAnswer<T> = { readonly answered: true; readonly value: T } | { readonly answered: false };

/**
 * Why an attempt stopped short of destroying the shell. One vocabulary for the attempt
 * halt reason, the refusal code and the skip reason of pages that were never attempted.
 */
export type CloseStopReason =
  | 'busy'
  | 'unknown-live-use'
  | 'unload-veto'
  | 'unknown-outcome'
  | 'native-close-failed'
  | 'ownership-changed'
  | 'new-arrival'
  | 'surface-missing'
  | 'shutdown-failed';

/**
 * Evidence categories a busy/unknown answer must distinguish. `evidence-unavailable` is
 * the category this module synthesizes when the query itself failed, answered with
 * something malformed, or could not be interpreted — never a fabricated activity claim.
 */
export type LiveUseCategory =
  | 'attachment-authority'
  | 'run-active'
  | 'run-queued'
  | 'run-awaiting'
  | 'in-flight-operation'
  | 'agent-affinity'
  | 'evidence-unavailable';

/** An existing stop/release control the user can use instead of a force override. */
export interface LiveUseControl {
  /** Stable identity of the control (route, panel or action id). */
  readonly id: string;
  /** Human label a refusal surface can show. */
  readonly label: string;
}

export interface LiveUseReason {
  readonly category: LiveUseCategory;
  readonly detail: string;
  /** Page this reason concerns, when the evidence is page-scoped. */
  readonly tabId?: string;
  readonly control?: LiveUseControl;
}

export type LiveUseState = 'idle' | 'busy' | 'unknown';

export interface LiveUseReport {
  readonly state: LiveUseState;
  readonly reasons?: readonly LiveUseReason[];
}

export interface LiveUseRequest {
  /**
   * `shell` — the member pages of one shell (a shell snapshot);
   * `page` — exactly one page, immediately before its close;
   * `application` — every shared-work owner: all browser member pages plus auxiliaries.
   */
  readonly scope: 'shell' | 'page' | 'application';
  /** Owner key for shell/page scope; null for application scope. */
  readonly ownerKey: string | null;
  readonly pageIds: readonly string[];
  /** Auxiliary surface keys in scope (terminal popouts, capture hosts). */
  readonly auxiliaryKeys: readonly string[];
}

export interface PageOutcome {
  readonly tabId: string;
  readonly outcome: 'closed' | 'skipped' | 'failed';
  /** Absent for closed pages. */
  readonly reason?: CloseStopReason | 'not-a-member';
  /** False when the page was never attempted because the queue stopped first. */
  readonly attempted: boolean;
  /** Native error text for `failed` pages. */
  readonly detail?: string;
}

export interface CloseRefusal {
  readonly code: CloseStopReason;
  readonly detail: string;
  readonly tabId?: string;
  /** Existing stop/release controls. This module never offers a force override. */
  readonly controls: readonly LiveUseControl[];
}

export interface SurfaceOutcome {
  readonly key: string;
  readonly kind: 'browser' | 'auxiliary';
  readonly outcome: SurfaceOutcomeKind;
}

/**
 * One closable presentation surface. Browser shells participate in shell snapshots;
 * auxiliaries (capture hosts, terminal popouts) only in application-scope checks.
 */
export interface CloseSurface {
  /** Stable owner key for browser shells; a stable surface id for auxiliaries. */
  readonly key: string;
  readonly kind: 'browser' | 'auxiliary';
  /** Visible member page ids in presentation order; auxiliaries report none. */
  visibleMemberIds(): readonly string[];
  /**
   * Native unload-aware close of this surface. Resolving `'closed'` is the signal that
   * the surface's own local teardown (mapping, chrome, views) already ran; the
   * coordinator calls no second dispose hook. See the module header for the observer
   * and veto rules this implementation owns.
   */
  closeSelf(): Promise<SurfaceCloseOutcome>;
  /**
   * Re-present the surviving active page inside this shell after a partial close.
   * MUST NOT raise or focus a window. Never called with an empty survivor set.
   */
  restoreSurvivingLayout?(survivingTabIds: readonly string[]): void;
}

export interface ProjectCloseCoordinatorDeps {
  /** The singleton tab authority's close-admission seam; one instance per process. */
  readonly reservations: PageCloseReservations;
  /** Live presentation surfaces. Injected — `BrowserWindow.getAllWindows` is not a shell snapshot. */
  listSurfaces(): readonly CloseSurface[];
  /** Current surface for an owner key, or undefined once the surface is gone. */
  surfaceForOwner(ownerKey: string): CloseSurface | undefined;
  /** Presentation owner of a page (`ownerKey` of the `WindowOwner`), undefined when unowned. */
  ownerOfPage(tabId: string): string | undefined;
  /** Exact-instance unload-aware close of one page. See the module header. */
  closePage(tabId: string): Promise<PageCloseOutcome>;
  /** Authoritative live-use evidence. A throw, absence or malformed answer is UNKNOWN. */
  queryLiveUse(request: LiveUseRequest): LiveUseReport | Promise<LiveUseReport>;
  /**
   * Bound applied to every injected asynchronous answer this module waits on
   * (`queryLiveUse`, `closePage`, `closeSelf`, a shell attempt already running). Defaults
   * to `INJECTED_OUTCOME_DEADLINE_MS`; injectable so a test can prove the bound without
   * waiting the production value.
   */
  readonly outcomeDeadlineMs?: number;
  /**
   * Awaited persistence/session flush, global authority disposal, bridge close and
   * daemon-client disconnect — exactly once, only after every native closure succeeded.
   * MUST NOT kill the detached terminal daemon or any external process.
   */
  commitShutdown(): void | Promise<void>;
}

export interface PageReservationSnapshot {
  /** Tab ids reserved by an in-flight close attempt, in reservation order. */
  readonly reservedTabIds: readonly string[];
  /** Operations that registered an admitted-operation token and have not released it. */
  readonly inFlightOperations: number;
  /** True while an application attempt holds all admission closed. */
  readonly applicationReserved: boolean;
}

/**
 * The close-admission seam of the singleton tab authority.
 *
 * Consumers (attachment mint/rebind/adoption, capability dispatch, browser-control
 * in-flight accounting) consult this instance. Admission refuses while a page is
 * reserved, because a reserved page is inside an async close window and must not gain a
 * binding that the attempt is about to destroy. The pair "check admission synchronously,
 * then register" has no await in between, so it is atomic under the JS model.
 */
export class PageCloseReservations {
  private readonly reservedPages = new Map<string, number>();
  private readonly reservedOwners = new Map<string, number>();
  private readonly admittedPages = new Map<string, number>();
  private readonly admittedOwners = new Map<string, number>();
  private inFlightOperations = 0;
  private applicationDepth = 0;

  /** True from the moment an attempt reserves a page until it releases it. */
  public isPageReserved(tabId: string): boolean {
    const id = typeof tabId === 'string' ? tabId.trim() : '';
    if (id.length === 0) return false;
    return (this.reservedPages.get(id) ?? 0) > 0;
  }

  /**
   * Register one admitted operation, attributed to every page it will reach and to the
   * owner key it names.
   *
   * The operation is counted once for the process — `snapshot().inFlightOperations`,
   * the authority an application-scope quit is measured against — once for each named
   * page, which is what lets a shell or page question see work that is aimed at its own
   * pages instead of having to guess from a process-wide number, and once for the owner
   * key, which is what lets a *shell* question see work the window asked for without
   * naming a page (a PTY minted from its sidebar). The two attributions are deliberately
   * separate: a mint for a window is not work on each of its pages, so it must not refuse
   * a page's close. A caller that can name neither registers process-wide only, which is
   * exactly the evidence it can honestly support.
   *
   * The returned release function is idempotent and clears every counter exactly once,
   * so an error path that both catches and finallys cannot double-count.
   */
  public beginAdmittedOperation(tabIds?: string | readonly string[], ownerKey?: string): () => void {
    this.inFlightOperations += 1;
    const candidates = tabIds === undefined ? [] : typeof tabIds === 'string' ? [tabIds] : [...tabIds];
    const claimed = uniqueTabIds(candidates);
    for (const id of claimed) {
      this.admittedPages.set(id, (this.admittedPages.get(id) ?? 0) + 1);
    }
    const owner = typeof ownerKey === 'string' ? ownerKey.trim() : '';
    if (owner.length > 0) this.admittedOwners.set(owner, (this.admittedOwners.get(owner) ?? 0) + 1);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      if (this.inFlightOperations > 0) this.inFlightOperations -= 1;
      for (const id of claimed) {
        const current = this.admittedPages.get(id);
        if (current === undefined) continue;
        if (current <= 1) this.admittedPages.delete(id);
        else this.admittedPages.set(id, current - 1);
      }
      if (owner.length > 0) {
        const current = this.admittedOwners.get(owner);
        if (current !== undefined) {
          if (current <= 1) this.admittedOwners.delete(owner);
          else this.admittedOwners.set(owner, current - 1);
        }
      }
    };
  }

  /**
   * Admitted operations that named this page and have not released it. Read by the
   * close gate's busy snapshot for shell and page scope; a query for a page with no
   * attributed work answers zero, never a process-wide number (see
   * `beginAdmittedOperation`).
   */
  public inFlightOperationsOnPage(tabId: string): number {
    const id = typeof tabId === 'string' ? tabId.trim() : '';
    if (id.length === 0) return 0;
    return this.admittedPages.get(id) ?? 0;
  }

  /**
   * Admitted operations that named this owner and have not released it. Read for SHELL
   * scope only: the owner is a whole window's identity, and the work it names (a PTY being
   * minted for that window) outlives any single page. A page question must not read it —
   * closing one page does not destroy work the window as a whole is having created — and an
   * application question does not need it, because it already reads the process-wide count.
   */
  public inFlightOperationsOnOwner(ownerKey: string): number {
    const id = typeof ownerKey === 'string' ? ownerKey.trim() : '';
    if (id.length === 0) return 0;
    return this.admittedOwners.get(id) ?? 0;
  }

  public snapshot(): PageReservationSnapshot {
    return {
      reservedTabIds: [...this.reservedPages.keys()],
      inFlightOperations: this.inFlightOperations,
      applicationReserved: this.applicationDepth > 0,
    };
  }

  /** True while an application attempt has reserved all admission (a quit in progress). */
  public isApplicationAdmissionReserved(): boolean {
    return this.applicationDepth > 0;
  }

  /**
   * True from the moment an attempt reserves an owner until it releases it. Read
   * synchronously by `admitHostWork` before it registers anything, so work attributed to a
   * closing window — above all a PTY minted from its sidebar, which names no page and is
   * therefore invisible to the page reservations — is refused instead of being created
   * while that window closes.
   */
  public isOwnerReserved(ownerKey: string): boolean {
    const id = typeof ownerKey === 'string' ? ownerKey.trim() : '';
    if (id.length === 0) return false;
    return (this.reservedOwners.get(id) ?? 0) > 0;
  }

  /**
   * Reserve one window's admission for the whole async close window, including a shell with
   * no member pages left to reserve. The returned release function is idempotent.
   */
  public reserveOwnerAdmission(ownerKey: string): () => void {
    const id = typeof ownerKey === 'string' ? ownerKey.trim() : '';
    if (id.length === 0) return () => {};
    this.reservedOwners.set(id, (this.reservedOwners.get(id) ?? 0) + 1);
    return this.releaseOwnerToken(id);
  }

  private releaseOwnerToken(id: string): () => void {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const current = this.reservedOwners.get(id);
      if (current === undefined) return;
      if (current <= 1) this.reservedOwners.delete(id);
      else this.reservedOwners.set(id, current - 1);
    };
  }

  /**
   * Reserve every given page for the whole async close window. The returned release
   * function is idempotent: cancellation and error paths may call it twice safely.
   */
  public reservePages(tabIds: readonly string[]): () => void {
    const claimed = uniqueTabIds(tabIds);
    for (const id of claimed) {
      this.reservedPages.set(id, (this.reservedPages.get(id) ?? 0) + 1);
    }
    return this.releaseToken(claimed);
  }

  /**
   * Reserve application admission for the duration of a quit attempt. The returned
   * release function is idempotent; a refusal or a late veto reopens admission.
   */
  public reserveApplicationAdmission(): () => void {
    this.applicationDepth += 1;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      if (this.applicationDepth > 0) this.applicationDepth -= 1;
    };
  }

  private releaseToken(claimed: readonly string[]): () => void {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      for (const id of claimed) {
        const current = this.reservedPages.get(id);
        if (current === undefined) continue;
        if (current <= 1) this.reservedPages.delete(id);
        else this.reservedPages.set(id, current - 1);
      }
    };
  }
}

export interface CloseReport {
  readonly attemptId: number;
  readonly ownerKey: string;
  readonly intent: CloseIntent;
  /** Duplicate close requests that coalesced into this one attempt. */
  coalescedRequests: number;
  /** True when at least one duplicate request joined this attempt. */
  coalesced: boolean;
  readonly disposition: CloseDisposition;
  /** Terminal phase of this attempt; `open` means the shell was retained. */
  readonly phase: ClosePhase;
  readonly closed: readonly PageOutcome[];
  readonly skipped: readonly PageOutcome[];
  readonly failed: readonly PageOutcome[];
  readonly refusals: readonly CloseRefusal[];
  readonly haltedBy: CloseStopReason | null;
  readonly surface: SurfaceOutcome | null;
  /** Member pages the shell still presents; empty once the shell is gone. */
  readonly survivingTabIds: readonly string[];
  /** True when the shell was retained after closing at least one of its pages. */
  readonly partial: boolean;
  /** True when this attempt removed the last browser shell; the caller may start an orderly quit. */
  readonly lastBrowserShellGone: boolean;
  /** Non-terminal observations, for example a layout restore that failed. */
  readonly warnings: readonly string[];
  readonly summary: string;
}

export interface QuitReport {
  readonly attemptId: number;
  coalescedRequests: number;
  coalesced: boolean;
  /** `committed` only when every native closure succeeded AND commitShutdown resolved. */
  readonly shutdown: 'committed' | 'not-committed';
  /** Terminal application phase; `open` means surfaces and services survive. */
  readonly phase: ClosePhase;
  /**
   * Whether this attempt still holds application admission closed. A refusal releases
   * admission before its report is built, so a refused quit reports `false` — the state its
   * caller is handed — while a committed quit reports `true` with services already gone.
   */
  readonly admissionReserved: boolean;
  readonly shells: readonly CloseReport[];
  readonly auxiliaries: readonly SurfaceOutcome[];
  readonly closedShells: readonly string[];
  readonly survivingShells: readonly string[];
  readonly refusals: readonly CloseRefusal[];
  readonly haltedBy: CloseStopReason | null;
  readonly commitError?: string;
  readonly warnings: readonly string[];
  readonly summary: string;
}

interface AttemptHandle<T> {
  readonly id: number;
  coalesced: number;
  report?: T;
  readonly settled: Promise<T>;
  readonly settle: (report: T) => void;
  readonly fail: (error: unknown) => void;
}

interface LiveUseAnswer {
  readonly state: LiveUseState;
  readonly reasons: readonly LiveUseReason[];
}

function uniqueTabIds(values: readonly string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of values) {
    if (typeof raw !== 'string') continue;
    const id = raw.trim();
    if (id.length === 0 || seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  return out;
}

function errorText(error: unknown): string {
  if (error instanceof Error) return error.message;
  return typeof error === 'string' ? error : String(error);
}

function makeRefusal(
  code: CloseStopReason,
  detail: string,
  controls: readonly LiveUseControl[],
  tabId?: string
): CloseRefusal {
  return tabId === undefined
    ? { code, detail, controls: [...controls] }
    : { code, detail, controls: [...controls], tabId };
}

function isLiveUseCategory(value: unknown): value is LiveUseCategory {
  return (
    value === 'attachment-authority' ||
    value === 'run-active' ||
    value === 'run-queued' ||
    value === 'run-awaiting' ||
    value === 'in-flight-operation' ||
    value === 'agent-affinity' ||
    value === 'evidence-unavailable'
  );
}

function readReasons(value: unknown): LiveUseReason[] {
  if (!Array.isArray(value)) return [];
  const out: LiveUseReason[] = [];
  for (const entry of value) {
    if (!entry || typeof entry !== 'object') continue;
    const candidate = entry as Partial<LiveUseReason>;
    if (!isLiveUseCategory(candidate.category) || typeof candidate.detail !== 'string') continue;
    const reason: { category: LiveUseCategory; detail: string; tabId?: string; control?: LiveUseControl } = {
      category: candidate.category,
      detail: candidate.detail,
    };
    if (typeof candidate.tabId === 'string' && candidate.tabId.length > 0) reason.tabId = candidate.tabId;
    if (candidate.control && typeof candidate.control.id === 'string' && typeof candidate.control.label === 'string') {
      reason.control = { id: candidate.control.id, label: candidate.control.label };
    }
    out.push(reason);
  }
  return out;
}

function collectControls(reasons: readonly LiveUseReason[]): LiveUseControl[] {
  const out: LiveUseControl[] = [];
  const seen = new Set<string>();
  for (const reason of reasons) {
    if (!reason.control || seen.has(reason.control.id)) continue;
    seen.add(reason.control.id);
    out.push({ ...reason.control });
  }
  return out;
}

function evidenceDetail(reasons: readonly LiveUseReason[], fallback: string): string {
  if (reasons.length === 0) return fallback;
  return reasons.map((reason) => reason.detail).join('; ');
}

export class ProjectCloseCoordinator {
  private readonly deps: ProjectCloseCoordinatorDeps;
  private readonly pageAttempts = new Map<string, AttemptHandle<CloseReport>>();
  private applicationAttempt: AttemptHandle<QuitReport> | null = null;
  private readonly phaseByOwner = new Map<string, ClosePhase>();
  private applicationState: ClosePhase = 'open';
  private committedShutdown = false;
  private committedReport: QuitReport | null = null;
  private nextAttemptId = 1;
  /** Bound on every injected answer; see `INJECTED_OUTCOME_DEADLINE_MS`. */
  private readonly outcomeDeadlineMs: number;

  constructor(deps: ProjectCloseCoordinatorDeps) {
    this.deps = deps;
    const injected = deps.outcomeDeadlineMs;
    this.outcomeDeadlineMs =
      typeof injected === 'number' && Number.isFinite(injected) && injected > 0
        ? injected
        : INJECTED_OUTCOME_DEADLINE_MS;
  }

  /**
   * Await one injected answer under the module bound. An answer that arrives is returned
   * unchanged (a rejection included: a thrown native call is `failed`, never `unknown`);
   * silence resolves `{ answered: false }` so the caller reports `unknown` instead of
   * inventing a result. The timer is unref'd — a bound is a guard, never a reason to keep
   * the process alive.
   */
  private async awaitInjectedAnswer<T>(answer: Promise<T>): Promise<BoundedAnswer<T>> {
    const expiry = Promise.withResolvers<BoundedAnswer<T>>();
    const timer = setTimeout(() => expiry.resolve({ answered: false }), Math.max(1, this.outcomeDeadlineMs));
    timer.unref();
    try {
      return await Promise.race([
        Promise.resolve(answer).then((value): BoundedAnswer<T> => ({ answered: true, value })),
        expiry.promise,
      ]);
    } finally {
      clearTimeout(timer);
    }
  }

  /** Browser shells, counted from the injected directory — never from every BrowserWindow. */
  public browserShellCount(): number {
    return this.readSurfaces().filter((surface) => surface.kind === 'browser').length;
  }

  /** Last observed phase of one shell; `open` for a shell that was never attempted. */
  public phaseOf(ownerKey: string): ClosePhase {
    const key = typeof ownerKey === 'string' ? ownerKey.trim() : '';
    if (key.length === 0) return 'open';
    return this.phaseByOwner.get(key) ?? 'open';
  }

  public applicationPhase(): ClosePhase {
    return this.applicationState;
  }

  public isApplicationAdmissionReserved(): boolean {
    return this.deps.reservations.isApplicationAdmissionReserved();
  }

  public hasCommittedShutdown(): boolean {
    return this.committedShutdown;
  }

  /**
   * Close one shell. A duplicate request — including a quit-scoped one — coalesces into
   * the single active attempt instead of starting a second one. Callers prevent the
   * native close synchronously and then await this result; a retained report means the
   * shell (and every service) is still there and the close can be retried.
   */
  public attemptClose(ownerKey: string, intent: CloseIntent): Promise<CloseReport> {
    const key = typeof ownerKey === 'string' ? ownerKey.trim() : '';
    if (key.length === 0) throw new Error('attemptClose requires a non-empty owner key');
    if (intent !== 'user' && intent !== 'quit') {
      throw new Error(`attemptClose received an unknown intent: ${String(intent)}`);
    }

    // While an application attempt runs it owns every surface close, so a duplicate
    // window-close request is served by that attempt rather than starting a new one.
    const application = this.applicationAttempt;
    if (application) {
      application.coalesced += 1;
      return application.settled.then((report) => {
        if (application.report) application.report.coalescedRequests = application.coalesced;
        return projectReportFromQuit(report, key);
      });
    }

    const existing = this.pageAttempts.get(key);
    if (existing) {
      existing.coalesced += 1;
      if (existing.report) {
        existing.report.coalescedRequests = existing.coalesced;
        existing.report.coalesced = true;
      }
      return existing.settled;
    }

    return this.startShellAttempt(key, intent);
  }

  /**
   * Ordered application quit: reserve application admission, check every shared-work
   * owner, close each browser shell and then each auxiliary surface, and only after all
   * native closures succeed enter committed shutdown. Any refusal, veto or unknown
   * outcome keeps services usable and reopens admission.
   */
  public attemptQuit(): Promise<QuitReport> {
    const existing = this.applicationAttempt;
    if (existing) {
      existing.coalesced += 1;
      if (existing.report) {
        existing.report.coalescedRequests = existing.coalesced;
        existing.report.coalesced = true;
      }
      return existing.settled;
    }
    return this.startApplicationAttempt();
  }

  private startShellAttempt(ownerKey: string, intent: CloseIntent): Promise<CloseReport> {
    const deferred = Promise.withResolvers<CloseReport>();
    const handle: AttemptHandle<CloseReport> = {
      id: this.nextAttemptId++,
      coalesced: 0,
      settled: deferred.promise,
      settle: deferred.resolve,
      fail: deferred.reject,
    };
    this.pageAttempts.set(ownerKey, handle);
    void this.runClose(ownerKey, intent, handle.id).then(
      (report) => {
        report.coalescedRequests = handle.coalesced;
        report.coalesced = handle.coalesced > 0;
        handle.report = report;
        // Retire the handle BEFORE settling: a caller that retries as soon as it observes
        // the outcome must start a fresh attempt, never join this finished one.
        if (this.pageAttempts.get(ownerKey) === handle) this.pageAttempts.delete(ownerKey);
        handle.settle(report);
      },
      (error) => {
        if (this.pageAttempts.get(ownerKey) === handle) this.pageAttempts.delete(ownerKey);
        handle.fail(error);
      }
    );
    return handle.settled;
  }

  private startApplicationAttempt(): Promise<QuitReport> {
    const deferred = Promise.withResolvers<QuitReport>();
    const handle: AttemptHandle<QuitReport> = {
      id: this.nextAttemptId++,
      coalesced: 0,
      settled: deferred.promise,
      settle: deferred.resolve,
      fail: deferred.reject,
    };
    this.applicationAttempt = handle;
    void this.runQuit(handle.id).then(
      (report) => {
        report.coalescedRequests = handle.coalesced;
        report.coalesced = handle.coalesced > 0;
        handle.report = report;
        if (this.applicationAttempt === handle) this.applicationAttempt = null;
        handle.settle(report);
      },
      (error) => {
        if (this.applicationAttempt === handle) this.applicationAttempt = null;
        handle.fail(error);
      }
    );
    return handle.settled;
  }

  private async runClose(ownerKey: string, intent: CloseIntent, attemptId: number): Promise<CloseReport> {
    const closed: PageOutcome[] = [];
    const skipped: PageOutcome[] = [];
    const failed: PageOutcome[] = [];
    const refusals: CloseRefusal[] = [];
    const warnings: string[] = [];
    let haltedBy: CloseStopReason | null = null;
    let surfaceOutcome: SurfaceOutcome | null = null;
    let releaseOwnerAdmission: (() => void) | null = null;
    let releaseMemberReservations: (() => void) | null = null;
    let members: string[] = [];
    let lastObservedMembers: string[] = [];
    let disposition: CloseDisposition = 'retained';

    const finalize = (surviving: readonly string[]): CloseReport => ({
      attemptId,
      ownerKey,
      intent,
      coalescedRequests: 0,
      coalesced: false,
      disposition,
      phase: disposition === 'closed' ? 'closed' : 'open',
      closed: [...closed],
      skipped: [...skipped],
      failed: [...failed],
      refusals: [...refusals],
      haltedBy,
      surface: surfaceOutcome,
      survivingTabIds: [...surviving],
      partial: disposition === 'retained' && closed.length > 0,
      lastBrowserShellGone: disposition === 'closed' && this.browserShellCount() === 0,
      warnings: [...warnings],
      summary: closeSummary(ownerKey, disposition, closed.length, skipped.length, failed.length, haltedBy),
    });

    try {
      const surface = this.deps.surfaceForOwner(ownerKey);
      if (!surface) {
        refusals.push(makeRefusal('surface-missing', `No live surface is registered for ${ownerKey}`, []));
        haltedBy = 'surface-missing';
        return finalize([]);
      }
      assertSurface(surface, `surfaceForOwner(${ownerKey})`);

      // Synchronous prefix, before the first await: the shell is in `checking`, every
      // snapshot member is reserved for the whole async window, and so is the window's own
      // admission. The owner reservation is what makes a chrome mint — a terminal asked for
      // from this window's sidebar, which names no page — refuse for the entire window,
      // including a shell that has no member pages left to reserve.
      this.phaseByOwner.set(ownerKey, 'checking');
      members = uniqueTabIds(surface.visibleMemberIds());
      lastObservedMembers = members;
      releaseOwnerAdmission = this.deps.reservations.reserveOwnerAdmission(ownerKey);
      releaseMemberReservations = this.deps.reservations.reservePages(members);

      // Snapshot first, then ask policy about exactly those pages. Closing the last
      // browser shell is application-scoped: shared work elsewhere must refuse it, and
      // auxiliaries stay outside the shell snapshot but inside that scope.
      const surfaces = this.readSurfaces();
      const lastBrowserShell =
        surface.kind === 'browser' && surfaces.filter((entry) => entry.kind === 'browser').length <= 1;
      const shellEvidence = await this.readLiveUse({
        scope: lastBrowserShell ? 'application' : 'shell',
        ownerKey,
        pageIds: members,
        auxiliaryKeys: lastBrowserShell
          ? surfaces.filter((entry) => entry.kind === 'auxiliary').map((entry) => entry.key)
          : [],
      });
      if (shellEvidence.state !== 'idle') {
        haltedBy = shellEvidence.state === 'busy' ? 'busy' : 'unknown-live-use';
        refusals.push(
          makeRefusal(
            haltedBy,
            evidenceDetail(
              shellEvidence.reasons,
              shellEvidence.state === 'busy'
                ? `Live-use evidence reports ${ownerKey} busy`
                : `Live-use evidence is unavailable for ${ownerKey}`
            ),
            collectControls(shellEvidence.reasons)
          )
        );
        for (const tabId of members) {
          skipped.push({ tabId, outcome: 'skipped', reason: haltedBy, attempted: false });
        }
        warnings.push(`No page was closed: the shell was refused before its first close (${haltedBy}).`);
        return finalize(this.readMembers(surface, lastObservedMembers));
      }

      this.phaseByOwner.set(ownerKey, 'closing-pages');
      const processed = new Set<string>();

      for (const tabId of members) {
        processed.add(tabId);

        // Revalidate identity, membership and busy status immediately before this close.
        const currentMembers = this.readMembers(surface, lastObservedMembers);
        if (!currentMembers.includes(tabId)) {
          skipped.push({ tabId, outcome: 'skipped', reason: 'not-a-member', attempted: false });
          continue;
        }
        const ownerNow = this.deps.ownerOfPage(tabId);
        if (ownerNow !== undefined && ownerNow !== ownerKey) {
          haltedBy = 'ownership-changed';
          refusals.push(
            makeRefusal(
              'ownership-changed',
              `Page ${tabId} is now owned by ${ownerNow}; the close stopped before destroying it`,
              [],
              tabId
            )
          );
          skipped.push({ tabId, outcome: 'skipped', reason: 'ownership-changed', attempted: false });
          break;
        }
        const pageEvidence = await this.readLiveUse({
          scope: 'page',
          ownerKey,
          pageIds: [tabId],
          auxiliaryKeys: [],
        });
        if (pageEvidence.state !== 'idle') {
          haltedBy = pageEvidence.state === 'busy' ? 'busy' : 'unknown-live-use';
          refusals.push(
            makeRefusal(
              haltedBy,
              evidenceDetail(
                pageEvidence.reasons,
                pageEvidence.state === 'busy'
                  ? `Live-use evidence reports page ${tabId} busy`
                  : `Live-use evidence is unavailable for page ${tabId}`
              ),
              collectControls(pageEvidence.reasons),
              tabId
            )
          );
          skipped.push({ tabId, outcome: 'skipped', reason: haltedBy, attempted: false });
          break;
        }

        let outcome: PageCloseOutcome | 'threw';
        let failureDetail = '';
        let pageCloseTimedOut = false;
        try {
          const answer = await this.awaitInjectedAnswer(this.deps.closePage(tabId));
          if (answer.answered) {
            outcome = answer.value;
          } else {
            // The native side never answered. `unknown` is the honest verdict — the page is
            // retained, never destroyed on a timer — and the reservation is released below,
            // so silence refuses the close instead of freezing every later request into it.
            outcome = 'unknown';
            pageCloseTimedOut = true;
          }
        } catch (error) {
          outcome = 'threw';
          failureDetail = errorText(error);
        }
        lastObservedMembers = this.readMembers(surface, lastObservedMembers);

        if (outcome === 'closed') {
          closed.push({ tabId, outcome: 'closed', attempted: true });
          continue;
        }
        if (outcome === 'vetoed') {
          haltedBy = 'unload-veto';
          skipped.push({ tabId, outcome: 'skipped', reason: 'unload-veto', attempted: true });
          refusals.push(makeRefusal('unload-veto', `Page ${tabId} refused to unload`, [], tabId));
          break;
        }
        if (outcome === 'unknown') {
          // No timeout-driven destroy: a missing terminal outcome retains the whole shell.
          haltedBy = 'unknown-outcome';
          skipped.push({ tabId, outcome: 'skipped', reason: 'unknown-outcome', attempted: true });
          refusals.push(
            makeRefusal(
              'unknown-outcome',
              pageCloseTimedOut
                ? `Page ${tabId} produced no terminal close outcome within ${this.outcomeDeadlineMs}ms; the shell is retained`
                : `Page ${tabId} produced no terminal close outcome; the shell is retained`,
              [],
              tabId
            )
          );
          if (pageCloseTimedOut) {
            warnings.push(
              `Page ${tabId} never answered its native close within ${this.outcomeDeadlineMs}ms; nothing was destroyed.`
            );
          }
          break;
        }
        haltedBy = 'native-close-failed';
        failed.push({
          tabId,
          outcome: 'failed',
          reason: 'native-close-failed',
          attempted: true,
          detail: failureDetail,
        });
        refusals.push(
          makeRefusal('native-close-failed', `Native close of ${tabId} failed: ${failureDetail}`, [], tabId)
        );
        break;
      }

      if (!haltedBy) {
        const arrivals = this.readMembers(surface, lastObservedMembers).filter((id) => !members.includes(id));
        if (arrivals.length > 0) {
          haltedBy = 'new-arrival';
          refusals.push(
            makeRefusal(
              'new-arrival',
              `Pages appeared while the shell was closing: ${arrivals.join(', ')}`,
              []
            )
          );
          for (const tabId of arrivals) {
            skipped.push({ tabId, outcome: 'skipped', reason: 'new-arrival', attempted: false });
          }
        }

        // Work admitted *after* the snapshot read is the other way the shell could be
        // destroyed around its own work: a terminal asked for from this window's chrome
        // registers against the owner, names no page, and so is invisible to the member
        // checks above. The count is therefore re-read here, on the last synchronous step
        // before the shell closes itself, the same way membership is re-read for arrivals.
        // An attempt whose snapshot was application-scoped (the last browser shell) re-reads
        // the process-wide count too, so a later arrival from any window still halts it.
        const ownerInFlight = this.readOwnerInFlight(ownerKey);
        const applicationInFlight = lastBrowserShell ? this.readApplicationInFlight() : 0;
        if (ownerInFlight > 0 || applicationInFlight > 0) {
          haltedBy = 'busy';
          refusals.push(
            makeRefusal(
              'busy',
              ownerInFlight > 0
                ? `${ownerInFlight} operation(s) were admitted for ${ownerKey} while its pages closed; the shell is retained`
                : `${applicationInFlight} operation(s) were admitted for the application while its pages closed; the shell is retained`,
              []
            )
          );
        }
      }

      if (haltedBy) {
        for (const tabId of members) {
          if (processed.has(tabId)) continue;
          skipped.push({ tabId, outcome: 'skipped', reason: haltedBy, attempted: false });
        }
        const surviving = this.readMembers(surface, lastObservedMembers);
        this.restoreLayout(surface, surviving, warnings);
        return finalize(surviving);
      }

      // Every snapshot member is gone and nothing arrived: the shell itself may close.
      const shellClose = await this.closeSurfaceSelf(surface);
      const shellOutcome = shellClose.outcome;
      surfaceOutcome = { key: surface.key, kind: surface.kind, outcome: shellOutcome };
      if (shellClose.timedOut) {
        warnings.push(
          `Shell ${surface.key} never answered its native close within ${this.outcomeDeadlineMs}ms; nothing was destroyed.`
        );
      }
      if (shellOutcome === 'closed') {
        disposition = 'closed';
        this.phaseByOwner.set(ownerKey, 'closed');
        return finalize([]);
      }

      const reason: CloseStopReason =
        shellOutcome === 'vetoed'
          ? 'unload-veto'
          : shellOutcome === 'unknown'
            ? 'unknown-outcome'
            : 'native-close-failed';
      haltedBy = reason;
      refusals.push(
        makeRefusal(
          reason,
          reason === 'unload-veto'
            ? `Shell ${surface.key} refused to close after its pages were closed`
            : reason === 'unknown-outcome'
              ? `Shell ${surface.key} produced no terminal close outcome; it is retained`
              : `Native close of shell ${surface.key} failed`,
          []
        )
      );
      const surviving = this.readMembers(surface, lastObservedMembers);
      this.restoreLayout(surface, surviving, warnings);
      return finalize(surviving);
    } finally {
      releaseMemberReservations?.();
      releaseOwnerAdmission?.();
      if (disposition !== 'closed') this.phaseByOwner.set(ownerKey, 'open');
    }
  }

  private async runQuit(attemptId: number): Promise<QuitReport> {
    const shells: CloseReport[] = [];
    const auxiliaries: SurfaceOutcome[] = [];
    const refusals: CloseRefusal[] = [];
    const warnings: string[] = [];
    let haltedBy: CloseStopReason | null = null;
    let commitError: string | undefined;
    let shutdown: 'committed' | 'not-committed' = 'not-committed';
    let releaseAdmission: (() => void) | null = null;

    const finalize = (phase: ClosePhase): QuitReport => {
      const closedShells = shells.filter((report) => report.disposition === 'closed').map((r) => r.ownerKey);
      const survivingShells = this.readSurfaces()
        .filter((surface) => surface.kind === 'browser')
        .map((surface) => surface.key);
      return {
        attemptId,
        coalescedRequests: 0,
        coalesced: false,
        shutdown,
        phase,
        admissionReserved: this.deps.reservations.isApplicationAdmissionReserved(),
        shells: [...shells],
        auxiliaries: [...auxiliaries],
        closedShells,
        survivingShells,
        refusals: [...refusals],
        haltedBy,
        commitError,
        warnings: [...warnings],
        summary: quitSummary(shutdown, closedShells.length, auxiliaries, haltedBy),
      };
    };

    /**
     * Report a refused quit. Application admission is reopened BEFORE the report is built
     * (the release is idempotent, so the `finally` below stays a no-op): `admissionReserved`
     * must describe the state the caller is handed — a refused quit keeps services usable —
     * never one that is about to be released behind its back.
     */
    const refuse = (): QuitReport => {
      this.applicationState = 'open';
      releaseAdmission?.();
      return finalize('open');
    };

    try {
      if (this.committedReport) return this.committedReport;
      if (this.committedShutdown) {
        this.applicationState = 'closed';
        shutdown = 'committed';
        const report = finalize('closed');
        this.committedReport = report;
        return report;
      }

      this.applicationState = 'checking';
      // Application admission closes BEFORE the final busy check and stays closed while
      // native closures settle; a refusal or late veto reopens it in the finally below.
      releaseAdmission = this.deps.reservations.reserveApplicationAdmission();
      // One attempt per shell: a close the user already started settles first, so the quit
      // never runs a second close against the same shell. That wait is bounded like every
      // other injected answer: an attempt that cannot settle must never be able to hold
      // application admission open, and the per-shell loop below bounds its own wait too.
      const alreadyClosing = [...this.pageAttempts.values()].map((handle) => handle.settled);
      const runningSettled = await this.awaitInjectedAnswer(Promise.allSettled(alreadyClosing));
      if (!runningSettled.answered) {
        warnings.push(
          `A close already running did not settle within ${this.outcomeDeadlineMs}ms; the quit continues and reports each shell honestly.`
        );
      }

      const surfaces = this.readSurfaces();
      const browsers = surfaces.filter((surface) => surface.kind === 'browser');
      const auxiliarySurfaces = surfaces.filter((surface) => surface.kind === 'auxiliary');
      const pageIds = uniqueTabIds(browsers.flatMap((surface) => this.readMembers(surface, [])));
      const evidence = await this.readLiveUse({
        scope: 'application',
        ownerKey: null,
        pageIds,
        auxiliaryKeys: auxiliarySurfaces.map((surface) => surface.key),
      });
      if (evidence.state !== 'idle') {
        haltedBy = evidence.state === 'busy' ? 'busy' : 'unknown-live-use';
        refusals.push(
          makeRefusal(
            haltedBy,
            evidenceDetail(
              evidence.reasons,
              evidence.state === 'busy'
                ? 'Shared work is active; the quit was refused'
                : 'Live-use evidence is unavailable; the quit was refused'
            ),
            collectControls(evidence.reasons)
          )
        );
        warnings.push('No surface was closed and no service was torn down.');
        return refuse();
      }

      this.applicationState = 'closing-pages';
      for (const surface of browsers) {
        const existing = this.pageAttempts.get(surface.key);
        const report = existing
          ? await this.settleRunningShellAttempt(existing, surface, attemptId)
          : await this.startShellAttempt(surface.key, 'quit');
        shells.push(report);
        if (report.disposition !== 'closed') {
          haltedBy = report.haltedBy ?? 'unload-veto';
          refusals.push(...report.refusals);
          warnings.push(`Shell ${surface.key} was retained; later surfaces were left untouched.`);
          break;
        }
      }

      if (!haltedBy) {
        for (const surface of auxiliarySurfaces) {
          const closeResult = await this.closeSurfaceSelf(surface);
          const outcome = closeResult.outcome;
          auxiliaries.push({ key: surface.key, kind: surface.kind, outcome });
          if (closeResult.timedOut) {
            warnings.push(
              `Auxiliary surface ${surface.key} never answered its native close within ${this.outcomeDeadlineMs}ms; nothing was destroyed.`
            );
          }
          if (outcome === 'closed') continue;
          haltedBy =
            outcome === 'vetoed'
              ? 'unload-veto'
              : outcome === 'unknown'
                ? 'unknown-outcome'
                : 'native-close-failed';
          refusals.push(
            makeRefusal(
              haltedBy,
              haltedBy === 'unload-veto'
                ? `Auxiliary surface ${surface.key} refused to close`
                : haltedBy === 'unknown-outcome'
                  ? `Auxiliary surface ${surface.key} produced no terminal close outcome`
                  : `Native close of auxiliary surface ${surface.key} failed`,
              []
            )
          );
          warnings.push('Shared services were retained; recovery controls stay available.');
          break;
        }
      }

      if (haltedBy) {
        return refuse();
      }

      // Committed shutdown is a separate state, entered once and never derived from
      // "no error so far": every native closure above succeeded first, and the teardown is
      // awaited before either the flag or the cached report is written. A rejection is the
      // one outcome that leaves the process running half torn down, so it must leave the
      // gate retryable: nothing terminal is recorded, and a later quit attempt runs this
      // path again instead of being answered from a report that describes a failure.
      try {
        await this.deps.commitShutdown();
        this.committedShutdown = true;
        this.applicationState = 'closed';
        shutdown = 'committed';
        const report = finalize('closed');
        this.committedReport = report;
        return report;
      } catch (error) {
        commitError = errorText(error);
        haltedBy = 'shutdown-failed';
        refusals.push(makeRefusal('shutdown-failed', `Committed shutdown failed: ${commitError}`, []));
        warnings.push('Cleanup failure is not reported as success; the quit can be attempted again.');
        // The same refusal path every other non-committed outcome takes: admission is
        // reopened before the report is built, so the caller is handed the state it
        // actually holds — a running application whose next quit attempt may try again.
        return refuse();
      }
    } finally {
      releaseAdmission?.();
    }
  }

  private async readLiveUse(request: LiveUseRequest): Promise<LiveUseAnswer> {
    let answer: BoundedAnswer<LiveUseReport>;
    try {
      answer = await this.awaitInjectedAnswer(Promise.resolve(this.deps.queryLiveUse(request)));
    } catch (error) {
      return {
        state: 'unknown',
        reasons: [
          { category: 'evidence-unavailable', detail: `Live-use query failed: ${errorText(error)}` },
        ],
      };
    }
    if (!answer.answered) {
      // Silence is UNKNOWN, never idle: an unreadable source must refuse the close instead
      // of authorizing it, and the bound is what keeps the attempt — and a quit's
      // application admission — from waiting forever on an answer that never comes.
      return {
        state: 'unknown',
        reasons: [
          {
            category: 'evidence-unavailable',
            detail: `Live-use query did not answer within ${this.outcomeDeadlineMs}ms`,
          },
        ],
      };
    }
    const report = answer.value;
    if (!report || typeof report !== 'object') {
      return {
        state: 'unknown',
        reasons: [{ category: 'evidence-unavailable', detail: 'Live-use query returned no report' }],
      };
    }
    const reasons = readReasons(report.reasons);
    if (report.state === 'idle') return { state: 'idle', reasons: [] };
    if (report.state === 'busy') return { state: 'busy', reasons };
    return {
      state: 'unknown',
      reasons:
        reasons.length > 0
          ? reasons
          : [
              {
                category: 'evidence-unavailable',
                detail: `Live-use query reported '${String(report.state)}'`,
              },
            ],
    };
  }

  private readMembers(surface: CloseSurface, fallback: readonly string[]): string[] {
    try {
      return uniqueTabIds(surface.visibleMemberIds());
    } catch {
      // Keep the last successful observation rather than inventing membership.
      return [...fallback];
    }
  }

  /**
   * Work admitted against one owner and not released: the evidence a request from that
   * window's own chrome leaves (a PTY being minted for it, which names no page). Read
   * synchronously on the last step before the shell closes itself, because the snapshot
   * read happened before its pages closed and cannot see what arrived since.
   *
   * Fail-closed: a count that cannot be read is treated as work in flight. Destroying a
   * shell around a mint nobody could measure is the failure this read exists to prevent,
   * and a retention the user can retry is the recoverable side to be wrong on.
   */
  private readOwnerInFlight(ownerKey: string): number {
    try {
      const count = this.deps.reservations.inFlightOperationsOnOwner(ownerKey);
      return typeof count === 'number' && Number.isFinite(count) && count > 0 ? Math.floor(count) : 0;
    } catch {
      return 1;
    }
  }

  /**
   * The same re-read for an attempt whose snapshot was application-scoped (the last browser
   * shell): anything admitted process-wide since that read still refuses this attempt, and an
   * unreadable snapshot is again treated as work in flight rather than as an idle process.
   */
  private readApplicationInFlight(): number {
    try {
      const count = this.deps.reservations.snapshot().inFlightOperations;
      return typeof count === 'number' && Number.isFinite(count) && count > 0 ? Math.floor(count) : 0;
    } catch {
      return 1;
    }
  }

  private readSurfaces(): CloseSurface[] {
    const raw = this.deps.listSurfaces();
    if (!Array.isArray(raw)) throw new Error('listSurfaces() must return an array of close surfaces');
    const out: CloseSurface[] = [];
    for (const surface of raw) {
      if (!surface || typeof surface !== 'object') {
        throw new Error('listSurfaces() returned a surface that is not an object');
      }
      assertSurface(surface, 'listSurfaces()');
      out.push(surface);
    }
    return out;
  }

  /**
   * Close one surface through its own native path, under the module bound. Silence is
   * reported `unknown` with `timedOut`, so the caller refuses the attempt and retains the
   * surface: the bound never destroys anything, it only stops waiting.
   */
  private async closeSurfaceSelf(
    surface: CloseSurface
  ): Promise<{ outcome: SurfaceOutcomeKind; timedOut: boolean }> {
    let answer: BoundedAnswer<SurfaceCloseOutcome>;
    try {
      answer = await this.awaitInjectedAnswer(surface.closeSelf());
    } catch {
      return { outcome: 'failed', timedOut: false };
    }
    if (!answer.answered) return { outcome: 'unknown', timedOut: true };
    const outcome = answer.value;
    if (outcome === 'closed' || outcome === 'vetoed' || outcome === 'unknown') {
      return { outcome, timedOut: false };
    }
    return { outcome: 'failed', timedOut: false };
  }

  /**
   * The report of a shell close that is already running, awaited under the module bound.
   * Silence is reported as a retained shell with `unknown-outcome` — never as a closure —
   * so one attempt that cannot settle refuses the quit instead of holding application
   * admission open behind an answer that will never come.
   */
  private async settleRunningShellAttempt(
    handle: AttemptHandle<CloseReport>,
    surface: CloseSurface,
    attemptId: number
  ): Promise<CloseReport> {
    const answer = await this.awaitInjectedAnswer(handle.settled);
    if (answer.answered) return answer.value;
    return {
      attemptId,
      ownerKey: surface.key,
      intent: 'quit',
      coalescedRequests: 0,
      coalesced: false,
      disposition: 'retained',
      phase: 'open',
      closed: [],
      skipped: [],
      failed: [],
      refusals: [
        makeRefusal(
          'unknown-outcome',
          `Shell ${surface.key} was already closing and produced no terminal report within ${this.outcomeDeadlineMs}ms; the shell is retained`,
          []
        ),
      ],
      haltedBy: 'unknown-outcome',
      surface: null,
      survivingTabIds: this.readMembers(surface, []),
      partial: false,
      lastBrowserShellGone: false,
      warnings: [
        `The close attempt already running for ${surface.key} did not settle within ${this.outcomeDeadlineMs}ms; it is reported as retained, never as closed.`,
      ],
      summary: closeSummary(surface.key, 'retained', 0, 0, 0, 'unknown-outcome'),
    };
  }

  /**
   * Re-present the surviving active page inside a shell that stays alive. Never raises
   * or focuses a window, and a failure here cannot change the reported outcome.
   */
  private restoreLayout(surface: CloseSurface, surviving: readonly string[], warnings: string[]): void {
    if (surviving.length === 0) return;
    if (typeof surface.restoreSurvivingLayout !== 'function') return;
    try {
      surface.restoreSurvivingLayout(surviving);
    } catch (error) {
      warnings.push(`Layout restore failed for ${surface.key}: ${errorText(error)}`);
    }
  }
}

function assertSurface(surface: CloseSurface, source: string): void {
  if (typeof surface.key !== 'string' || surface.key.trim().length === 0) {
    throw new Error(`${source} returned a surface without a stable key`);
  }
  if (surface.kind !== 'browser' && surface.kind !== 'auxiliary') {
    throw new Error(`${source} returned a surface with an unknown kind: ${String(surface.kind)}`);
  }
  if (typeof surface.visibleMemberIds !== 'function' || typeof surface.closeSelf !== 'function') {
    throw new Error(`${source} returned surface ${surface.key} without visibleMemberIds()/closeSelf()`);
  }
}

function closeSummary(
  ownerKey: string,
  disposition: CloseDisposition,
  closedCount: number,
  skippedCount: number,
  failedCount: number,
  haltedBy: CloseStopReason | null
): string {
  const counts = `closed ${closedCount}, skipped ${skippedCount}, failed ${failedCount}`;
  if (disposition === 'closed') {
    return `Close of ${ownerKey}: shell closed (${counts}).`;
  }
  const stop = haltedBy === null ? 'no page was destroyed' : `stopped by ${haltedBy}`;
  return `Close of ${ownerKey}: shell retained, ${stop} (${counts}); earlier closes stand and are not transactional.`;
}

function quitSummary(
  shutdown: 'committed' | 'not-committed',
  closedShellCount: number,
  auxiliaries: readonly SurfaceOutcome[],
  haltedBy: CloseStopReason | null
): string {
  const auxClosed = auxiliaries.filter((entry) => entry.outcome === 'closed').length;
  if (shutdown === 'committed') {
    return `Application quit: committed after closing ${closedShellCount} browser shell(s) and ${auxClosed} auxiliary surface(s).`;
  }
  return `Application quit: not committed, ${closedShellCount} browser shell(s) closed, ${auxClosed} auxiliary surface(s) closed${
    haltedBy === null ? '' : `, stopped by ${haltedBy}`
  }; services remain available for recovery.`;
}

/**
 * Serve a duplicate window-close request from the running application attempt: the
 * shell's own report when the attempt reached it, otherwise an honest retained report
 * carrying the application-level refusals.
 */
function projectReportFromQuit(report: QuitReport, ownerKey: string): CloseReport {
  const reached = report.shells.find((shell) => shell.ownerKey === ownerKey);
  if (reached) return reached;
  const refusal =
    report.refusals.length > 0
      ? [...report.refusals]
      : [
          makeRefusal(
            'new-arrival',
            `Shell ${ownerKey} was not part of the application quit snapshot; it is retained`,
            []
          ),
        ];
  return {
    attemptId: report.attemptId,
    ownerKey,
    intent: 'quit',
    coalescedRequests: report.coalescedRequests,
    coalesced: true,
    disposition: 'retained',
    phase: 'open',
    closed: [],
    skipped: [],
    failed: [],
    refusals: refusal,
    haltedBy: report.haltedBy ?? 'new-arrival',
    surface: null,
    survivingTabIds: [],
    partial: false,
    lastBrowserShellGone: false,
    warnings: [...report.warnings],
    summary: `Close of ${ownerKey}: served by the running application quit attempt; the shell is retained.`,
  };
}
