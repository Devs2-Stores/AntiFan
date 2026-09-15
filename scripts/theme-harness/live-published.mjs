/**
 * L1 — live-published measurement.
 *
 * Drives a bound AntiFan tab through the locked route set on the live store,
 * every URL pinned with `?themeid=<id>` so the served bytes are the theme under
 * test (the platform honours the param — phase-07 measured 4 distinct body
 * hashes across 5 theme ids). Per route:
 *   navigate -> theme.debug_bundle -> anti.theme.export_clean snapshot
 *   (revision-bound: sha256 + themeid + timestamp) -> theme.qa_validate with
 *   expectedUrl (page routes only; the route gate fails closed on host/theme/
 *   path mismatch).
 *
 * `?view=` AJAX routes get debug_bundle + snapshot only: they render partial
 * templates, so a full-page QA checklist would produce false refusals.
 *
 * Everything here is read-only against the store: navigation, DOM reads, DOM
 * export to a workspace file. No push, no mutation.
 *
 * The client is injected ({ callTool(name, args, timeoutMs) }) so the layer is
 * testable without a live app; a run with no client is BLOCKED upstream.
 */
import fs from 'node:fs';
import path from 'node:path';
import { sha256File, writeRecordAtomic } from '../lib/atomic-record.mjs';
import { pinnedRouteUrl } from './binding.mjs';
import { LAYERS, blockedVerdict, makeVerdict } from './verdict.mjs';

const TIER = 'LIVE_PUBLISHED';

const LIMITS = Object.freeze([
  'measures the published remote bytes only: uncommitted working-tree edits are invisible to this tier',
  'theme identity is attested by the ?themeid pin plus the qa_validate route gate, not by HTTP alone (probe-theme-identity refuses by design)',
]);

/**
 * The locked route set. `kind: 'page'` routes get the full qa_validate pass;
 * `kind: 'ajax'` routes are `?view=` partial templates measured with
 * debug_bundle + snapshot only. Product/article paths are campaign-verified
 * defaults; `discover` names a live fallback that replaces a dead default.
 */
export const HARNESS_ROUTE_SPECS = Object.freeze([
  { id: 'home', kind: 'page', path: '/' },
  { id: 'collection', kind: 'page', path: '/collections/all' },
  {
    id: 'product', kind: 'page', path: '/products/miracle-shampoo-plus-keratin',
    discover: { fromRoute: 'collection', pattern: '/products/' },
  },
  { id: 'cart', kind: 'page', path: '/cart' },
  { id: 'search', kind: 'page', path: '/search?q=a' },
  { id: 'blog', kind: 'page', path: '/blogs/news' },
  {
    id: 'article', kind: 'page',
    path: '/blogs/news/gia-ban-iphone-12-pro-max-bang-ca-gia-tai-nho-o-mot-so-quoc-gia',
    discover: { fromRoute: 'blog', pattern: '/blogs/news/' },
  },
  { id: 'ajax-cart-item', kind: 'ajax', path: '/cart?view=item' },
  { id: 'ajax-collection-data', kind: 'ajax', path: '/collections/all?view=data' },
  { id: 'ajax-search-smart', kind: 'ajax', path: '/search?q=a&view=smart' },
]);

const NAVIGATE_TIMEOUT_MS = 60_000;
const BUNDLE_TIMEOUT_MS = 90_000;
const SNAPSHOT_TIMEOUT_MS = 120_000;
const QA_TIMEOUT_MS = 240_000;
const DISCOVERY_TIMEOUT_MS = 30_000;

function routeError(entry, step, err) {
  entry.steps.push({ step, ok: false, error: err instanceof Error ? err.message : String(err) });
}

/**
 * Pull the first same-host href matching `pattern` out of the bound tab.
 * Discovery is a fallback for a dead default path, never a silent retarget:
 * the chosen path is recorded on the route entry either way.
 */
async function discoverRoutePath(client, tabId, pattern) {
  const expression = `(() => {
    const a = document.querySelector('a[href*=${JSON.stringify(pattern)}]');
    if (!a) return null;
    try { return new URL(a.href, location.origin).pathname; } catch { return null; }
  })()`;
  const result = await client.callTool('anti.browser.evaluate', { expression, tabId }, DISCOVERY_TIMEOUT_MS);
  const value = result && typeof result === 'object' && 'value' in result ? result.value : result;
  return typeof value === 'string' && value.includes(pattern) ? value : null;
}

/**
 * Locate the snapshot file export_clean wrote. `browser.dump_dom` resolves a
 * relative outputPath against the app's authoritative workspace root, which is
 * not necessarily the repo root, so the candidates cover the plausible roots
 * and the file is then copied into the evidence dir (never moved: the write
 * location is part of the record).
 *
 * Existence alone is not proof: the path is not run-scoped, and a failed export
 * leaves the previous run's file in place. Only a file modified at or after
 * `notBefore` — stamped immediately before this run's dump — is accepted, so a
 * stale snapshot can never be reported as this run's capture.
 */
export function collectSnapshot({ repoRoot, themeDir, relativePath, evidenceDir, slug, notBefore = 0 }) {
  const candidates = [
    path.join(repoRoot, relativePath),
    path.join(themeDir, relativePath),
    path.resolve(relativePath),
  ];
  const stale = [];
  const found = candidates.find((candidate) => {
    let stat;
    try {
      stat = fs.statSync(candidate);
    } catch {
      return false;
    }
    if (!stat.isFile()) return false;
    if (stat.mtimeMs < notBefore) {
      stale.push({ candidate, mtime: new Date(stat.mtimeMs).toISOString() });
      return false;
    }
    return true;
  });
  if (!found) return { captured: false, searched: candidates, stale };
  const staged = path.join(evidenceDir, 'snapshots', `${slug}.html`);
  fs.mkdirSync(path.dirname(staged), { recursive: true });
  if (path.resolve(found) !== path.resolve(staged)) {
    fs.copyFileSync(found, staged);
  }
  return {
    captured: true,
    writtenTo: found,
    stagedPath: staged,
    sha256: sha256File(staged),
    byteLength: fs.statSync(staged).size,
  };
}

async function measureRoute(client, { spec, binding, tabId, repoRoot, themeDir, evidenceDir, snapshotRelDir }) {
  const url = pinnedRouteUrl(binding.baseUrl, spec.path, binding.themeId);
  const entry = {
    id: spec.id,
    kind: spec.kind,
    path: spec.path,
    url,
    steps: [],
    verdict: 'INCONCLUSIVE',
  };

  // 1. Navigate the bound tab.
  try {
    const nav = await client.callTool('anti.browser.navigate', { url, tabId }, NAVIGATE_TIMEOUT_MS);
    entry.steps.push({ step: 'navigate', ok: nav?.navigated !== false, target: nav?.target?.tabId ?? tabId });
  } catch (err) {
    routeError(entry, 'navigate', err);
    return entry;
  }

  // 2. Atomic diagnostic bundle: platform, Liquid scan, overflow, HS rules.
  let bundle = null;
  try {
    bundle = await client.callTool('theme.debug_bundle', { tabId }, BUNDLE_TIMEOUT_MS);
    const liquidErrors = bundle?.liquid?.errors?.length ?? null;
    entry.steps.push({
      step: 'debug_bundle',
      ok: true,
      platform: bundle?.platform?.platform ?? null,
      liquidErrors,
      overflow: bundle?.overflow?.hasOverflow === true,
      hsPassed: bundle?.hsRules?.passed ?? null,
    });
    if (liquidErrors !== null && liquidErrors > 0) {
      entry.verdict = 'FAIL';
      entry.steps.push({ step: 'liquid-clean', ok: false, errors: bundle.liquid.errors.slice(0, 10) });
      return entry;
    }
  } catch (err) {
    routeError(entry, 'debug_bundle', err);
    return entry;
  }

  // 3. Revision-bound clean-DOM snapshot.
  const relativePath = `${snapshotRelDir}/${spec.id}.html`;
  // Stamped before the dump: only a file this run wrote can satisfy the gate.
  const snapshotNotBefore = Date.now();
  try {
    const dump = await client.callTool('anti.theme.export_clean', {
      outputPath: relativePath,
      tabId,
      clean: true,
      materialize: true,
    }, SNAPSHOT_TIMEOUT_MS);
    const snapshot = collectSnapshot({ repoRoot, themeDir, relativePath, evidenceDir, slug: spec.id, notBefore: snapshotNotBefore });
    entry.steps.push({
      step: 'export_clean',
      ok: snapshot.captured,
      dumpResult: dump ?? null,
      snapshot,
    });
    if (!snapshot.captured) return entry;
    entry.snapshot = {
      sha256: snapshot.sha256,
      byteLength: snapshot.byteLength,
      themeId: binding.themeId,
      capturedAt: new Date().toISOString(),
      stagedPath: snapshot.stagedPath,
    };
  } catch (err) {
    routeError(entry, 'export_clean', err);
    return entry;
  }

  // 4. Full QA gate on real pages only.
  if (spec.kind === 'page') {
    try {
      const report = await client.callTool('theme.qa_validate', {
        tabId,
        workspaceRoot: themeDir,
        expectedUrl: url,
      }, QA_TIMEOUT_MS);
      const passed = report?.summary?.passed === true;
      const criticalCount = report?.summary?.criticalCount ?? null;
      entry.steps.push({
        step: 'qa_validate',
        ok: passed,
        verdict: report?.summary?.verdict ?? null,
        criticalCount,
        checklist: report?.checklist ?? null,
      });
      entry.verdict = passed && (criticalCount ?? 0) === 0 ? 'PASS' : 'FAIL';
      return entry;
    } catch (err) {
      routeError(entry, 'qa_validate', err);
      // A route-gate refusal (URL_*_MISMATCH) is a measurement, not a transport
      // fault: the tab is not on the route we asked for, so the route FAILS.
      entry.verdict = /URL_(HOST|THEME|PATH)_MISMATCH/.test(err instanceof Error ? err.message : String(err))
        ? 'FAIL'
        : 'INCONCLUSIVE';
      return entry;
    }
  }

  // AJAX fragment: navigation + clean bundle + captured snapshot is the pass bar.
  entry.verdict = 'PASS';
  return entry;
}

/**
 * Run the live-published suite.
 * @param {{ client: {callTool:Function}, binding: object, repoRoot: string,
 *   themeDir: string, evidenceDir: string, bridge?: object|null,
 *   tier?: string, layer?: string }} input
 */
export async function runLivePublished({
  client,
  binding,
  repoRoot,
  themeDir,
  evidenceDir,
  bridge = null,
  tier = TIER,
  layer = LAYERS.L1,
}) {
  if (!client || typeof client.callTool !== 'function') {
    return blockedVerdict(layer, 'BLOCKED', ['live-bridge: no AntiFan Desktop bridge client was supplied'], { limits: [...LIMITS] });
  }
  if (!binding?.themeId) {
    return blockedVerdict(layer, 'BLOCKED', ['theme-binding: no theme id resolved (env or .haravan-cli_local.json)'], { limits: [...LIMITS] });
  }

  const snapshotRelDir = '.canary/theme-harness/live-snapshots';
  const routes = HARNESS_ROUTE_SPECS.map((spec) => ({ ...spec }));

  // One harness-owned background tab for the whole suite.
  let tabId;
  try {
    const opened = await client.callTool('anti.browser.tabs.create', { url: 'about:blank', activate: false }, 30_000);
    tabId = opened?.tabId || opened?.target?.tabId || opened?.id;
    if (!tabId) throw new Error(`open-tab returned no tabId: ${JSON.stringify(opened)}`);
    // qa_validate measures the bound browser target, not a params.tabId, so the
    // harness tab must become the automation target before any QA call.
    await client.callTool('anti.browser.set_automation_target', { tabId }, 30_000);
  } catch (err) {
    return blockedVerdict(layer, 'BLOCKED', [`live-tab: could not open/bind a harness tab (${err instanceof Error ? err.message : String(err)})`], {
      limits: [...LIMITS],
      evidence: { bridge },
    });
  }

  const routeResults = [];
  try {
    for (const spec of routes) {
      // Live discovery fallback: when a default product/article path is dead the
      // route is re-pointed at the first matching link on its parent listing,
      // and the substitution is recorded on the route entry.
      if (spec.discover) {
        const parent = routeResults.find((r) => r.id === spec.discover.fromRoute);
        if (parent && parent.verdict !== 'INCONCLUSIVE') {
          try {
            const discovered = await discoverRoutePath(client, tabId, spec.discover.pattern);
            if (discovered && discovered !== spec.path) {
              spec.path = discovered;
              spec.discoveredPath = true;
            }
          } catch {
            // Discovery is best-effort; the default path stands and the route
            // gate decides whether it was real.
          }
        }
      }
      routeResults.push(await measureRoute(client, {
        spec, binding, tabId, repoRoot, themeDir, evidenceDir, snapshotRelDir,
      }));
    }
  } finally {
    try { await client.callTool('anti.browser.tabs.close', { tabId }, 15_000); } catch {}
  }

  const failed = routeResults.filter((r) => r.verdict === 'FAIL');
  const inconclusive = routeResults.filter((r) => r.verdict === 'INCONCLUSIVE');
  const verdict = failed.length > 0 ? 'FAIL' : inconclusive.length > 0 ? 'INCONCLUSIVE' : 'PASS';

  const routesReportPath = path.join(evidenceDir, `${layer}-routes.json`);
  writeRecordAtomic(routesReportPath, { layer, tier, themeId: binding.themeId, baseUrl: binding.baseUrl, routes: routeResults });

  return makeVerdict({
    layer,
    tier,
    verdict,
    checks: {
      routes: routeResults.map((r) => ({
        id: r.id,
        kind: r.kind,
        path: r.path,
        discoveredPath: r.discoveredPath === true,
        verdict: r.verdict,
        steps: r.steps.map((s) => ({ step: s.step, ok: s.ok })),
        snapshotSha256: r.snapshot?.sha256 ?? null,
      })),
      routeTotals: {
        total: routeResults.length,
        pass: routeResults.filter((r) => r.verdict === 'PASS').length,
        fail: failed.length,
        inconclusive: inconclusive.length,
      },
    },
    limits: [...LIMITS],
    evidence: { bridge, routesReportPath, snapshotDir: path.join(evidenceDir, 'snapshots') },
    notes: [
      ...(failed.length > 0 ? [`failing routes: ${failed.map((r) => r.id).join(', ')}`] : []),
      ...(inconclusive.length > 0 ? [`inconclusive routes: ${inconclusive.map((r) => r.id).join(', ')}`] : []),
    ],
  });
}
