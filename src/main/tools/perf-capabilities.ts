/**
 * `anti.perf.lighthouse` (+ `anti.perf.lighthouse_result`): run Lighthouse, the engine behind
 * the DevTools Lighthouse tab, under the cookies of an AntiFan tab, e.g. to measure an
 * unpublished Sapo theme that is only served with a preview cookie.
 *
 * The run happens in a separate headless Chrome (see lighthouse-runner.ts), so the user's tab is
 * never driven and AntiFan exposes no remote-debugging port. A run takes 30-90 s, longer than
 * one MCP call should block: the start call waits up to `waitMs` and otherwise answers
 * `status: "running"` with a jobId that `anti.perf.lighthouse_result` polls.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { CapabilityError, assertNoReparseTraversal, assertWorkspaceContained, type BrowserTarget, type CapabilityRequestContext } from '../../shared/control-plane-contracts';
import { extraRootNameRefusal } from '../qa/diagnostics-filter';
import type { CapabilityCatalogue } from './capability-catalogue';
import type { BrowserControlPort } from './browser-control-port';
import { resolveCallerWorkspaceRoot } from './file-capabilities';
import {
  LIGHTHOUSE_CATEGORIES,
  LIGHTHOUSE_WAIT_DEFAULT_MS,
  LIGHTHOUSE_WAIT_MAX_MS,
  cookiesForUrl,
  getLighthouseJob,
  normalizeHttpUrl,
  parseLighthouseParams,
  resolveLighthouseDir,
  resolveRunnerScript,
  startLighthouseJob,
  type LighthouseJobState,
} from './lighthouse-runner';
// Circular edge (browser-capabilities registers this module): resolved lazily inside the registration body.
import * as browserCaps from './browser-capabilities';

function publicState(state: LighthouseJobState): Record<string, unknown> {
  if (state.status === 'running') return { jobId: state.jobId, status: 'running', elapsedMs: Date.now() - state.startedAt, next: 'call anti.perf.lighthouse_result with this jobId' };
  if (state.status === 'failed') return { jobId: state.jobId, status: 'failed', code: state.code, message: state.message };
  return { jobId: state.jobId, status: 'done', durationMs: state.finishedAt - state.startedAt, reportPath: state.reportPath, ...state.summary };
}

/**
 * Real, workspace-contained, reparse-free, not-yet-existing .json path for the full report.
 * `assertWorkspaceContained` alone is lexical for a file that does not exist yet, so a junction such
 * as `<root>/node_modules -> D:/elsewhere` would pass; the reparse walk and the protected-name rules
 * below close that, and they match the rules the workspace file port already enforces on writes.
 */
export function resolveReportPath(root: string, requested: string | undefined, formFactor: string, now = new Date()): string {
  if (!root) throw new CapabilityError('WORKSPACE_UNBOUND', 'anti.perf.lighthouse: no workspace root to write the report into');
  const stamp = now.toISOString().replace(/[:.]/g, '-');
  const candidate = requested
    ? (path.isAbsolute(requested) ? requested : path.join(root, requested))
    : path.join(root, 'perf-reports', `lighthouse-${stamp}-${formFactor}.json`);
  const resolved = path.resolve(candidate);
  try {
    assertWorkspaceContained(root, resolved);
  } catch {
    throw new CapabilityError('OUTSIDE_WORKSPACE', 'anti.perf.lighthouse: outputPath must stay inside the workspace');
  }
  const refused = extraRootNameRefusal(path.relative(root, resolved).split(/[\\/]+/).filter(Boolean), 'write');
  if (refused) throw new CapabilityError('INVALID_ARGUMENT', `anti.perf.lighthouse: outputPath refused - ${refused}`);
  // Throws OUTSIDE_WORKSPACE when any existing folder on the way is a symlink/junction.
  assertNoReparseTraversal(root, resolved);
  if (fs.existsSync(resolved)) {
    throw new CapabilityError('INVALID_ARGUMENT', 'anti.perf.lighthouse: outputPath already exists; choose a new file name');
  }
  return resolved;
}

export function registerPerfCapabilities(
  catalogue: CapabilityCatalogue,
  browser: BrowserControlPort,
  getWorkspaceRoot?: () => string,
): void {
  catalogue.register({
    name: 'anti.perf.lighthouse',
    description: 'Run Lighthouse (DevTools engine) on a URL under an AntiFan tab\'s cookies, in a separate headless Chrome (the tab is untouched) - e.g. an unpublished Sapo theme via preview_theme_id. Returns scores, FCP/LCP/TBT/CLS/SI, environment.benchmarkIndex, lighthouseVersion and the JSON report path. May take 30-90 s: otherwise status running + a jobId for anti.perf.lighthouse_result. Cookies are never returned. Writes one new .json in the workspace.',
    risk: 'write',
    requiresBrowserTarget: true,
    policy: browserCaps.makeBrowserPolicy({ effect: 'idempotent-write', risk: 'write', requiresBrowserTarget: true, lane: 'unbounded', timeoutMs: 45_000 }),
    inputSchema: {
      type: 'object',
      properties: {
        tabId: { type: 'string', description: 'Tab whose cookies are used (default: the bound tab)' },
        url: { type: 'string', description: 'http(s) URL to audit (default: the tab\'s current URL)' },
        formFactor: { type: 'string', enum: ['mobile', 'desktop'], description: 'Default mobile' },
        categories: { type: 'array', items: { type: 'string', enum: [...LIGHTHOUSE_CATEGORIES] }, description: 'Default ["performance"]' },
        outputPath: { type: 'string', description: 'New .json file, one folder below the workspace root (default perf-reports/lighthouse-<time>-<formFactor>.json); protected names (node_modules, .git, .env*) are refused' },
        expectRequestContains: { type: 'string', description: 'Count requests whose URL contains this text (e.g. "themes/1182261/assets") and report them as matchingRequests' },
        timeoutMs: { type: 'number', description: 'Hard limit of the run, 30000-300000, default 120000' },
        waitMs: { type: 'number', description: `How long this call waits for the result, 0-${LIGHTHOUSE_WAIT_MAX_MS}, default ${LIGHTHOUSE_WAIT_DEFAULT_MS}` },
      },
    },
    execute: async (params: Record<string, unknown>, context: CapabilityRequestContext) => {
      const parsed = parseLighthouseParams(params);
      const lighthouseDir = resolveLighthouseDir();
      const runnerScript = resolveRunnerScript();
      const tab = await browser.getLighthouseTabContext(context.browserTarget as BrowserTarget, parsed.tabId);
      const url = parsed.url ?? normalizeHttpUrl(tab.url);
      const root = resolveCallerWorkspaceRoot(catalogue, context, getWorkspaceRoot);
      const outPath = resolveReportPath(root, parsed.outputPath, parsed.formFactor);
      const jobId = startLighthouseJob({
        url,
        formFactor: parsed.formFactor,
        categories: parsed.categories,
        outPath,
        timeoutMs: parsed.timeoutMs,
        cookies: cookiesForUrl(tab.cookies, url),
        ...(parsed.expectRequestContains ? { expectRequestContains: parsed.expectRequestContains } : {}),
      }, lighthouseDir, runnerScript);
      return publicState(await getLighthouseJob(jobId, parsed.waitMs));
    },
  });

  catalogue.register({
    name: 'anti.perf.lighthouse_result',
    description: 'Fetch the state/result of an anti.perf.lighthouse run by jobId, waiting up to waitMs for it to finish.',
    risk: 'read',
    requiresBrowserTarget: false,
    policy: browserCaps.makeBrowserPolicy({ effect: 'read', risk: 'read', requiresBrowserTarget: false, timeoutMs: 45_000 }),
    inputSchema: {
      type: 'object',
      properties: {
        jobId: { type: 'string' },
        waitMs: { type: 'number', description: `0-${LIGHTHOUSE_WAIT_MAX_MS}, default ${LIGHTHOUSE_WAIT_DEFAULT_MS}` },
      },
      required: ['jobId'],
    },
    execute: async (params: { jobId?: unknown; waitMs?: unknown }) => {
      if (typeof params?.jobId !== 'string' || !/^lh-[0-9a-f]{8}$/.test(params.jobId)) {
        throw new CapabilityError('INVALID_ARGUMENT', 'anti.perf.lighthouse_result: jobId must be a value returned by anti.perf.lighthouse');
      }
      const waitMs = params.waitMs === undefined ? LIGHTHOUSE_WAIT_DEFAULT_MS : params.waitMs;
      if (typeof waitMs !== 'number' || !Number.isInteger(waitMs) || waitMs < 0 || waitMs > LIGHTHOUSE_WAIT_MAX_MS) {
        throw new CapabilityError('INVALID_ARGUMENT', `anti.perf.lighthouse_result: waitMs must be an integer between 0 and ${LIGHTHOUSE_WAIT_MAX_MS}`);
      }
      return publicState(await getLighthouseJob(params.jobId, waitMs));
    },
  });
}
