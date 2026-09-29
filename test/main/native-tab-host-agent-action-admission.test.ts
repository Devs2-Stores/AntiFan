/**
 * An agent action must not be admitted onto a page inside an authorized close, nor into the
 * window where a quit holds application admission closed.
 *
 * The port gate and the capability transport both refuse there, but the host's own
 * agent-action entry points delegated straight to the automation host, so every bridge RPC
 * surface (`antifan.agentClick`, `antifan.agentMove`, `antifan.agentType`, the keyboard
 * capability) could admit work the gate would have refused — onto a page mid-unload, or into
 * a teardown that is disposing the services the action would use. The refusal is the same
 * two-step the other seams perform: application admission first, then the page reservation,
 * the application read fail-closed because an unreadable reservation is not permission.
 *
 * Refusing is half of it. The other half is measurement: the action is registered against the
 * pages it will reach, so the close gate's busy snapshot counts real work instead of guessing,
 * and its release runs on every exit path — a throw included. The registration is deliberately
 * re-entrant: the keyboard action the automation host routes back through this host arrives
 * with an action already admitted, and one action must count once.
 *
 * The host is built as a prototype instance with the fields each row needs, the way the
 * neighbouring host suites do it, because these rows are about the admission seam and not
 * about Chromium: the automation host is a double that records whether it was reached.
 */
import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import type { WebContentsView } from 'electron';
import { NativeTabHost, type TabHostCloseAdmission } from '../../src/main/browser/native-tab-host';
import { CapabilityError } from '../../src/shared/control-plane-contracts';
import { PageCloseReservations } from '../../src/main/browser/project-close-coordinator';
import { ownerKey, type WindowOwner } from '../../src/main/browser/project-window-shell';
import { countPageOperations } from '../../src/main/browser/close-live-use';
import { createShellDouble } from '../support/project-window-shell-double';

const TAB_ID = 'tab-1';

/** The admission seam as the close coordinator implements it: reserved pages, a quit window, and in-flight accounting. */
class StubAdmission implements TabHostCloseAdmission {
  public began = 0;
  public cleared = 0;
  public inFlight = 0;
  public readonly attributions: Array<readonly string[] | undefined> = [];
  public readonly ownerAttributions: Array<string | undefined> = [];
  public readonly ownerQueries: string[] = [];
  public readonly reserved = new Set<string>();
  public readonly reservedOwners = new Set<string>();
  public applicationReserved = false;
  public throwOnApplicationRead = false;
  public throwOnOwnerRead = false;

  public isPageReserved(tabId: string): boolean {
    return this.reserved.has(tabId);
  }

  public isOwnerReserved(ownerKey: string): boolean {
    if (this.throwOnOwnerRead) throw new Error('close coordinator unavailable');
    this.ownerQueries.push(ownerKey);
    return this.reservedOwners.has(ownerKey);
  }

  public isApplicationAdmissionReserved(): boolean {
    if (this.throwOnApplicationRead) throw new Error('close coordinator unavailable');
    return this.applicationReserved;
  }

  public beginAdmittedOperation(tabIds?: string | readonly string[], ownerKey?: string): () => void {
    this.began += 1;
    this.inFlight += 1;
    this.attributions.push(Array.isArray(tabIds) ? [...tabIds] : undefined);
    this.ownerAttributions.push(ownerKey);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.cleared += 1;
      this.inFlight -= 1;
    };
  }
}

/** Records every entry point that was reached, so a refusal can be told from a call-through. */
class StubAutomation {
  public readonly reached: string[] = [];
  public onDispatch: (() => Promise<void>) | null = null;
  public failNext: Error | null = null;

  public async agentClick(): Promise<boolean> {
    this.reached.push('agentClick');
    return true;
  }

  public async agentMove(): Promise<boolean> {
    this.reached.push('agentMove');
    return true;
  }

  public async dispatchAgentAction(): Promise<{ success: boolean }> {
    this.reached.push('dispatchAgentAction');
    if (this.onDispatch) await this.onDispatch();
    return { success: true };
  }

  public async agentClear(): Promise<boolean> {
    this.reached.push('agentClear');
    return true;
  }

  public async agentType(): Promise<boolean> {
    this.reached.push('agentType');
    if (this.failNext) throw this.failNext;
    return true;
  }

  /** The real host wraps page work in this; the row only needs the action to run. */
  public async withTabAgentWorking<T>(_tabId: string, action: () => Promise<T>): Promise<T> {
    return action();
  }
}

interface TestHost {
  getAutomationHost: () => unknown;
  closeAdmission: TabHostCloseAdmission | null;
  automationTabId: string | null;
  agentActionAdmissionDepth: number;
  shell: unknown;
}

function buildHost(admission: TabHostCloseAdmission | null): { host: NativeTabHost; automation: StubAutomation; inputEvents: Array<{ type: string }> } {
  const automation = new StubAutomation();
  const inputEvents: Array<{ type: string }> = [];
  const host = Object.create(NativeTabHost.prototype) as Record<string, unknown>;
  host.getAutomationHost = () => automation;
  host.closeAdmission = admission;
  host.automationTabId = TAB_ID;
  host.agentActionAdmissionDepth = 0;
  // Just enough page bookkeeping for the keyboard entry point to resolve its target: the row
  // is about admission, and the real body still runs from the guard inward. The input events
  // are captured because this host implements the press itself instead of delegating it, so
  // the event is the evidence that the nested action really executed.
  host.tabs = new Map([[TAB_ID, { view: { webContents: { isDestroyed: () => false, sendInputEvent: (event: { type: string }) => { inputEvents.push(event); } } }, state: { id: TAB_ID, url: 'https://fixture.test/', title: 'fixture' } }]]);
  host.resolveTargetTabId = (tabId?: string) => tabId;
  host.syncWithAgentInput = (run: () => void) => { run(); };
  return { host: host as unknown as NativeTabHost, automation, inputEvents };
}

/** The refusal code, or a readable failure when nothing was refused. */
async function refusalOf(run: () => Promise<unknown>): Promise<CapabilityError> {
  try {
    await run();
  } catch (error) {
    if (error instanceof CapabilityError) return error;
    throw error;
  }
  throw new Error('expected a refusal, but the call resolved');
}

describe('NativeTabHost agent action admission', () => {
  it('refuses an agent action on a page reserved for close, without reaching the automation host', async () => {
    const admission = new StubAdmission();
    admission.reserved.add(TAB_ID);
    const { host, automation } = buildHost(admission);

    const refusal = await refusalOf(() => host.agentClick({ selector: '#buy', tabId: TAB_ID }));

    assert.equal(refusal.code, 'TARGET_STALE');
    assert.match(refusal.message, /agentClick/);
    assert.equal(automation.reached.length, 0, 'a reserved page must not receive the action');
    assert.equal(admission.began, 0, 'a refused action must not be registered as admitted work');
  });

  it('refuses an agent action while a quit holds application admission', async () => {
    const admission = new StubAdmission();
    admission.applicationReserved = true;
    const { host, automation } = buildHost(admission);

    const refusal = await refusalOf(() => host.agentMove({ selector: '#row-2', tabId: TAB_ID }));

    assert.equal(refusal.code, 'RUNTIME_DRAINING');
    assert.equal(automation.reached.length, 0);
  });

  it('refuses fail-closed when the application admission read itself throws', async () => {
    const admission = new StubAdmission();
    admission.throwOnApplicationRead = true;
    const { host, automation } = buildHost(admission);

    const refusal = await refusalOf(() => host.agentType({ selector: '#q', text: 'x', tabId: TAB_ID }));

    assert.equal(refusal.code, 'RUNTIME_DRAINING', 'an unreadable reservation is not permission');
    assert.equal(automation.reached.length, 0);
  });

  it('leaves a host with no admission seam behaving as it did before the seam existed', async () => {
    const { host, automation } = buildHost(null);

    assert.equal(await host.agentClick({ selector: '#buy', tabId: TAB_ID }), true);
    assert.deepEqual(automation.reached, ['agentClick']);
  });
});

describe('NativeTabHost agent action measurement', () => {
  it('registers the action against its page for its duration and releases it once', async () => {
    const admission = new StubAdmission();
    const { host } = buildHost(admission);

    let inFlightDuringAction = -1;
    const automation = new StubAutomation();
    automation.agentMove = async () => {
      inFlightDuringAction = admission.inFlight;
      return true;
    };
    (host as unknown as TestHost).getAutomationHost = () => automation;

    await host.agentMove({ selector: '#row-1', tabId: TAB_ID });

    assert.equal(inFlightDuringAction, 1, 'the action must be measurable while it runs');
    assert.equal(admission.inFlight, 0, 'and released when it finishes');
    assert.equal(admission.began, 1);
    assert.equal(admission.cleared, 1);
    assert.deepEqual(admission.attributions, [[TAB_ID]], 'attributed to the page it reaches');
  });

  it('releases the admitted action when the action throws', async () => {
    const admission = new StubAdmission();
    const { host, automation } = buildHost(admission);
    automation.failNext = new Error('renderer gone');

    await assert.rejects(() => host.agentType({ selector: '#q', text: 'x', tabId: TAB_ID }), /renderer gone/);

    assert.equal(admission.inFlight, 0, 'a throwing action must not leak an in-flight operation');
    assert.equal(admission.cleared, 1);
  });

  it('counts a nested agent action once, because the keyboard action arrives already admitted', async () => {
    const admission = new StubAdmission();
    const { host, automation, inputEvents } = buildHost(admission);
    // The automation host routes a dispatched keyboard action back through this host, so the
    // inner call runs while the outer one holds an admitted operation.
    automation.onDispatch = async () => {
      await host.sendKeyboardPress({ key: 'Enter', tabId: TAB_ID });
    };

    await host.dispatchAgentAction('click', { selector: '#buy', tabId: TAB_ID });

    assert.deepEqual(automation.reached, ['dispatchAgentAction'], 'the outer surface reached the automation host');
    assert.deepEqual(
      inputEvents.map((event) => event.type),
      ['keyDown', 'keyUp'],
      'the nested keyboard action really executed, through the real entry point'
    );
    assert.equal(admission.began, 1, 'one action is one admitted operation, however many seams it crosses');
    assert.equal(admission.cleared, 1);
    assert.equal(admission.inFlight, 0);
    assert.equal((host as unknown as TestHost).agentActionAdmissionDepth, 0, 'the depth must not leak');
  });
});

describe('NativeTabHost agent action cancellation', () => {
  it('answers a cursor clear with false instead of throwing while the page is reserved', async () => {
    const admission = new StubAdmission();
    admission.reserved.add(TAB_ID);
    const { host, automation } = buildHost(admission);

    // A cancellation is also reached from teardown paths that must not be aborted by a throw.
    assert.equal(await host.agentClear(TAB_ID), false);
    assert.equal(automation.reached.length, 0);
  });

  it('refuses cancelActiveAgentAction without throwing during a quit', async () => {
    const admission = new StubAdmission();
    admission.applicationReserved = true;
    const { host, automation } = buildHost(admission);

    assert.equal(await host.cancelActiveAgentAction(TAB_ID), false);
    assert.equal(automation.reached.length, 0);
  });
});

/**
 * A terminal RPC asks for its PTY from chrome, not from a page: `findTabByWebContents` answers
 * undefined for a sidebar, toolbar or popout sender, and an operation registered with no page is
 * counted process-wide only. A page-scoped close - including the shell close that would take down
 * the very window presenting the terminal - measures its own pages, never the process total, so
 * without an attribution it reads an idle page and proceeds while the daemon is still minting.
 *
 * The attribution is the asking window's owner key, not its member pages. A mint for a window is
 * not work on each of its pages, so registering it against them would refuse a close of a page it
 * has nothing to do with. It is also the only identity a chrome sender has - and every owner class
 * keys on its window, including Unassigned: the manager holds at most one live shell per key, so
 * the sentinel cannot alias two live windows and the mint is attributed like any other window's.
 *
 * These rows pin the attribution the terminal RPCs hand `admitHostWork` and the measurement it
 * produces, using the real reservation table and the same counting function the close gate calls.
 */
describe('NativeTabHost host work admission', () => {
  const PROJECT_OWNER = { kind: 'project', projectId: 'proj-1' } as const;
  const PROJECT_KEY = ownerKey(PROJECT_OWNER);

  interface AdmissionHostOptions {
    readonly owner?: WindowOwner | null;
    readonly chrome?: readonly number[];
    readonly popout?: number;
    readonly terminalWindows?: readonly number[];
  }

  function buildAdmissionHost(admission: TabHostCloseAdmission | null, options: AdmissionHostOptions = {}): NativeTabHost {
    const host = Object.create(NativeTabHost.prototype) as Record<string, unknown>;
    host.closeAdmission = admission;
    host.shell = {
      owner: 'owner' in options ? options.owner : PROJECT_OWNER,
      chromeSurfaceFor: (id: number) => ((options.chrome ?? []).includes(id) ? 'sidebar' : undefined),
    };
    host.popoutWindow = options.popout === undefined ? null : { isDestroyed: () => false, webContents: { id: options.popout } };
    host.terminalWindows = new Map((options.terminalWindows ?? []).map((id) => [id, { isDestroyed: () => false, webContents: { id } }]));
    host.terminalDisplayedSessions = new Map();
    host.hibernatingTabIds = new Set();
    host.agentInputInFlight = 0;
    host.lastUserInputAtMs = 0;
    host.captureLift = null;
    host.captureLiftQueue = [];
    return host as unknown as NativeTabHost;
  }

  function asSeam(reservations: PageCloseReservations): TabHostCloseAdmission {
    return reservations as unknown as TabHostCloseAdmission;
  }

  it('attributes a mint asked from shell chrome to the owner of that shell', () => {
    const host = buildAdmissionHost(null, { chrome: [7], popout: 9, terminalWindows: [11] });

    assert.equal(host.shellOwnerKeyForSender(7), PROJECT_KEY, 'the sidebar asked for it');
    assert.equal(host.shellOwnerKeyForSender(11), PROJECT_KEY, 'a terminal window of the shell is the same shell');
    assert.equal(host.shellOwnerKeyForSender(9), PROJECT_KEY);
  });

  it('names no owner for a sender it cannot place, nor for a window with no project', () => {
    const foreign = buildAdmissionHost(null, { chrome: [7] });
    assert.equal(foreign.shellOwnerKeyForSender(42), undefined, 'a foreign sender must not claim this window');
    assert.equal(foreign.shellOwnerKeyForSender(undefined), undefined);

    assert.equal(buildAdmissionHost(null, { owner: null, chrome: [7] }).shellOwnerKeyForSender(7), undefined);
  });

  it('makes a mint from chrome measurable for its own window, and leaves its pages out of it', () => {
    const reservations = new PageCloseReservations();
    const host = buildAdmissionHost(asSeam(reservations), { chrome: [7] });

    const release = host.admitHostWork('antifan:terminal:new-session', { ownerKey: host.shellOwnerKeyForSender(7) });

    assert.equal(reservations.inFlightOperationsOnOwner(PROJECT_KEY), 1, 'the question the shell close asks');
    assert.equal(countPageOperations('tab-a', { admitted: reservations }), 0, 'and a page question must not see work that is not about it');
    assert.equal(reservations.snapshot().inFlightOperations, 1);
    assert.equal(reservations.snapshot().applicationReserved, false);

    release();

    assert.equal(reservations.inFlightOperationsOnOwner(PROJECT_KEY), 0, 'the release must clear both counts');
    assert.equal(reservations.snapshot().inFlightOperations, 0);
  });

  it('registers the asking page as well when the request names one, and never its siblings', () => {
    const reservations = new PageCloseReservations();
    const host = buildAdmissionHost(asSeam(reservations), { chrome: [7] });

    const release = host.admitHostWork('antifan:terminal:new-session', {
      tabIds: 'tab-a',
      ownerKey: host.shellOwnerKeyForSender(7),
    });

    assert.equal(countPageOperations('tab-a', { admitted: reservations }), 1, 'the page that asked sees it');
    assert.equal(countPageOperations('tab-b', { admitted: reservations }), 0, 'its sibling does not');
    assert.equal(reservations.inFlightOperationsOnOwner(PROJECT_KEY), 1);

    release();

    assert.equal(countPageOperations('tab-a', { admitted: reservations }), 0);
    assert.equal(reservations.inFlightOperationsOnOwner(PROJECT_KEY), 0);
  });

  it('counts an operation that names neither a page nor an owner process-wide only', () => {
    const reservations = new PageCloseReservations();
    const release = reservations.beginAdmittedOperation(undefined);

    assert.equal(reservations.snapshot().inFlightOperations, 1, 'a quit still sees it');
    assert.equal(countPageOperations('tab-a', { admitted: reservations }), 0, 'a page question cannot');
    assert.equal(reservations.inFlightOperationsOnOwner(PROJECT_KEY), 0, 'and neither can a window question');

    release();
    assert.equal(reservations.snapshot().inFlightOperations, 0);
  });

  it('refuses a mint whose own page is inside a close attempt, and admits it after the release', () => {
    const reservations = new PageCloseReservations();
    const host = buildAdmissionHost(asSeam(reservations), { chrome: [7] });
    const releasePage = reservations.reservePages(['tab-a']);

    assert.throws(
      () => host.admitHostWork('antifan:terminal:new-session', { tabIds: 'tab-a', ownerKey: host.shellOwnerKeyForSender(7) }),
      (error: unknown) => error instanceof CapabilityError && error.code === 'TARGET_STALE',
      'a page inside a close attempt must not gain a PTY it is about to lose'
    );
    assert.equal(reservations.snapshot().inFlightOperations, 0, 'a refused mint registers nothing');
    assert.equal(reservations.inFlightOperationsOnOwner(PROJECT_KEY), 0);

    releasePage();

    const admitted = host.admitHostWork('antifan:terminal:new-session', { tabIds: 'tab-a' });
    assert.equal(countPageOperations('tab-a', { admitted: reservations }), 1, 'the release reopens the page');
    admitted();
  });

  it('refuses a mint during a quit without registering it as admitted work', () => {
    const reservations = new PageCloseReservations();
    const host = buildAdmissionHost(asSeam(reservations), { chrome: [7] });
    const closeApplication = reservations.reserveApplicationAdmission();

    assert.throws(
      () => host.admitHostWork('antifan:terminal:new-session', { ownerKey: host.shellOwnerKeyForSender(7) }),
      (error: unknown) => error instanceof CapabilityError && error.code === 'RUNTIME_DRAINING',
      'the refusal must be final, not a registration the caller can leak'
    );
    assert.equal(reservations.snapshot().inFlightOperations, 0);
    assert.equal(reservations.inFlightOperationsOnOwner(PROJECT_KEY), 0);

    closeApplication();
  });

  it('refuses a mint asked by a window whose own close is reserved, and admits it after the release', () => {
    const reservations = new PageCloseReservations();
    const host = buildAdmissionHost(asSeam(reservations), { chrome: [7] });
    const releaseOwner = reservations.reserveOwnerAdmission(PROJECT_KEY);

    assert.throws(
      () => host.admitHostWork('antifan:terminal:new-session', { ownerKey: host.shellOwnerKeyForSender(7) }),
      (error: unknown) =>
        error instanceof CapabilityError &&
        error.code === 'TARGET_STALE' &&
        /window 'project:proj-1' is closing/.test(error.message),
      'a mint the closing window asked for must be refused while its own close holds the window'
    );
    assert.equal(reservations.snapshot().inFlightOperations, 0, 'a refused mint registers nothing');
    assert.equal(reservations.inFlightOperationsOnOwner(PROJECT_KEY), 0);

    releaseOwner();

    const admitted = host.admitHostWork('antifan:terminal:new-session', { ownerKey: host.shellOwnerKeyForSender(7) });
    assert.equal(reservations.inFlightOperationsOnOwner(PROJECT_KEY), 1, 'the release reopens the window');
    admitted();
  });

  it('refuses fail-closed when the owner reservation read itself throws', () => {
    const admission = new StubAdmission();
    admission.throwOnOwnerRead = true;
    const host = buildAdmissionHost(admission, { chrome: [7] });

    assert.throws(
      () => host.admitHostWork('antifan:terminal:new-session', { ownerKey: host.shellOwnerKeyForSender(7) }),
      (error: unknown) => error instanceof CapabilityError && error.code === 'TARGET_STALE',
      'an unreadable owner reservation is not permission'
    );
    assert.equal(admission.began, 0, 'a refused mint must not be registered as admitted work');
  });

  it('checks the window reservation whether the request names a page or not', () => {
    const reservations = new PageCloseReservations();
    const host = buildAdmissionHost(asSeam(reservations), { chrome: [7] });
    const releaseOwner = reservations.reserveOwnerAdmission(PROJECT_KEY);

    // The asking page is not reserved: only the window is closing, and the owner
    // check must refuse independently of anything the page reservation answers.
    assert.throws(
      () => host.admitHostWork('antifan:terminal:new-session', { tabIds: 'tab-a', ownerKey: host.shellOwnerKeyForSender(7) }),
      (error: unknown) =>
        error instanceof CapabilityError &&
        error.code === 'TARGET_STALE' &&
        /window 'project:proj-1' is closing/.test(error.message)
    );
    assert.throws(
      () => host.admitHostWork('antifan:terminal:new-session', { ownerKey: host.shellOwnerKeyForSender(7) }),
      (error: unknown) => error instanceof CapabilityError && error.code === 'TARGET_STALE'
    );
    assert.equal(reservations.inFlightOperationsOnPage('tab-a'), 0, 'a refused mint registers nothing on the page it named');
    assert.equal(reservations.snapshot().inFlightOperations, 0);

    releaseOwner();

    const admitted = host.admitHostWork('antifan:terminal:new-session', { tabIds: 'tab-a', ownerKey: host.shellOwnerKeyForSender(7) });
    assert.equal(reservations.inFlightOperationsOnPage('tab-a'), 1);
    assert.equal(reservations.inFlightOperationsOnOwner(PROJECT_KEY), 1);
    admitted();
  });

  it('attributes an unassigned window\'s chrome to the shared unassigned owner key', () => {
    const reservations = new PageCloseReservations();
    const host = buildAdmissionHost(asSeam(reservations), {});
    const shell = createShellDouble();
    // The double reads its CURRENT chrome views for `chromeSurfaceFor`, so seating the
    // sidebar after construction is exactly how production learns the sender is chrome.
    shell.sidebarView = { webContents: { id: 7, isDestroyed: () => false, send: () => {} }, setBounds: () => {} } as unknown as WebContentsView;
    Object.assign(shell, { owner: { kind: 'unassigned' } });
    // Reason: `shell` is a private field; TestHost is this file's established private-field seam.
    (host as unknown as TestHost).shell = shell;

    const senderOwnerKey = host.shellOwnerKeyForSender(7);
    assert.equal(senderOwnerKey, 'unassigned', 'one live shell per owner key means the sentinel cannot alias two windows');

    const release = host.admitHostWork('antifan:terminal:new-session', { ownerKey: senderOwnerKey });
    assert.equal(reservations.inFlightOperationsOnOwner('unassigned'), 1, 'its mint is measurable against the unassigned close');
    release();
  });
});
