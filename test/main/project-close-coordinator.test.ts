/**
 * AntiFan Browser Desktop — Project Close Coordinator Tests
 *
 * Deterministic coverage of the pure-logic rows of the protected-close scenario matrix.
 * Every collaborator (native surface, page close, live-use evidence, shutdown routine,
 * admission consumers) is a fake, so a failure here is a failure of the state machine:
 *
 * - a reservation that is consulted only at the end of the window would let a binding
 *   be admitted mid-unload and this suite fails;
 * - an ignored veto would close a shell anyway and this suite fails;
 * - an UNKNOWN busy answer read as idle would close a page and this suite fails.
 */

import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import {
  PageCloseReservations,
  ProjectCloseCoordinator,
  type CloseReport,
  type CloseSurface,
  type LiveUseReport,
  type LiveUseRequest,
  type PageCloseOutcome,
  type SurfaceCloseOutcome,
} from '../../src/main/browser/project-close-coordinator';

/** Flush every pending microtask and one macrotask turn, so an attempt reaches its await point. */
function settle(): Promise<void> {
  return new Promise<void>((resolve) => setImmediate(resolve));
}

/**
 * A promise that never settles: the platform answer that never arrives. One shared
 * instance, so a silent port reads as silence instead of as an executor nobody calls.
 */
const NEVER: Promise<never> = new Promise<never>(() => {});

/** Small enough to prove the bound quickly, large enough to survive scheduler jitter. */
const BOUND_MS = 60;

class FakeSurface implements CloseSurface {
  public readonly memberIds: string[];
  public closeSelfCalls = 0;
  public readonly restoreCalls: string[][] = [];
  public forcedCloseSelfCalls = 0;
  public closeSelfOutcome: SurfaceCloseOutcome | 'throw' = 'closed';
  /** Set only when a closeSelf actually resolved 'closed'; the outcome may be re-scripted between attempts. */
  public destroyed = false;
  /** Runs inside closeSelf before the outcome is produced: models a late veto or arrival. */
  public onCloseSelf?: () => void;
  /** Answers nothing at all, forever: the platform silence the coordinator bound exists for. */
  public hangCloseSelf = false;

  constructor(
    public readonly key: string,
    public readonly kind: 'browser' | 'auxiliary',
    members: readonly string[] = []
  ) {
    this.memberIds = [...members];
  }

  public visibleMemberIds(): readonly string[] {
    return [...this.memberIds];
  }

  public async closeSelf(force = false): Promise<SurfaceCloseOutcome> {
    this.closeSelfCalls += 1;
    if (force) this.forcedCloseSelfCalls += 1;
    if (this.hangCloseSelf) return NEVER;
    if (this.closeSelfOutcome === 'throw') throw new Error(`${this.key} native close exploded`);
    if (this.closeSelfOutcome === 'closed') {
      this.destroyed = true;
      this.memberIds.length = 0;
    }
    return this.closeSelfOutcome;
  }

  public restoreSurvivingLayout(survivingTabIds: readonly string[]): void {
    this.restoreCalls.push([...survivingTabIds]);
  }

  public get gone(): boolean {
    return this.destroyed;
  }
}

/** Stands in for AttachmentRegistry mint/rebind/adoption and capability dispatch admission. */
class FakeAdmissionConsumer {
  public readonly refusedBinds: string[] = [];
  public readonly admittedBinds: string[] = [];

  constructor(private readonly reservations: PageCloseReservations) {}

  public bind(tabId: string): 'refused' | 'admitted' {
    if (this.reservations.isPageReserved(tabId)) {
      this.refusedBinds.push(tabId);
      return 'refused';
    }
    this.admittedBinds.push(tabId);
    return 'admitted';
  }

  public startOperation(tabId: string): () => void {
    assert.equal(
      this.reservations.isApplicationAdmissionReserved(),
      false,
      `operation on ${tabId} was admitted while application admission was reserved`
    );
    return this.reservations.beginAdmittedOperation();
  }
}

interface HarnessOptions {
  surfaces?: FakeSurface[];
  pageOutcomes?: Record<string, PageCloseOutcome | 'throw'>;
  /** Runs inside closePage before the outcome is produced. */
  onPageClose?: (tabId: string) => void | Promise<void>;
  liveUse?: (request: LiveUseRequest) => LiveUseReport | Promise<LiveUseReport>;
  commitShutdown?: () => void | Promise<void>;
  ownerOverrides?: Record<string, string>;
  /** Bound for every injected answer; a small value proves silence is bounded without waiting. */
  outcomeDeadlineMs?: number;
  /** Tab ids whose native close answers nothing at all, forever. */
  hangPageClose?: readonly string[];
  /** Makes the live-use query answer nothing at all, forever. */
  hangLiveUse?: boolean;
}

function buildHarness(options: HarnessOptions = {}) {
  const reservations = new PageCloseReservations();
  const surfaces = options.surfaces ?? [new FakeSurface('project:A', 'browser', ['t1', 't2'])];
  const ownerOverrides = options.ownerOverrides ?? {};
  const liveUseRequests: LiveUseRequest[] = [];
  const pageCloseCalls: string[] = [];
  const reservedAtPageClose: boolean[] = [];
  const forcedPageCloseCalls: string[] = [];
  const events: string[] = [];
  let commitCalls = 0;

  const coordinator = new ProjectCloseCoordinator({
    reservations,
    listSurfaces: () => surfaces.filter((surface) => !surface.gone),
    surfaceForOwner: (ownerKey) =>
      surfaces.find((surface) => surface.key === ownerKey && !surface.gone),
    ownerOfPage: (tabId) => {
      const override = ownerOverrides[tabId];
      if (override !== undefined) return override;
      const host = surfaces.find((surface) => !surface.gone && surface.memberIds.includes(tabId));
      return host?.key;
    },
    closePage: async (tabId, force) => {
      pageCloseCalls.push(tabId);
      if (force) forcedPageCloseCalls.push(tabId);
      reservedAtPageClose.push(reservations.isPageReserved(tabId));
      events.push(`page:${tabId}`);
      if (options.hangPageClose?.includes(tabId)) return NEVER;
      await options.onPageClose?.(tabId);
      const scripted = options.pageOutcomes?.[tabId];
      if (scripted === 'throw') throw new Error(`native close of ${tabId} exploded`);
      const outcome = scripted ?? 'closed';
      if (outcome === 'closed') {
        for (const surface of surfaces) {
          const index = surface.memberIds.indexOf(tabId);
          if (index >= 0) surface.memberIds.splice(index, 1);
        }
      }
      return outcome;
    },
    queryLiveUse: async (request) => {
      liveUseRequests.push(request);
      if (options.hangLiveUse) return NEVER;
      return options.liveUse ? options.liveUse(request) : { state: 'idle' };
    },
    commitShutdown: () => {
      commitCalls += 1;
      events.push('commit');
      return options.commitShutdown?.();
    },
    outcomeDeadlineMs: options.outcomeDeadlineMs,
  });

  return {
    coordinator,
    reservations,
    surfaces,
    admission: new FakeAdmissionConsumer(reservations),
    liveUseRequests,
    pageCloseCalls,
    forcedPageCloseCalls,
    reservedAtPageClose,
    ownerOverrides,
    events,
    commitCount: () => commitCalls,
  };
}

function outcomeFor(report: CloseReport, tabId: string): string {
  const bucket = [...report.closed, ...report.skipped, ...report.failed].find(
    (entry) => entry.tabId === tabId
  );
  return bucket ? `${bucket.outcome}:${bucket.reason ?? 'none'}:${bucket.attempted ? 'attempted' : 'untouched'}` : 'missing';
}

const idle = (): LiveUseReport => ({ state: 'idle' });

describe('PageCloseReservations', () => {
  it('keeps a page reserved for the whole window and releases exactly once', () => {
    const reservations = new PageCloseReservations();
    assert.equal(reservations.isPageReserved('t1'), false);

    const release = reservations.reservePages(['t1', 't1', ' t2 ']);
    assert.equal(reservations.isPageReserved('t1'), true);
    assert.equal(reservations.isPageReserved('t2'), true);
    assert.deepEqual(reservations.snapshot().reservedTabIds, ['t1', 't2']);

    release();
    release();
    assert.equal(reservations.isPageReserved('t1'), false);
    assert.deepEqual(reservations.snapshot().reservedTabIds, []);
  });

  it('clears the in-flight operation counter exactly once per admitted operation', () => {
    const reservations = new PageCloseReservations();
    const releaseA = reservations.beginAdmittedOperation();
    const releaseB = reservations.beginAdmittedOperation();
    assert.equal(reservations.snapshot().inFlightOperations, 2);

    releaseA();
    releaseA();
    assert.equal(reservations.snapshot().inFlightOperations, 1);

    releaseB();
    releaseB();
    releaseB();
    assert.equal(reservations.snapshot().inFlightOperations, 0);
  });

  it('reserves application admission and reopens it on release', () => {
    const reservations = new PageCloseReservations();
    const release = reservations.reserveApplicationAdmission();
    assert.equal(reservations.isApplicationAdmissionReserved(), true);
    assert.equal(reservations.snapshot().applicationReserved, true);

    release();
    release();
    assert.equal(reservations.isApplicationAdmissionReserved(), false);
    assert.equal(reservations.snapshot().applicationReserved, false);
  });

  it('nests owner reservations, releases each exactly once and ignores blank keys', () => {
    const reservations = new PageCloseReservations();
    assert.equal(reservations.isOwnerReserved('project:A'), false);

    const releaseA = reservations.reserveOwnerAdmission(' project:A ');
    const releaseB = reservations.reserveOwnerAdmission('project:A');
    assert.equal(reservations.isOwnerReserved('project:A'), true);

    releaseA();
    assert.equal(reservations.isOwnerReserved('project:A'), true, 'a nested hold outlives one release');

    releaseA();
    releaseB();
    releaseB();
    assert.equal(reservations.isOwnerReserved('project:A'), false, 'each release is idempotent');

    assert.equal(reservations.isOwnerReserved(''), false);
    assert.equal(reservations.isOwnerReserved('   '), false);
    const releaseEmpty = reservations.reserveOwnerAdmission('');
    const releaseBlank = reservations.reserveOwnerAdmission('   ');
    releaseEmpty();
    releaseBlank();
    assert.equal(reservations.isOwnerReserved('project:A'), false, 'blank keys reserve nothing to release');
  });
});

describe('ProjectCloseCoordinator — protected shell close', () => {
  it('refuses a binding that arrives during unload because the page stays reserved', async () => {
    const closeGate = Promise.withResolvers<void>();
    const harness = buildHarness({
      surfaces: [new FakeSurface('project:A', 'browser', ['t1'])],
      onPageClose: async (tabId) => {
        if (tabId === 't1') await closeGate.promise;
      },
    });

    const closing = harness.coordinator.attemptClose('project:A', 'user');
    await settle();

    // Mid-unload: the native close is in flight, the page is still reserved, and a new
    // binding must be refused instead of binding a page this attempt is about to destroy.
    assert.deepEqual(harness.pageCloseCalls, ['t1']);
    assert.deepEqual(harness.reservedAtPageClose, [true]);
    assert.deepEqual(harness.reservations.snapshot().reservedTabIds, ['t1']);
    assert.equal(harness.admission.bind('t1'), 'refused');
    assert.deepEqual(harness.admission.refusedBinds, ['t1']);

    closeGate.resolve();
    const report = await closing;

    assert.equal(report.disposition, 'closed');
    assert.equal(outcomeFor(report, 't1'), 'closed:none:attempted');
    assert.deepEqual(harness.reservations.snapshot().reservedTabIds, []);
    assert.equal(harness.admission.bind('t1'), 'admitted');
    assert.deepEqual(harness.admission.admittedBinds, ['t1']);
  });

  it('retains the shell and spares the new tab that arrives during close', async () => {
    const surface = new FakeSurface('project:A', 'browser', ['t1']);
    const harness = buildHarness({
      surfaces: [surface],
      onPageClose: (tabId) => {
        if (tabId === 't1') surface.memberIds.push('t9');
      },
    });

    const report = await harness.coordinator.attemptClose('project:A', 'user');

    assert.equal(report.disposition, 'retained');
    assert.equal(report.haltedBy, 'new-arrival');
    assert.equal(outcomeFor(report, 't1'), 'closed:none:attempted');
    assert.equal(outcomeFor(report, 't9'), 'skipped:new-arrival:untouched');
    assert.deepEqual(report.survivingTabIds, ['t9']);
    assert.equal(surface.closeSelfCalls, 0);
    assert.deepEqual(surface.restoreCalls, [['t9']]);
    assert.equal(harness.coordinator.phaseOf('project:A'), 'open');
  });

  it('retains the shell when work is admitted for its owner while its pages close', async () => {
    const surface = new FakeSurface('project:A', 'browser', ['t1']);
    let releaseMint: () => void = () => {};
    const harness = buildHarness({
      surfaces: [surface],
      onPageClose: () => {
        // A terminal asked for from this window's own chrome: owner-attributed and page-less,
        // so no member check above can see it.
        releaseMint = harness.reservations.beginAdmittedOperation(undefined, 'project:A');
      },
    });

    const report = await harness.coordinator.attemptClose('project:A', 'user');

    assert.equal(surface.closeSelfCalls, 0, 'the shell must not be destroyed around work it admitted while closing');
    assert.equal(report.disposition, 'retained');
    assert.equal(report.haltedBy, 'busy');
    assert.equal(report.partial, true, 'the page that already closed is reported, not undone');
    assert.equal(outcomeFor(report, 't1'), 'closed:none:attempted');
    assert.match(report.refusals[0]?.detail ?? '', /admitted for project:A while its pages closed/);
    // Nothing survived to restore: the shell's only page had already closed, and the coordinator
    // only calls into the surface when there is surviving layout to put back.
    assert.deepEqual(surface.restoreCalls, []);

    releaseMint();

    const after = await harness.coordinator.attemptClose('project:A', 'user');
    assert.equal(after.disposition, 'closed', 'the release is what the shell close waits for');
    assert.equal(surface.closeSelfCalls, 1);
  });

  it('retains the last browser shell when the application admits work after its snapshot read', async () => {
    const surface = new FakeSurface('project:A', 'browser', ['t1']);
    let releaseWork: () => void = () => {};
    const harness = buildHarness({
      surfaces: [surface],
      onPageClose: () => {
        // Process-wide only: another surface's dispatch, which the application-scoped snapshot
        // read above could not have seen, and which names neither this page nor this owner.
        releaseWork = harness.reservations.beginAdmittedOperation();
      },
    });

    const report = await harness.coordinator.attemptClose('project:A', 'user');

    assert.equal(surface.closeSelfCalls, 0, 'the last shell must not be destroyed around work admitted since the snapshot');
    assert.equal(report.disposition, 'retained');
    assert.equal(report.haltedBy, 'busy');
    assert.match(report.refusals[0]?.detail ?? '', /admitted for the application while its pages closed/);

    releaseWork();
    assert.equal((await harness.coordinator.attemptClose('project:A', 'user')).disposition, 'closed');
  });

  it('reserves the owner for the whole attempt, closed or halted', async () => {
    const closes = new FakeSurface('project:A', 'browser', ['t1']);
    const ownerReservedWhileClosing: boolean[] = [];
    const harness = buildHarness({
      surfaces: [closes],
      onPageClose: () => {
        ownerReservedWhileClosing.push(harness.reservations.isOwnerReserved('project:A'));
      },
    });
    closes.onCloseSelf = () => {
      ownerReservedWhileClosing.push(harness.reservations.isOwnerReserved('project:A'));
    };

    const closing = harness.coordinator.attemptClose('project:A', 'user');
    assert.equal(
      harness.reservations.isOwnerReserved('project:A'),
      true,
      'the synchronous prefix must hold the owner reservation before attemptClose returns'
    );
    const report = await closing;

    assert.equal(report.disposition, 'closed');
    assert.deepEqual(ownerReservedWhileClosing, [true, true]);
    assert.equal(harness.reservations.isOwnerReserved('project:A'), false);

    const vetoed = new FakeSurface('project:A', 'browser', ['t1']);
    const ownerReservedWhileHalting: boolean[] = [];
    const halted = buildHarness({
      surfaces: [vetoed],
      pageOutcomes: { t1: 'vetoed' },
      onPageClose: () => {
        ownerReservedWhileHalting.push(halted.reservations.isOwnerReserved('project:A'));
      },
    });

    const haltedReport = await halted.coordinator.attemptClose('project:A', 'user');

    assert.equal(haltedReport.disposition, 'retained');
    assert.equal(haltedReport.haltedBy, 'unload-veto');
    assert.deepEqual(ownerReservedWhileHalting, [true]);
    assert.equal(halted.reservations.isOwnerReserved('project:A'), false);
  });

  it('reserves the owner across a close for a shell with no member pages', async () => {
    const surface = new FakeSurface('project:A', 'browser', []);
    const ownerReservedAtShellClose: boolean[] = [];
    const harness = buildHarness({ surfaces: [surface] });
    surface.onCloseSelf = () => {
      ownerReservedAtShellClose.push(harness.reservations.isOwnerReserved('project:A'));
    };

    const closing = harness.coordinator.attemptClose('project:A', 'user');
    assert.equal(
      harness.reservations.isOwnerReserved('project:A'),
      true,
      'a shell with no pages still holds its owner reservation for the attempt'
    );
    const report = await closing;

    assert.equal(report.disposition, 'closed');
    assert.equal(surface.closeSelfCalls, 1);
    assert.deepEqual(harness.pageCloseCalls, []);
    assert.deepEqual(ownerReservedAtShellClose, [true]);
    assert.equal(harness.reservations.isOwnerReserved('project:A'), false);
  });

  it('stops at the first veto and reports an honest partial outcome', async () => {
    const surface = new FakeSurface('project:A', 'browser', ['t1', 't2', 't3']);
    const harness = buildHarness({
      surfaces: [surface],
      pageOutcomes: { t1: 'closed', t2: 'vetoed', t3: 'closed' },
    });

    const report = await harness.coordinator.attemptClose('project:A', 'user');

    assert.equal(report.disposition, 'retained');
    assert.equal(report.haltedBy, 'unload-veto');
    assert.equal(report.partial, true);
    assert.equal(outcomeFor(report, 't1'), 'closed:none:attempted');
    assert.equal(outcomeFor(report, 't2'), 'skipped:unload-veto:attempted');
    assert.equal(outcomeFor(report, 't3'), 'skipped:unload-veto:untouched');
    assert.deepEqual(harness.pageCloseCalls, ['t1', 't2']);
    assert.equal(surface.closeSelfCalls, 0);
    assert.deepEqual(report.survivingTabIds, ['t2', 't3']);
    assert.deepEqual(surface.restoreCalls, [['t2', 't3']]);
    assert.equal(report.refusals[0]?.code, 'unload-veto');
    assert.equal(report.refusals[0]?.tabId, 't2');
    // The summary is what a user reads, so it must never promise a reversal the coordinator cannot
    // perform. That is behavioural (no structured field carries it) - the positive wording around
    // it is not asserted: the structured fields above state the retained/partial outcome.
    assert.doesNotMatch(report.summary, /\bundo\b/i);
    assert.doesNotMatch(report.summary, /rollback/i);
  });

  it('retains the shell when a page produces no terminal outcome', async () => {
    const surface = new FakeSurface('project:A', 'browser', ['t1', 't2']);
    const harness = buildHarness({ surfaces: [surface], pageOutcomes: { t1: 'unknown' } });

    const report = await harness.coordinator.attemptClose('project:A', 'user');
    await settle();
    await settle();

    assert.equal(report.disposition, 'retained');
    assert.equal(report.haltedBy, 'unknown-outcome');
    assert.equal(outcomeFor(report, 't1'), 'skipped:unknown-outcome:attempted');
    assert.equal(outcomeFor(report, 't2'), 'skipped:unknown-outcome:untouched');
    assert.deepEqual(harness.pageCloseCalls, ['t1']);
    // No timeout-driven destroy: the shell is still there after the attempt settled.
    assert.equal(surface.closeSelfCalls, 0);
    assert.deepEqual(surface.memberIds, ['t1', 't2']);
  });

  it('reports a failed native close and keeps the remaining pages', async () => {
    const surface = new FakeSurface('project:A', 'browser', ['t1', 't2']);
    const harness = buildHarness({ surfaces: [surface], pageOutcomes: { t1: 'throw' } });

    const report = await harness.coordinator.attemptClose('project:A', 'user');

    assert.equal(report.disposition, 'retained');
    assert.equal(report.haltedBy, 'native-close-failed');
    assert.deepEqual(report.closed, []);
    assert.equal(report.failed.length, 1);
    assert.equal(report.failed[0]?.tabId, 't1');
    assert.match(report.failed[0]?.detail ?? '', /exploded/);
    assert.equal(outcomeFor(report, 't2'), 'skipped:native-close-failed:untouched');
    assert.equal(surface.closeSelfCalls, 0);
    assert.deepEqual(surface.restoreCalls, [['t1', 't2']]);
  });

  it('stops when a page is reassigned to another owner mid-close', async () => {
    const surface = new FakeSurface('project:A', 'browser', ['t1', 't2']);
    const harness = buildHarness({
      surfaces: [surface],
      onPageClose: (tabId) => {
        if (tabId === 't1') harness.ownerOverrides['t2'] = 'project:B';
      },
    });

    const report = await harness.coordinator.attemptClose('project:A', 'user');

    assert.equal(report.haltedBy, 'ownership-changed');
    assert.equal(report.disposition, 'retained');
    assert.equal(outcomeFor(report, 't1'), 'closed:none:attempted');
    assert.equal(outcomeFor(report, 't2'), 'skipped:ownership-changed:untouched');
    assert.equal(surface.closeSelfCalls, 0);
    assert.deepEqual(report.survivingTabIds, ['t2']);
    assert.equal(report.refusals[0]?.tabId, 't2');
  });

  it('revalidates busy state page by page before each close', async () => {
    const surface = new FakeSurface('project:A', 'browser', ['t1', 't2']);
    const harness = buildHarness({
      surfaces: [surface, new FakeSurface('project:B', 'browser', ['t3'])],
      liveUse: (request) => {
        if (request.scope === 'page' && request.pageIds[0] === 't2') {
          return {
            state: 'busy',
            reasons: [
              {
                category: 'in-flight-operation',
                detail: 'browser operation in flight on t2',
                tabId: 't2',
                control: { id: 'stop-browser-op', label: 'Stop browser operation' },
              },
            ],
          };
        }
        return idle();
      },
    });

    const report = await harness.coordinator.attemptClose('project:A', 'user');

    assert.equal(report.haltedBy, 'busy');
    assert.equal(report.partial, true);
    assert.equal(outcomeFor(report, 't1'), 'closed:none:attempted');
    assert.equal(outcomeFor(report, 't2'), 'skipped:busy:untouched');
    assert.deepEqual(harness.pageCloseCalls, ['t1']);
    assert.deepEqual(
      harness.liveUseRequests.map((request) => `${request.scope}:${request.pageIds.join(',')}`),
      ['shell:t1,t2', 'page:t1', 'page:t2']
    );
    assert.equal(surface.closeSelfCalls, 0);
  });

  it('serves duplicate window-close requests from one attempt', async () => {
    const closeGate = Promise.withResolvers<void>();
    const surface = new FakeSurface('project:A', 'browser', ['t1']);
    const harness = buildHarness({
      surfaces: [surface],
      onPageClose: async (tabId) => {
        if (tabId === 't1') await closeGate.promise;
      },
    });

    const first = harness.coordinator.attemptClose('project:A', 'user');
    const second = harness.coordinator.attemptClose('project:A', 'user');
    assert.equal(first, second, 'a duplicate close must join the active attempt');

    closeGate.resolve();
    const [reportA, reportB] = await Promise.all([first, second]);

    assert.equal(reportA, reportB, 'both callers observe the single attempt outcome');
    assert.equal(reportA.coalescedRequests, 1);
    assert.equal(reportA.coalesced, true);
    assert.deepEqual(harness.pageCloseCalls, ['t1'], 'pages are closed exactly once');
    assert.equal(surface.closeSelfCalls, 1);
    assert.equal(reportA.disposition, 'closed');
    assert.equal(reportA.lastBrowserShellGone, true);
  });

  it('reports the phase as checking synchronously and reopens it on refusal', async () => {
    const closeGate = Promise.withResolvers<void>();
    const harness = buildHarness({
      surfaces: [new FakeSurface('project:A', 'browser', ['t1'])],
      onPageClose: async () => {
        await closeGate.promise;
      },
    });

    const closing = harness.coordinator.attemptClose('project:A', 'user');
    assert.equal(
      harness.coordinator.phaseOf('project:A'),
      'checking',
      'the synchronous prefix must run before attemptClose returns'
    );
    await settle();
    assert.equal(harness.coordinator.phaseOf('project:A'), 'closing-pages');
    closeGate.resolve();
    assert.equal((await closing).phase, 'closed');
    assert.equal(harness.coordinator.phaseOf('project:A'), 'closed');

    const refused = buildHarness({
      surfaces: [new FakeSurface('project:B', 'browser', ['t3'])],
      liveUse: () => ({ state: 'busy', reasons: [] }),
    });
    const report = await refused.coordinator.attemptClose('project:B', 'user');
    assert.equal(report.phase, 'open');
    assert.equal(refused.coordinator.phaseOf('project:B'), 'open');
  });
});

describe('ProjectCloseCoordinator — scoping and evidence', () => {
  it('closes only the requested shell and leaves the other project untouched', async () => {
    const shellA = new FakeSurface('project:A', 'browser', ['t1']);
    const shellB = new FakeSurface('project:B', 'browser', ['t2']);
    const auxiliary = new FakeSurface('aux:capture', 'auxiliary');
    const harness = buildHarness({ surfaces: [shellA, shellB, auxiliary] });

    const report = await harness.coordinator.attemptClose('project:A', 'user');

    assert.equal(report.disposition, 'closed');
    assert.deepEqual(harness.pageCloseCalls, ['t1']);
    assert.equal(shellA.closeSelfCalls, 1);
    assert.equal(shellB.closeSelfCalls, 0);
    assert.equal(auxiliary.closeSelfCalls, 0);
    assert.deepEqual(shellB.memberIds, ['t2']);
    assert.equal(harness.commitCount(), 0);
    assert.equal(report.lastBrowserShellGone, false, 'project:B is still a browser shell');

    // A project snapshot is the shell's own pages: no auxiliary key, no foreign page.
    const shellRequest = harness.liveUseRequests[0];
    assert.equal(shellRequest?.scope, 'shell');
    assert.deepEqual(shellRequest?.pageIds, ['t1']);
    assert.deepEqual(shellRequest?.auxiliaryKeys, []);
    assert.equal(harness.coordinator.browserShellCount(), 1);
  });

  it('treats the last browser shell as application-scoped, including auxiliaries', async () => {
    const lastShell = new FakeSurface('project:A', 'browser', ['t1']);
    const auxiliary = new FakeSurface('aux:capture', 'auxiliary');
    const harness = buildHarness({
      surfaces: [lastShell, auxiliary],
      liveUse: (request) =>
        request.scope === 'application' && request.auxiliaryKeys.length > 0
          ? {
              state: 'busy',
              reasons: [
                {
                  category: 'in-flight-operation',
                  detail: 'capture host holds an in-flight QA operation',
                  control: { id: 'stop-qa', label: 'Stop QA operation' },
                },
              ],
            }
          : { state: 'idle' },
    });

    const report = await harness.coordinator.attemptClose('project:A', 'user');

    assert.equal(harness.liveUseRequests[0]?.scope, 'application');
    assert.deepEqual(harness.liveUseRequests[0]?.auxiliaryKeys, ['aux:capture']);
    assert.equal(report.disposition, 'retained');
    assert.equal(report.haltedBy, 'busy');
    assert.deepEqual(harness.pageCloseCalls, []);
    assert.equal(lastShell.closeSelfCalls, 0);
    assert.deepEqual(report.refusals[0]?.controls, [{ id: 'stop-qa', label: 'Stop QA operation' }]);
  });

  it('refuses on a failed, explicit-unknown or malformed busy answer and stays recoverable', async () => {
    for (const brokenQuery of [
      () => {
        throw new Error('busy query socket closed');
      },
      () => ({ state: 'unknown' as const, reasons: [] }),
      () => null as unknown as LiveUseReport,
    ]) {
      const surface = new FakeSurface('project:A', 'browser', ['t1']);
      let broken = true;
      const harness = buildHarness({
        surfaces: [surface],
        liveUse: () => {
          if (broken) return brokenQuery() as LiveUseReport;
          return idle();
        },
      });

      const report = await harness.coordinator.attemptClose('project:A', 'user');

      assert.equal(report.disposition, 'retained');
      assert.equal(report.haltedBy, 'unknown-live-use');
      assert.equal(report.refusals[0]?.code, 'unknown-live-use');
      assert.equal(outcomeFor(report, 't1'), 'skipped:unknown-live-use:untouched');
      assert.deepEqual(harness.pageCloseCalls, []);
      assert.equal(surface.closeSelfCalls, 0);
      assert.deepEqual(harness.reservations.snapshot().reservedTabIds, [], 'reservations must be released');
      assert.equal(harness.commitCount(), 0);

      // Recovery: the retained shell and its controls stay usable, so a later attempt works.
      broken = false;
      const recovered = await harness.coordinator.attemptClose('project:A', 'user');
      assert.equal(recovered.disposition, 'closed');
      assert.equal(surface.closeSelfCalls, 1);
    }
  });

  it('reports reservations and in-flight operations together for the whole close window', async () => {
    const closeGate = Promise.withResolvers<void>();
    const surface = new FakeSurface('project:A', 'browser', ['t1']);
    const harness = buildHarness({
      surfaces: [surface],
      onPageClose: async () => {
        await closeGate.promise;
      },
    });

    const releaseOperation = harness.admission.startOperation('t1');
    assert.equal(harness.reservations.snapshot().inFlightOperations, 1);

    const closing = harness.coordinator.attemptClose('project:A', 'user');
    await settle();

    const midWindow = harness.reservations.snapshot();
    assert.deepEqual(midWindow.reservedTabIds, ['t1']);
    assert.equal(midWindow.inFlightOperations, 1);
    assert.equal(midWindow.applicationReserved, false);

    closeGate.resolve();
    await closing;
    releaseOperation();
    releaseOperation();

    const after = harness.reservations.snapshot();
    assert.deepEqual(after.reservedTabIds, []);
    assert.equal(after.inFlightOperations, 0);
  });

  it('fails closed on a malformed surface directory', async () => {
    const reservations = new PageCloseReservations();
    const coordinator = new ProjectCloseCoordinator({
      reservations,
      listSurfaces: () => [{ key: 'project:A', kind: 'weird', visibleMemberIds: () => [], closeSelf: async () => 'closed' } as unknown as CloseSurface],
      surfaceForOwner: () => undefined,
      ownerOfPage: () => undefined,
      closePage: async () => 'closed',
      queryLiveUse: () => idle(),
      commitShutdown: () => undefined,
    });

    await assert.rejects(coordinator.attemptQuit(), /unknown kind/);
    assert.equal(coordinator.isApplicationAdmissionReserved(), false, 'a rejected quit must reopen admission');

    const shellCoordinator = new ProjectCloseCoordinator({
      reservations,
      listSurfaces: () => [],
      surfaceForOwner: () => ({ key: '', kind: 'browser' }) as unknown as CloseSurface,
      ownerOfPage: () => undefined,
      closePage: async () => 'closed',
      queryLiveUse: () => idle(),
      commitShutdown: () => undefined,
    });
    await assert.rejects(shellCoordinator.attemptClose('project:A', 'user'), /stable key/);
    assert.equal(shellCoordinator.phaseOf('project:A'), 'open');
  });
});

describe('ProjectCloseCoordinator — application quit', () => {
  it('refuses a quit while runs are queued or awaiting, with no teardown', async () => {
    const shellA = new FakeSurface('project:A', 'browser', ['t1']);
    const shellB = new FakeSurface('project:B', 'browser', ['t2']);
    const auxiliary = new FakeSurface('aux:terminal', 'auxiliary');
    const harness = buildHarness({
      surfaces: [shellA, shellB, auxiliary],
      liveUse: (request) =>
        request.scope === 'application'
          ? {
              state: 'busy',
              reasons: [
                {
                  category: 'run-queued',
                  detail: 'run r-1 is queued for project:B',
                  control: { id: 'run-queue-project:B', label: 'Open run queue for project:B' },
                },
                {
                  category: 'run-awaiting',
                  detail: 'run r-2 is awaiting user input',
                  control: { id: 'run-r-2', label: 'Open run r-2' },
                },
              ],
            }
          : { state: 'idle' },
    });

    const report = await harness.coordinator.attemptQuit();

    assert.equal(report.shutdown, 'not-committed');
    assert.equal(report.phase, 'open');
    assert.equal(report.haltedBy, 'busy');
    assert.deepEqual(report.shells, []);
    assert.deepEqual(report.closedShells, []);
    assert.equal(harness.commitCount(), 0);
    assert.deepEqual(harness.pageCloseCalls, []);
    assert.equal(shellA.closeSelfCalls, 0);
    assert.equal(shellB.closeSelfCalls, 0);
    assert.equal(auxiliary.closeSelfCalls, 0);
    assert.equal(harness.coordinator.hasCommittedShutdown(), false);
    assert.equal(harness.coordinator.isApplicationAdmissionReserved(), false, 'a refusal reopens admission');
    assert.equal(harness.coordinator.applicationPhase(), 'open');
    assert.deepEqual(
      report.refusals[0]?.controls.map((control) => control.id),
      ['run-queue-project:B', 'run-r-2']
    );
  });

  it('commits an orderly quit for an idle final browser shell plus a terminal popout', async () => {
    const shell = new FakeSurface('project:A', 'browser', ['t1']);
    const popout = new FakeSurface('aux:terminal', 'auxiliary');
    const harness = buildHarness({ surfaces: [shell, popout] });
    shell.onCloseSelf = () => harness.events.push(`shell:${shell.key}`);
    popout.onCloseSelf = () => harness.events.push(`shell:${popout.key}`);

    const report = await harness.coordinator.attemptQuit();

    assert.equal(report.shutdown, 'committed');
    assert.equal(report.phase, 'closed');
    assert.deepEqual(harness.events, ['page:t1', 'shell:project:A', 'shell:aux:terminal', 'commit']);
    assert.deepEqual(report.closedShells, ['project:A']);
    assert.deepEqual(report.survivingShells, []);
    assert.deepEqual(report.auxiliaries, [{ key: 'aux:terminal', kind: 'auxiliary', outcome: 'closed' }]);
    assert.equal(harness.commitCount(), 1);
    assert.equal(harness.coordinator.hasCommittedShutdown(), true);
    assert.equal(harness.coordinator.applicationPhase(), 'closed');
    assert.equal(harness.coordinator.isApplicationAdmissionReserved(), false, 'teardown cannot leave admission closed');
    // Application scope covers the browser pages and the auxiliary keys.
    assert.deepEqual(harness.liveUseRequests[0]?.pageIds, ['t1']);
    assert.deepEqual(harness.liveUseRequests[0]?.auxiliaryKeys, ['aux:terminal']);
  });

  it('coalesces repeated Quit and preserves service access after a late shell veto', async () => {
    const shell = new FakeSurface('project:A', 'browser', ['t1']);
    const auxiliary = new FakeSurface('aux:capture', 'auxiliary');
    let servicesDisposed = false;
    const harness = buildHarness({
      surfaces: [shell, auxiliary],
      commitShutdown: () => {
        servicesDisposed = true;
      },
    });
    shell.closeSelfOutcome = 'vetoed';

    const first = harness.coordinator.attemptQuit();
    const second = harness.coordinator.attemptQuit();
    assert.equal(first, second, 'a repeated Quit joins the active attempt');
    const [reportA, reportB] = await Promise.all([first, second]);

    assert.equal(reportA, reportB);
    assert.equal(reportA.coalescedRequests, 1);
    assert.equal(reportA.shutdown, 'not-committed');
    assert.equal(reportA.haltedBy, 'unload-veto');
    assert.deepEqual(harness.pageCloseCalls, ['t1']);
    assert.deepEqual(reportA.closedShells, []);
    assert.deepEqual(reportA.survivingShells, ['project:A']);
    assert.equal(auxiliary.closeSelfCalls, 0, 'a shell veto stops the surface queue');
    assert.equal(harness.commitCount(), 0);
    assert.equal(servicesDisposed, false, 'services stay usable after a late veto');
    assert.equal(harness.coordinator.isApplicationAdmissionReserved(), false);

    // Recovery: the surviving shell closes once the veto clears, and teardown happens once.
    shell.closeSelfOutcome = 'closed';
    const recovered = await harness.coordinator.attemptQuit();
    assert.equal(recovered.shutdown, 'committed');
    assert.equal(recovered.phase, 'closed');
    assert.equal(shell.closeSelfCalls, 2);
    assert.equal(harness.commitCount(), 1);
    assert.equal(servicesDisposed, true);
    assert.deepEqual(recovered.closedShells, ['project:A']);
    assert.deepEqual(recovered.survivingShells, []);
  });

  it('keeps services usable when an auxiliary vetoes after the browser shells closed', async () => {
    const shell = new FakeSurface('project:A', 'browser', ['t1']);
    const auxiliary = new FakeSurface('aux:terminal', 'auxiliary');
    let servicesDisposed = false;
    const harness = buildHarness({
      surfaces: [shell, auxiliary],
      commitShutdown: () => {
        servicesDisposed = true;
      },
    });
    shell.onCloseSelf = () => harness.events.push(`shell:${shell.key}`);
    auxiliary.onCloseSelf = () => harness.events.push(`shell:${auxiliary.key}`);
    auxiliary.closeSelfOutcome = 'vetoed';

    const report = await harness.coordinator.attemptQuit();

    assert.equal(shell.closeSelfCalls, 1);
    assert.equal(shell.gone, true);
    assert.deepEqual(harness.events, ['page:t1', 'shell:project:A', 'shell:aux:terminal'], 'every closure precedes any teardown');
    assert.deepEqual(report.closedShells, ['project:A']);
    assert.deepEqual(report.auxiliaries, [{ key: 'aux:terminal', kind: 'auxiliary', outcome: 'vetoed' }]);
    assert.equal(report.shutdown, 'not-committed');
    assert.equal(report.haltedBy, 'unload-veto');
    assert.equal(harness.commitCount(), 0);
    assert.equal(servicesDisposed, false);

    auxiliary.closeSelfOutcome = 'closed';
    const recovered = await harness.coordinator.attemptQuit();
    assert.equal(recovered.shutdown, 'committed');
    assert.equal(auxiliary.closeSelfCalls, 2);
    assert.equal(harness.commitCount(), 1, 'teardown runs exactly once');
    assert.deepEqual(recovered.auxiliaries, [{ key: 'aux:terminal', kind: 'auxiliary', outcome: 'closed' }]);
    assert.deepEqual(harness.events, [
      'page:t1',
      'shell:project:A',
      'shell:aux:terminal',
      'shell:aux:terminal',
      'commit',
    ]);
  });

  it('results one duplicate shell close through the running quit attempt', async () => {
    const closeGate = Promise.withResolvers<void>();
    const shell = new FakeSurface('project:A', 'browser', ['t1']);
    const harness = buildHarness({
      surfaces: [shell],
      onPageClose: async () => {
        await closeGate.promise;
      },
    });

    const quit = harness.coordinator.attemptQuit();
    await settle();
    const shellClose = harness.coordinator.attemptClose('project:A', 'quit');
    closeGate.resolve();
    const [quitReport, shellReport] = await Promise.all([quit, shellClose]);

    assert.equal(quitReport.shutdown, 'committed');
    assert.deepEqual(harness.pageCloseCalls, ['t1'], 'the page closes exactly once');
    assert.equal(shell.closeSelfCalls, 1);
    const reached = quitReport.shells.find((entry) => entry.ownerKey === 'project:A');
    assert.equal(shellReport, reached, 'the duplicate request is served by the quit attempt');
    assert.equal(shellReport.disposition, 'closed');
  });
});

/**
 * A platform call can be answered with NOTHING at all — no event, no error, no callback.
 * The gate must report that as `unknown` (which refuses and retains), never wait forever:
 * every later close and quit request coalesces into the attempt that never ends, so an
 * unbounded wait holds application admission closed and makes the app unquittable.
 */
describe('ProjectCloseCoordinator — an answer that never comes', () => {

  it('reports unknown, retains the shell and frees the reservations when a page close never answers', async () => {
    const surface = new FakeSurface('project:A', 'browser', ['t1', 't2']);
    const harness = buildHarness({
      surfaces: [surface],
      hangPageClose: ['t1'],
      outcomeDeadlineMs: BOUND_MS,
    });

    const startedAt = Date.now();
    const report = await harness.coordinator.attemptClose('project:A', 'user');
    const elapsed = Date.now() - startedAt;

    assert.equal(report.disposition, 'retained');
    assert.equal(report.phase, 'open');
    assert.equal(report.haltedBy, 'unknown-outcome');
    assert.equal(report.refusals[0]?.code, 'unknown-outcome');
    assert.match(report.refusals[0]?.detail ?? '', /within 60ms/);
    assert.equal(outcomeFor(report, 't1'), 'skipped:unknown-outcome:attempted');
    assert.equal(outcomeFor(report, 't2'), 'skipped:unknown-outcome:untouched');
    assert.equal(report.closed.length, 0, 'silence is never reported as closed');
    assert.deepEqual(surface.memberIds, ['t1', 't2'], 'the bound destroys nothing');
    assert.equal(surface.closeSelfCalls, 0, 'no shell close is attempted after a silent page');
    assert.ok(
      report.warnings.some((warning) => warning.includes('never answered its native close')),
      'the silence is visible to the operator'
    );
    assert.deepEqual(harness.reservations.snapshot().reservedTabIds, [], 'reservations must be released');
    assert.ok(elapsed >= BOUND_MS - 20, `refused before the bound expired: ${elapsed}ms`);
    assert.ok(elapsed < 2_000, `a silent page held the attempt for ${elapsed}ms`);
  });

  it('refuses a quit and reopens application admission while a running close never answers', async () => {
    const shell = new FakeSurface('project:A', 'browser', ['t1']);
    const harness = buildHarness({
      surfaces: [shell],
      hangPageClose: ['t1'],
      outcomeDeadlineMs: BOUND_MS,
    });

    // A close the user already started whose page never answers.
    const stalledClose = harness.coordinator.attemptClose('project:A', 'user');
    await settle();

    const report = await harness.coordinator.attemptQuit();

    assert.equal(report.shutdown, 'not-committed');
    assert.equal(report.phase, 'open');
    assert.equal(report.haltedBy, 'unknown-outcome');
    assert.equal(report.admissionReserved, false, 'a refused quit must report admission as open');
    assert.equal(harness.coordinator.isApplicationAdmissionReserved(), false);
    assert.deepEqual(report.closedShells, [], 'a shell that never answered is never reported closed');
    assert.deepEqual(harness.reservations.snapshot().reservedTabIds, [], 'reservations must be released');
    assert.equal(harness.commitCount(), 0, 'no teardown follows an unknown outcome');

    const stalledReport = await stalledClose;
    assert.equal(stalledReport.disposition, 'retained');
    assert.equal(stalledReport.haltedBy, 'unknown-outcome');
  });

  // The shell double's `closeSelf` never settles - that is the surface the coordinator consumes here.
  // The real ProjectWindowShell attempt machine behind it (native close issued, no event, unknown at
  // its own bound, window retained) is driven over a stubbed Electron seam in
  // test/main/close-outcome-deadline.test.ts, under "shell self close outcome deadline".
  it('reports an unknown shell outcome and the partial close when a shell close never answers', async () => {
    const shell = new FakeSurface('project:A', 'browser', ['t1']);
    const harness = buildHarness({ surfaces: [shell], outcomeDeadlineMs: BOUND_MS });
    shell.hangCloseSelf = true;

    const report = await harness.coordinator.attemptClose('project:A', 'user');

    assert.equal(report.disposition, 'retained');
    assert.equal(report.phase, 'open');
    assert.equal(report.haltedBy, 'unknown-outcome');
    assert.equal(report.surface?.outcome, 'unknown');
    assert.equal(report.closed.length, 1, 'the member page really did close before the shell went silent');
    assert.equal(report.partial, true);
    assert.equal(shell.gone, false, 'a silent shell is never reported gone');
    assert.ok(shell.closeSelfCalls >= 1, 'the shell close was actually attempted');
    assert.ok(
      report.warnings.some((warning) => warning.includes('never answered its native close')),
      'the silence is visible to the operator'
    );
  });

  it('never reads a silent live-use query as idle', async () => {
    const surface = new FakeSurface('project:A', 'browser', ['t1']);
    const harness = buildHarness({
      surfaces: [surface],
      hangLiveUse: true,
      outcomeDeadlineMs: BOUND_MS,
    });

    const report = await harness.coordinator.attemptClose('project:A', 'user');

    assert.equal(report.disposition, 'retained');
    assert.equal(report.haltedBy, 'unknown-live-use');
    assert.equal(report.refusals[0]?.code, 'unknown-live-use');
    assert.match(report.refusals[0]?.detail ?? '', /did not answer within 60ms/);
    assert.deepEqual(harness.pageCloseCalls, [], 'no page may be destroyed on an unknown answer');
    assert.equal(surface.closeSelfCalls, 0);
    assert.deepEqual(surface.memberIds, ['t1']);
    assert.deepEqual(harness.reservations.snapshot().reservedTabIds, [], 'reservations must be released');
  });
});

describe('ProjectCloseCoordinator — explicit force close', () => {
  it('keeps a refused normal close safe; force destroys only after explicit request', async () => {
    const shell = new FakeSurface('project:A', 'browser', ['t1']);
    const sibling = new FakeSurface('project:B', 'browser', ['s1']);
    const harness = buildHarness({
      surfaces: [shell, sibling],
      liveUse: () => ({ state: 'busy', reasons: [{ category: 'run-active', detail: 'agent run active' }] }),
      pageOutcomes: { t1: 'vetoed' },
    });

    const normal = await harness.coordinator.attemptClose('project:A', 'user');
    assert.equal(normal.disposition, 'retained');
    assert.equal(normal.haltedBy, 'busy');
    assert.equal(harness.pageCloseCalls.length, 0, 'busy normal close must not touch pages');

    const forced = await harness.coordinator.forceClose('project:A');
    assert.equal(forced.disposition, 'closed');
    assert.equal(forced.haltedBy, null);
    assert.deepEqual(harness.forcedPageCloseCalls, ['t1'], 'force bypasses live-use and unload for its own members');
    assert.equal(shell.closeSelfCalls, 1);
    assert.equal(shell.forcedCloseSelfCalls, 1, 'shell gets explicit native force only');
    assert.equal(shell.gone, true);
    assert.equal(sibling.gone, false, 'a force closes the requested shell, never siblings');
    assert.equal(harness.commitCount(), 0, 'a window force is not application quit');
  });

  it('serializes force behind an in-flight close instead of double-tearing a page', async () => {
    const shell = new FakeSurface('project:A', 'browser', ['t1']);
    const harness = buildHarness({
      surfaces: [shell],
      liveUse: () => ({ state: 'busy', reasons: [{ category: 'run-active', detail: 'run' }] }),
      outcomeDeadlineMs: BOUND_MS,
    });

    const first = harness.coordinator.attemptClose('project:A', 'user');
    await settle();
    const forced = harness.coordinator.forceClose('project:A');
    const firstReport = await first;
    const forcedReport = await forced;
    assert.equal(firstReport.disposition, 'retained');
    assert.equal(forcedReport.disposition, 'closed');
    assert.equal(harness.pageCloseCalls.length, 1);
    assert.equal(harness.forcedPageCloseCalls.length, 1);
  });

  it('coalesces concurrent explicit force requests into one teardown', async () => {
    const shell = new FakeSurface('project:A', 'browser', ['t1']);
    const harness = buildHarness({ surfaces: [shell] });
    const [a, b] = await Promise.all([
      harness.coordinator.forceClose('project:A'),
      harness.coordinator.forceClose('project:A'),
    ]);
    assert.equal(a.disposition, 'closed');
    assert.equal(b.disposition, 'closed');
    assert.equal(shell.closeSelfCalls, 1, 'the two explicit requests share one destructive attempt');
    assert.equal(harness.forcedPageCloseCalls.length, 1);
  });

  it('never lets a renderer-supplied owner retarget the authorization contract', async () => {
    const shell = new FakeSurface('project:A', 'browser', ['t1']);
    const harness = buildHarness({ surfaces: [shell] });
    await assert.rejects(harness.coordinator.forceClose('  '), /non-empty owner key/);
    const report = await harness.coordinator.forceClose('project:B');
    assert.equal(report.disposition, 'retained');
    assert.equal(report.haltedBy, 'surface-missing');
    assert.equal(shell.gone, false, 'a named foreign owner cannot reach this shell');
    assert.equal(harness.pageCloseCalls.length, 0);
  });

  it('reports an unknown shell destroy outcome without claiming the window closed', async () => {
    const shell = new FakeSurface('project:A', 'browser', ['t1']);
    shell.hangCloseSelf = true;
    const harness = buildHarness({ surfaces: [shell], outcomeDeadlineMs: BOUND_MS });
    const report = await harness.coordinator.forceClose('project:A');
    assert.equal(report.disposition, 'retained');
    assert.equal(report.haltedBy, 'unknown-outcome');
    assert.equal(report.surface?.outcome, 'unknown');
    assert.equal(shell.gone, false);
  });
});
