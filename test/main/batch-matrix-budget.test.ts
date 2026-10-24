// batch_matrix pays one navigation plus one sweep cell per width for every route. A call that cannot
// finish inside its budget sweeps whole routes only and hands the rest back as remainingRoutes; a
// width whose emulation did not land is measured again before it reads unmeasured.
import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import { BATCH_MATRIX_BUDGET_MS, BrowserControlPort, BrowserHostPort, batchRoutesWithinBudget } from '../../src/main/tools/browser-control-port';
import { DEFAULT_SWEEP_BREAKPOINTS } from '../../src/main/browser/sweep-viewports';
import { BrowserTarget, issueRuntimeLease, makeControlPlaneId } from '../../src/shared/control-plane-contracts';

const START_URL = 'https://shop.example.com/';

function makeTarget(): BrowserTarget {
  const projectId = makeControlPlaneId('project');
  const workspaceId = makeControlPlaneId('workspace');
  const lease = issueRuntimeLease(projectId, workspaceId, 30_000, 1);
  return { tabId: 'tab-1', browserEpoch: 1, documentGeneration: 1, runtimeId: lease.runtimeId, projectId, workspaceId };
}

interface SweepCall {
  url: string;
  ids: string[];
}

interface Rig {
  port: BrowserControlPort;
  navigations: string[];
  sweeps: SweepCall[];
}

function code(err: unknown): string | undefined {
  return err && typeof err === 'object' && 'code' in err ? String(err.code) : undefined;
}

/**
 * `applied(url, id, callIndexForThatUrlAndId)` decides whether the emulation of a width landed;
 * `overflow` makes every measured width report horizontal overflow.
 */
function rig(applied: (url: string, id: string, call: number) => boolean = () => true, overflow = false): Rig {
  let current = START_URL;
  const navigations: string[] = [];
  const sweeps: SweepCall[] = [];
  const calls = new Map<string, number>();
  const host = {
    navigate: () => true,
    reload: () => true,
    getDom: async () => '',
    captureScreenshot: async () => '',
    evalJs: async () => undefined,
    getTabList: () => [{ id: 'tab-1', url: current }],
    getTabUrl: () => current,
    hasTab: (id: string) => id === 'tab-1',
    getDocumentGeneration: () => 1,
    navigateAndWait: async (_tabId: string, url: string) => {
      navigations.push(url);
      current = url;
      return true;
    },
    runResponsiveCheck: async (params: { customBreakpoints?: Array<{ id: string }> }) => {
      const ids = (params.customBreakpoints ?? []).map((bp) => bp.id);
      sweeps.push({ url: current, ids });
      const breakpoints: Record<string, Record<string, unknown>> = {};
      for (const id of ids) {
        const key = `${current}|${id}`;
        const call = calls.get(key) ?? 0;
        calls.set(key, call + 1);
        const ok = applied(current, id, call);
        breakpoints[id] = ok
          ? { emulationApplied: true, hasHorizontalOverflow: overflow, integrity: { measured: true, findings: [] } }
          : { emulationApplied: false };
      }
      return { breakpoints };
    },
  } as unknown as BrowserHostPort;
  return { port: new BrowserControlPort(host), navigations, sweeps };
}

function routes(count: number): string[] {
  return Array.from({ length: count }, (_, i) => `/pages/page-${i + 1}`);
}

describe('batchRoutesWithinBudget', () => {
  it('fits fewer than 17 routes of 5 widths in the default budget', () => {
    assert.equal(batchRoutesWithinBudget(17, 5, BATCH_MATRIX_BUDGET_MS), 10);
  });

  it('runs every route when the budget covers them', () => {
    assert.equal(batchRoutesWithinBudget(3, 5, BATCH_MATRIX_BUDGET_MS), 3);
  });

  it('never returns fewer than one route, so a single route always runs', () => {
    assert.equal(batchRoutesWithinBudget(20, 5, 0), 1);
  });

  it('costs more widths as fewer routes', () => {
    assert.ok(batchRoutesWithinBudget(20, 8, BATCH_MATRIX_BUDGET_MS) < batchRoutesWithinBudget(20, 3, BATCH_MATRIX_BUDGET_MS));
  });
});

describe('batch_matrix budget', () => {
  it('sweeps whole routes in order and returns the rest as remainingRoutes', async () => {
    const { port, navigations } = rig();
    const all = routes(17);
    const fits = batchRoutesWithinBudget(all.length, DEFAULT_SWEEP_BREAKPOINTS.length, BATCH_MATRIX_BUDGET_MS);
    assert.ok(fits >= 1 && fits < all.length, 'the fixture must overflow the budget so the partial path runs');
    const result = await port.runBatchMatrix(makeTarget(), { routes: all });
    const swept = result.routes as Array<{ route: string; breakpoints: Record<string, unknown> }>;
    assert.equal(result.partial, true);
    assert.equal(result.routesRequested, 17);
    assert.equal(result.routesScanned, fits);
    assert.deepEqual(result.remainingRoutes, all.slice(fits));
    assert.deepEqual(swept.map((entry) => entry.route), all.slice(0, fits));
    for (const entry of swept) {
      assert.equal(Object.keys(entry.breakpoints).length, DEFAULT_SWEEP_BREAKPOINTS.length, `route ${entry.route} must carry every standard width, never a half-measured set`);
    }
    assert.equal(result.passed, null, 'routes left unswept leave the batch unverified');
    assert.equal(navigations.at(-1), START_URL, 'the tab goes back to the page it started on');
  });

  it('is complete and passing when everything fits', async () => {
    const { port } = rig();
    const result = await port.runBatchMatrix(makeTarget(), { routes: routes(3) });
    assert.equal(result.partial, false);
    assert.equal(result.remainingRoutes, undefined);
    assert.equal(result.routesScanned, 3);
    assert.equal(result.passed, true);
  });

  it('honours a smaller per-call budget but always sweeps at least one route', async () => {
    const { port } = rig();
    const result = await port.runBatchMatrix(makeTarget(), { routes: routes(4) }, { budgetMs: 1 });
    assert.equal(result.routesScanned, 1);
    assert.deepEqual(result.remainingRoutes, routes(4).slice(1));
    assert.equal(result.passed, null);
  });

  it('a failing route stays false even when the batch is partial', async () => {
    const { port } = rig(() => true, true);
    const result = await port.runBatchMatrix(makeTarget(), { routes: routes(17) });
    assert.equal(result.partial, true);
    assert.equal(result.passed, false);
  });
});

describe('batch_matrix emulation retry', () => {
  it('measures a width again when its emulation did not land and keeps the route when the retry lands', async () => {
    const { port, sweeps } = rig((_url, id, call) => !(id === 'bp-375' && call === 0));
    const result = await port.runBatchMatrix(makeTarget(), { routes: ['/pages/one'], breakpoints: [320, 375, 768] });
    const [route] = result.routes as Array<{ passed: boolean | null; emulationRetries?: number; unmeasured?: string[] }>;
    assert.equal(route!.passed, true);
    assert.equal(route!.emulationRetries, 1);
    assert.equal(route!.unmeasured, undefined);
    const routeSweeps = sweeps.filter((s) => s.url.endsWith('/pages/one'));
    assert.equal(routeSweeps.length, 2);
    assert.deepEqual(routeSweeps[1]!.ids, ['bp-375'], 'only the width that did not land is measured again');
  });

  it('gives up after two retries and leaves the route unverified, never passed', async () => {
    const { port, sweeps } = rig((_url, id) => id !== 'bp-375');
    const result = await port.runBatchMatrix(makeTarget(), { routes: ['/pages/one'], breakpoints: [320, 375] });
    const [route] = result.routes as Array<{ passed: boolean | null; emulationRetries?: number; unmeasured?: string[] }>;
    assert.equal(route!.passed, null);
    assert.equal(route!.emulationRetries, 2);
    assert.deepEqual(route!.unmeasured, ['bp-375']);
    assert.equal(sweeps.filter((s) => s.url.endsWith('/pages/one')).length, 3);
    assert.equal(result.passed, null);
  });
});

describe('batch_matrix viewports', () => {
  it('measures the extra viewports after the widths', async () => {
    const { port, sweeps } = rig();
    const result = await port.runBatchMatrix(makeTarget(), {
      routes: ['/pages/one'],
      breakpoints: [375, 1024],
      viewports: [{ w: 667, h: 375 }, { w: 1366, h: 600 }],
    });
    assert.deepEqual(sweeps[0]!.ids, ['bp-375', 'bp-1024', 'vp-667x375', 'vp-1366x600']);
    assert.deepEqual(result.breakpoints, [375, 1024, 667, 1366]);
    assert.equal(result.passed, true);
  });

  it('refuses an out-of-range viewport before any navigation', async () => {
    const { port, navigations } = rig();
    await assert.rejects(
      port.runBatchMatrix(makeTarget(), { routes: ['/pages/one'], viewports: [{ w: 100, h: 375 }] }),
      (err: unknown) => code(err) === 'INVALID_ARGUMENT'
    );
    assert.deepEqual(navigations, []);
  });

  it('refuses more than five extra viewports', async () => {
    const { port, navigations } = rig();
    const viewports = Array.from({ length: 6 }, (_, i) => ({ w: 400 + i * 10, h: 600 }));
    await assert.rejects(
      port.runBatchMatrix(makeTarget(), { routes: ['/pages/one'], viewports }),
      (err: unknown) => code(err) === 'INVALID_ARGUMENT'
    );
    assert.deepEqual(navigations, []);
  });
});
