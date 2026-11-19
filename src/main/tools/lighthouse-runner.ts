/**
 * Engine behind `anti.perf.lighthouse`: argument validation, cookie scoping, the child
 * process that runs Lighthouse (scripts/lighthouse-run.mjs, system Node) and the summary
 * extracted from the report. Pure helpers are exported for unit tests.
 *
 * Lighthouse runs in its own throw-away headless Chrome; AntiFan opens no debugging port.
 * The tab's cookies (HttpOnly included) travel main -> 0600 temp file -> child, are scoped
 * to the target host and are deleted when the child exits; they are never logged or returned.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { CapabilityError } from '../../shared/control-plane-contracts';

export type LighthouseFormFactor = 'mobile' | 'desktop';
export const LIGHTHOUSE_CATEGORIES = ['performance', 'accessibility', 'best-practices', 'seo'] as const;
export const LIGHTHOUSE_TIMEOUT_DEFAULT_MS = 120_000;
export const LIGHTHOUSE_TIMEOUT_MAX_MS = 300_000;
export const LIGHTHOUSE_WAIT_DEFAULT_MS = 20_000;
export const LIGHTHOUSE_WAIT_MAX_MS = 25_000;
const MAX_RETAINED_JOBS = 8;

export interface LighthouseCookie {
  name: string;
  value: string;
  domain?: string;
  path?: string;
  secure?: boolean;
  httpOnly?: boolean;
  session?: boolean;
  expirationDate?: number;
  sameSite?: string;
}

export interface LighthouseParams {
  tabId?: string;
  url?: string;
  formFactor: LighthouseFormFactor;
  categories: string[];
  outputPath?: string;
  timeoutMs: number;
  waitMs: number;
  expectRequestContains?: string;
}

function invalid(message: string): CapabilityError {
  return new CapabilityError('INVALID_ARGUMENT', `anti.perf.lighthouse: ${message}`);
}

export function parseLighthouseParams(raw: Record<string, unknown> | undefined): LighthouseParams {
  const p = raw ?? {};
  let url: string | undefined;
  if (p.url !== undefined) {
    if (typeof p.url !== 'string') throw invalid('url must be a string');
    url = normalizeHttpUrl(p.url);
  }
  const formFactor = p.formFactor === undefined ? 'mobile' : p.formFactor;
  if (formFactor !== 'mobile' && formFactor !== 'desktop') throw invalid('formFactor must be "mobile" or "desktop"');
  let categories: string[] = ['performance'];
  if (p.categories !== undefined) {
    if (!Array.isArray(p.categories) || p.categories.length === 0 || p.categories.length > LIGHTHOUSE_CATEGORIES.length) {
      throw invalid(`categories must be a non-empty array drawn from ${LIGHTHOUSE_CATEGORIES.join(', ')}`);
    }
    for (const c of p.categories) {
      if (typeof c !== 'string' || !(LIGHTHOUSE_CATEGORIES as readonly string[]).includes(c)) {
        throw invalid(`unknown category "${String(c).slice(0, 40)}"; allowed: ${LIGHTHOUSE_CATEGORIES.join(', ')}`);
      }
    }
    categories = [...new Set(p.categories as string[])];
  }
  const timeoutMs = intInRange('timeoutMs', p.timeoutMs, 30_000, LIGHTHOUSE_TIMEOUT_MAX_MS, LIGHTHOUSE_TIMEOUT_DEFAULT_MS);
  const waitMs = intInRange('waitMs', p.waitMs, 0, LIGHTHOUSE_WAIT_MAX_MS, LIGHTHOUSE_WAIT_DEFAULT_MS);
  let outputPath: string | undefined;
  if (p.outputPath !== undefined) {
    if (typeof p.outputPath !== 'string' || !p.outputPath.trim() || p.outputPath.length > 400) throw invalid('outputPath must be a non-empty string');
    if (!p.outputPath.toLowerCase().endsWith('.json')) throw invalid('outputPath must end with .json');
    outputPath = p.outputPath.trim();
  }
  let expectRequestContains: string | undefined;
  if (p.expectRequestContains !== undefined) {
    if (typeof p.expectRequestContains !== 'string' || !p.expectRequestContains || p.expectRequestContains.length > 200) {
      throw invalid('expectRequestContains must be a non-empty string of at most 200 characters');
    }
    expectRequestContains = p.expectRequestContains;
  }
  if (p.tabId !== undefined && (typeof p.tabId !== 'string' || !p.tabId)) throw invalid('tabId must be a non-empty string');
  return {
    ...(p.tabId ? { tabId: p.tabId as string } : {}),
    ...(url ? { url } : {}),
    formFactor,
    categories,
    ...(outputPath ? { outputPath } : {}),
    timeoutMs,
    waitMs,
    ...(expectRequestContains ? { expectRequestContains } : {}),
  };
}

function intInRange(field: string, value: unknown, min: number, max: number, fallback: number): number {
  if (value === undefined) return fallback;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) {
    throw invalid(`${field} must be an integer between ${min} and ${max}`);
  }
  return value;
}

/** http(s) only; returns the normalised href. */
export function normalizeHttpUrl(value: string): string {
  let parsed: URL;
  try { parsed = new URL(value.trim()); } catch { throw invalid('url is not a valid absolute URL'); }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') throw invalid('url must use http or https');
  return parsed.href;
}

/** Cookies a browser would send to `url`: domain match (host-only or dotted) and path prefix; expired ones dropped. */
export function cookiesForUrl(cookies: readonly LighthouseCookie[], url: string, nowSeconds = Date.now() / 1000): LighthouseCookie[] {
  const target = new URL(url);
  const host = target.hostname.toLowerCase();
  const reqPath = target.pathname || '/';
  return cookies.filter((c) => {
    if (!c.name || typeof c.value !== 'string' || !c.domain) return false;
    if (c.session !== true && typeof c.expirationDate === 'number' && c.expirationDate > 0 && c.expirationDate < nowSeconds) return false;
    const dotted = c.domain.startsWith('.');
    const domain = c.domain.replace(/^\./, '').toLowerCase();
    const domainOk = host === domain || (dotted && host.endsWith(`.${domain}`)) || (!dotted && host.endsWith(`.${domain}`));
    if (!domainOk) return false;
    if (c.secure && target.protocol !== 'https:') return false;
    const cp = c.path || '/';
    return reqPath === cp || reqPath.startsWith(cp.endsWith('/') ? cp : `${cp}/`);
  });
}

function redactUrl(url: string): string {
  try { const u = new URL(url); return `${u.origin}${u.pathname}`; } catch { return (String(url).split('?')[0] ?? '').slice(0, 200); }
}

export interface LighthouseSummary {
  lighthouseVersion: string;
  requestedUrl: string;
  finalUrl: string;
  formFactor: string;
  fetchTime: string;
  scores: Record<string, number | null>;
  metrics: Record<string, number | null>;
  environment: { benchmarkIndex: number | null; hostUserAgent: string | null; networkUserAgent: string | null };
  requestCount: number;
  totalByteWeight: number | null;
  matchingRequests?: { pattern: string; count: number; sample: string[] };
  runWarnings: string[];
}

const METRIC_AUDITS: Record<string, string> = {
  fcpMs: 'first-contentful-paint',
  lcpMs: 'largest-contentful-paint',
  tbtMs: 'total-blocking-time',
  cls: 'cumulative-layout-shift',
  speedIndexMs: 'speed-index',
  ttiMs: 'interactive',
};

interface LighthouseAudit { numericValue?: number; details?: { items?: Array<{ url?: string }> } }
interface LighthouseReport {
  lighthouseVersion?: string;
  requestedUrl?: string;
  finalUrl?: string;
  finalDisplayedUrl?: string;
  fetchTime?: string;
  configSettings?: { formFactor?: string };
  categories?: Record<string, { score?: number | null } | undefined>;
  audits?: Record<string, LighthouseAudit | undefined>;
  environment?: { benchmarkIndex?: number; hostUserAgent?: string; networkUserAgent?: string };
  runWarnings?: unknown[];
}

export function summarizeLighthouseReport(raw: unknown, expectRequestContains?: string): LighthouseSummary {
  const lhr = raw as LighthouseReport | null; // parsed report JSON; shape verified just below
  if (!lhr || typeof lhr !== 'object' || !lhr.categories || !lhr.audits) {
    throw new CapabilityError('RESOURCE_FAILURE', 'anti.perf.lighthouse: report has no categories/audits');
  }
  const scores: Record<string, number | null> = {};
  for (const [id, cat] of Object.entries(lhr.categories)) {
    scores[id] = typeof cat?.score === 'number' ? Math.round(cat.score * 100) : null;
  }
  const metrics: Record<string, number | null> = {};
  for (const [key, auditId] of Object.entries(METRIC_AUDITS)) {
    const value = lhr.audits[auditId]?.numericValue;
    metrics[key] = typeof value === 'number' ? (key === 'cls' ? Math.round(value * 1000) / 1000 : Math.round(value)) : null;
  }
  const items: Array<{ url?: string }> = lhr.audits['network-requests']?.details?.items ?? [];
  const bytes = lhr.audits['total-byte-weight']?.numericValue;
  const summary: LighthouseSummary = {
    lighthouseVersion: String(lhr.lighthouseVersion ?? ''),
    requestedUrl: redactUrl(String(lhr.requestedUrl ?? '')),
    finalUrl: redactUrl(String(lhr.finalDisplayedUrl ?? lhr.finalUrl ?? '')),
    formFactor: String(lhr.configSettings?.formFactor ?? ''),
    fetchTime: String(lhr.fetchTime ?? ''),
    scores,
    metrics,
    environment: {
      benchmarkIndex: typeof lhr.environment?.benchmarkIndex === 'number' ? Math.round(lhr.environment.benchmarkIndex) : null,
      hostUserAgent: lhr.environment?.hostUserAgent ?? null,
      networkUserAgent: lhr.environment?.networkUserAgent ?? null,
    },
    requestCount: items.length,
    totalByteWeight: typeof bytes === 'number' ? Math.round(bytes) : null,
    runWarnings: Array.isArray(lhr.runWarnings) ? lhr.runWarnings.slice(0, 10).map((w: unknown) => String(w).slice(0, 300)) : [],
  };
  if (expectRequestContains) {
    const hits = items.filter((i) => typeof i.url === 'string' && i.url.includes(expectRequestContains));
    summary.matchingRequests = { pattern: expectRequestContains, count: hits.length, sample: hits.slice(0, 5).map((i) => redactUrl(i.url as string)) };
  }
  return summary;
}

/** Folder holding `lighthouse/` (+ chrome-launcher, puppeteer-core): env override, then the app's node_modules. */
export function resolveLighthouseDir(
  env: NodeJS.ProcessEnv = process.env,
  exists: (p: string) => boolean = fs.existsSync,
  startDir: string = __dirname,
): string {
  const candidates: string[] = [];
  if (env.ANTIFAN_LIGHTHOUSE_DIR) candidates.push(env.ANTIFAN_LIGHTHOUSE_DIR);
  let dir = startDir;
  for (let i = 0; i < 8; i++) {
    candidates.push(path.join(dir, 'node_modules'));
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  for (const c of candidates) if (exists(path.join(c, 'lighthouse', 'package.json'))) return c;
  throw new CapabilityError(
    'CAPABILITY_NOT_FOUND',
    'anti.perf.lighthouse: the "lighthouse" package is not installed. Install it (npm i lighthouse) or point ANTIFAN_LIGHTHOUSE_DIR at a node_modules folder that contains it.',
  );
}

export function resolveRunnerScript(startDir: string = __dirname, exists: (p: string) => boolean = fs.existsSync): string {
  let dir = startDir;
  for (let i = 0; i < 8; i++) {
    const candidate = path.join(dir, 'scripts', 'lighthouse-run.mjs');
    if (exists(candidate)) return candidate;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new CapabilityError('FILE_NOT_FOUND', 'anti.perf.lighthouse: scripts/lighthouse-run.mjs was not found next to the app');
}

export interface LighthouseJobInput {
  url: string;
  formFactor: LighthouseFormFactor;
  categories: string[];
  outPath: string;
  timeoutMs: number;
  cookies: LighthouseCookie[];
  expectRequestContains?: string;
}

export type LighthouseJobState =
  | { jobId: string; status: 'running'; startedAt: number }
  | { jobId: string; status: 'done'; startedAt: number; finishedAt: number; reportPath: string; summary: LighthouseSummary }
  | { jobId: string; status: 'failed'; startedAt: number; finishedAt: number; code: string; message: string };

interface JobRecord { state: LighthouseJobState; done: Promise<void> }
const jobs = new Map<string, JobRecord>();

function retain(jobId: string, record: JobRecord): void {
  jobs.set(jobId, record);
  while (jobs.size > MAX_RETAINED_JOBS) {
    const oldest = [...jobs.entries()].find(([, r]) => r.state.status !== 'running');
    if (!oldest) break;
    jobs.delete(oldest[0]);
  }
}

export function startLighthouseJob(input: LighthouseJobInput, lighthouseDir: string, runnerScript: string): string {
  const jobId = `lh-${randomUUID().slice(0, 8)}`;
  const startedAt = Date.now();
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'antifan-lh-'));
  const jobFile = path.join(tmp, 'job.json');
  fs.writeFileSync(jobFile, JSON.stringify({
    lighthouseDir,
    url: input.url,
    formFactor: input.formFactor,
    categories: input.categories,
    outPath: input.outPath,
    timeoutMs: input.timeoutMs,
    cookies: input.cookies,
  }), { mode: 0o600 });
  const { promise: donePromise, resolve } = Promise.withResolvers<void>();
  const record: JobRecord = { state: { jobId, status: 'running', startedAt }, done: donePromise };
  const fail = (code: string, message: string): void => {
    record.state = { jobId, status: 'failed', startedAt, finishedAt: Date.now(), code, message };
  };
  ((): void => {
    const nodeBin = process.env.ANTIFAN_NODE_BIN || 'node';
    let stdout = '';
    let settled = false;
    let killer: NodeJS.Timeout | undefined;
    const finish = (): void => {
      if (settled) return;
      settled = true;
      clearTimeout(killer);
      try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* temp cleanup is best effort */ }
      resolve();
    };
    let child: ChildProcess;
    try {
      const env = { ...process.env };
      delete env.ELECTRON_RUN_AS_NODE;
      child = spawn(nodeBin, [runnerScript, jobFile], { stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true, env });
    } catch (err) {
      fail('LIGHTHOUSE_SPAWN_FAILED', err instanceof Error ? err.message : String(err));
      finish();
      return;
    }
    killer = setTimeout(() => { try { child.kill(); } catch { /* already gone */ } }, input.timeoutMs + 5_000);
    child.stdout?.on('data', (chunk: Buffer) => { if (stdout.length < 20_000) stdout += chunk.toString('utf8'); });
    child.on('error', (err) => { fail('LIGHTHOUSE_SPAWN_FAILED', err.message); finish(); });
    child.on('close', (code) => {
      const lastLine = stdout.trim().split(/\r?\n/).filter(Boolean).pop() ?? '';
      let parsed: { ok?: boolean; code?: string; message?: string } | undefined;
      try { parsed = JSON.parse(lastLine); } catch { parsed = undefined; }
      if (parsed?.ok === true) {
        try {
          const lhr = JSON.parse(fs.readFileSync(input.outPath, 'utf8'));
          record.state = { jobId, status: 'done', startedAt, finishedAt: Date.now(), reportPath: input.outPath, summary: summarizeLighthouseReport(lhr, input.expectRequestContains) };
        } catch (err) {
          fail('LIGHTHOUSE_BAD_REPORT', err instanceof Error ? err.message : String(err));
        }
      } else {
        fail(parsed?.code || 'LIGHTHOUSE_FAILED', parsed?.message || `Lighthouse child exited with code ${code} and no result`);
      }
      finish();
    });
  })();
  retain(jobId, record);
  return jobId;
}

/** Waits up to waitMs for the job to settle, then returns its current state. */
export async function getLighthouseJob(jobId: string, waitMs: number): Promise<LighthouseJobState> {
  const record = jobs.get(jobId);
  if (!record) throw new CapabilityError('SESSION_STALE', `anti.perf.lighthouse: unknown or expired jobId ${jobId}`);
  if (record.state.status === 'running' && waitMs > 0) {
    const { promise: timer, resolve: tick } = Promise.withResolvers<void>();
    const handle = setTimeout(tick, waitMs);
    await Promise.race([record.done, timer]);
    clearTimeout(handle);
  }
  return record.state;
}
