import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  cookiesForUrl,
  getLighthouseJob,
  parseLighthouseParams,
  resolveLighthouseDir,
  startLighthouseJob,
  summarizeLighthouseReport,
} from '../../src/main/tools/lighthouse-runner';
import { resolveReportPath } from '../../src/main/tools/perf-capabilities';
import { CapabilityCatalogue } from '../../src/main/tools/capability-catalogue';
import { BrowserControlPort, BrowserHostPort } from '../../src/main/tools/browser-control-port';
import { registerPerfCapabilities } from '../../src/main/tools/perf-capabilities';
import { BrowserTarget, CapabilityRequestContext, RuntimeLease } from '../../src/shared/control-plane-contracts';

describe('registerPerfCapabilities', () => {
  const projectId = 'proj-1';
  const workspaceId = 'ws-1';
  const target: BrowserTarget = { projectId, workspaceId, runtimeId: 'run-1', tabId: 'tab-123', browserEpoch: 1, documentGeneration: 1 };
  const lease: RuntimeLease = {
    token: 'lease-tok', expiresAt: Date.now() + 60_000, runtimeId: 'run-1', projectId, workspaceId,
    protocolVersion: 1, hostEpoch: 1, ownerPid: process.pid, issuedAt: Date.now(),
  };
  const context: CapabilityRequestContext = {
    lease, leaseToken: 'lease-tok', projectId, workspaceId, runId: 'run-1', attemptId: 'att-1', browserTarget: target, grant: 'write',
  };
  const host: BrowserHostPort = {
    getTabList: () => [{ id: 'tab-123', title: 'Shop', url: 'https://shop.example/' }],
    navigate: async () => true,
    reload: async () => true,
    getDom: async () => '<html></html>',
    captureScreenshot: async () => 'img',
    evalJs: async () => ({}),
    getLighthouseTabContext: async () => ({ url: 'https://shop.example/', cookies: [{ name: 'preview_theme_id', value: '1', domain: 'shop.example', path: '/' }] }),
  };

  it('registers both tools in a real catalogue (a lane that forbids non-read effects throws here)', () => {
    const catalogue = new CapabilityCatalogue({ runtime: { mode: 'standalone', lifecycle: 'active' }, projectId, workspaceId, runtimeId: 'run-1', hostEpoch: 1 });
    registerPerfCapabilities(catalogue, new BrowserControlPort(host), () => 'E:/tmp/ws');
    const start = catalogue.get('anti.perf.lighthouse');
    const result = catalogue.get('anti.perf.lighthouse_result');
    assert.ok(start, 'anti.perf.lighthouse is registered');
    assert.ok(result, 'anti.perf.lighthouse_result is registered');
    assert.equal(start.risk, 'write');
    assert.equal(result.risk, 'read');
    assert.equal(start.policy.schedulerLane, 'unbounded');
  });

  it('rejects bad arguments before touching Lighthouse or the tab', async () => {
    const catalogue = new CapabilityCatalogue({ runtime: { mode: 'standalone', lifecycle: 'active' }, projectId, workspaceId, runtimeId: 'run-1', hostEpoch: 1 });
    registerPerfCapabilities(catalogue, new BrowserControlPort(host), () => 'E:/tmp/ws');
    await assert.rejects(async () => catalogue.get('anti.perf.lighthouse')!.execute({ url: 'file:///etc/passwd' }, context), /http or https/);
    await assert.rejects(async () => catalogue.get('anti.perf.lighthouse_result')!.execute({ jobId: 'nope' }, context), /jobId must be a value returned/);
  });
});

const REPORT = {
  lighthouseVersion: '13.6.0',
  requestedUrl: 'https://shop.example/?previewThemeId=1&token=secret',
  finalDisplayedUrl: 'https://shop.example/',
  fetchTime: '2026-11-19T00:00:00.000Z',
  configSettings: { formFactor: 'mobile' },
  categories: { performance: { score: 0.734 }, seo: { score: null } },
  environment: { benchmarkIndex: 1234.5, hostUserAgent: 'UA', networkUserAgent: 'NUA' },
  audits: {
    'first-contentful-paint': { numericValue: 1234.6 },
    'largest-contentful-paint': { numericValue: 2500.2 },
    'total-blocking-time': { numericValue: 80 },
    'cumulative-layout-shift': { numericValue: 0.12345 },
    'speed-index': { numericValue: 3000 },
    'total-byte-weight': { numericValue: 1000.4 },
    'network-requests': {
      details: {
        items: [
          { url: 'https://shop.example/' },
          { url: 'https://shop.example/themes/1182261/assets/app.js?v=9&sig=abc' },
          { url: 'https://cdn.example/other.css' },
        ],
      },
    },
  },
};

describe('parseLighthouseParams', () => {
  it('applies defaults', () => {
    const p = parseLighthouseParams({});
    assert.equal(p.formFactor, 'mobile');
    assert.deepEqual(p.categories, ['performance']);
    assert.equal(p.timeoutMs, 120_000);
    assert.equal(p.waitMs, 20_000);
  });
  it('rejects non-http urls, bad enums and out-of-range numbers', () => {
    assert.throws(() => parseLighthouseParams({ url: 'file:///etc/passwd' }), /http or https/);
    assert.throws(() => parseLighthouseParams({ url: 'javascript:alert(1)' }), /http or https/);
    assert.throws(() => parseLighthouseParams({ formFactor: 'tablet' }), /formFactor/);
    assert.throws(() => parseLighthouseParams({ categories: ['pwa'] }), /unknown category/);
    assert.throws(() => parseLighthouseParams({ timeoutMs: 1000 }), /timeoutMs/);
    assert.throws(() => parseLighthouseParams({ waitMs: 60_000 }), /waitMs/);
    assert.throws(() => parseLighthouseParams({ outputPath: 'report.txt' }), /\.json/);
  });
  it('dedupes categories', () => {
    assert.deepEqual(parseLighthouseParams({ categories: ['seo', 'seo', 'performance'] }).categories, ['seo', 'performance']);
  });
});

describe('cookiesForUrl', () => {
  const now = 1_000_000;
  const jar = [
    { name: 'host_only', value: '1', domain: 'shop.example', path: '/' },
    { name: 'dotted', value: '2', domain: '.shop.example', path: '/' },
    { name: 'parent', value: '3', domain: '.example', path: '/' },
    { name: 'other_site', value: '4', domain: 'evil.test', path: '/' },
    { name: 'suffix_trap', value: '5', domain: 'hop.example', path: '/' },
    { name: 'expired', value: '6', domain: 'shop.example', path: '/', expirationDate: now - 5 },
    { name: 'session', value: '7', domain: 'shop.example', path: '/', session: true },
    { name: 'secure_on_http', value: '8', domain: 'shop.example', path: '/', secure: true },
    { name: 'deep_path', value: '9', domain: 'shop.example', path: '/admin' },
  ];
  it('keeps only cookies the browser would send to the url', () => {
    const names = cookiesForUrl(jar, 'https://shop.example/collections', now).map((c) => c.name);
    assert.deepEqual(names, ['host_only', 'dotted', 'parent', 'session', 'secure_on_http']);
  });
  it('drops secure cookies on http and honours path prefixes', () => {
    const names = cookiesForUrl(jar, 'http://shop.example/admin/x', now).map((c) => c.name);
    assert.ok(!names.includes('secure_on_http'));
    assert.ok(names.includes('deep_path'));
  });
  it('never sends a host-only cookie to a subdomain (RFC 6265)', () => {
    const parentHostOnly = [
      { name: 'parent_host_only', value: 'a', domain: 'example.com', path: '/' },
      { name: 'parent_domain', value: 'b', domain: '.example.com', path: '/' },
      { name: 'flagged', value: 'c', domain: '.example.com', path: '/', hostOnly: true },
    ];
    const names = cookiesForUrl(parentHostOnly, 'https://shop.example.com/x', now).map((c) => c.name);
    assert.deepEqual(names, ['parent_domain']);
  });
});

describe('summarizeLighthouseReport', () => {
  it('extracts scores, metrics, environment and matching requests without query strings', () => {
    const s = summarizeLighthouseReport(REPORT, 'themes/1182261/assets');
    assert.equal(s.scores.performance, 73);
    assert.equal(s.scores.seo, null);
    assert.equal(s.metrics.fcpMs, 1235);
    assert.equal(s.metrics.cls, 0.123);
    assert.equal(s.environment.benchmarkIndex, 1235);
    assert.equal(s.lighthouseVersion, '13.6.0');
    assert.equal(s.requestedUrl, 'https://shop.example/');
    assert.equal(s.requestCount, 3);
    assert.deepEqual(s.matchingRequests, { pattern: 'themes/1182261/assets', count: 1, sample: ['https://shop.example/themes/1182261/assets/app.js'] });
  });
  it('refuses something that is not a Lighthouse report', () => {
    assert.throws(() => summarizeLighthouseReport({ foo: 1 }), /no categories/);
  });
});

describe('resolveLighthouseDir / resolveReportPath', () => {
  it('prefers the env override and fails with an install hint when absent', () => {
    const has = (p: string): boolean => p.replace(/\\/g, '/') === '/x/nm/lighthouse/package.json';
    assert.equal(resolveLighthouseDir({ ANTIFAN_LIGHTHOUSE_DIR: '/x/nm' }, has, '/app'), '/x/nm');
    assert.throws(() => resolveLighthouseDir({}, () => false, '/app'), /not installed/);
  });
  it('keeps the report inside the workspace and refuses overwrite', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lh-root-'));
    try {
      assert.throws(() => resolveReportPath(root, path.join(os.tmpdir(), 'elsewhere.json'), 'mobile'), /inside the workspace/);
      assert.throws(() => resolveReportPath(root, '../escape.json', 'mobile'), /inside the workspace/);
      const ok = resolveReportPath(root, 'out/a.json', 'mobile');
      assert.equal(path.dirname(ok), path.join(root, 'out'));
      fs.mkdirSync(path.join(root, 'out'));
      fs.writeFileSync(path.join(root, 'out', 'a.json'), '{}');
      assert.throws(() => resolveReportPath(root, 'out/a.json', 'mobile'), /already exists/);
      assert.throws(() => resolveReportPath(root, 'node_modules/x.json', 'mobile'), /protected name/);
      assert.throws(() => resolveReportPath(root, '.git/x.json', 'mobile'), /protected name/);
      assert.throws(() => resolveReportPath(root, 'a.json', 'mobile'), /one folder below the root|folder below the root/);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
  it('refuses a workspace folder that is a junction pointing out of the workspace', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lh-junction-'));
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'lh-outside-'));
    const link = path.join(root, 'linked');
    try {
      fs.symlinkSync(outside, link, 'junction');
      assert.throws(() => resolveReportPath(root, 'linked/x.json', 'mobile'), /Symlink or junction traversal is not permitted|outside the attached workspace/i);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });
});

describe('startLighthouseJob', () => {
  const makeRunner = (dir: string, body: string): string => {
    const file = path.join(dir, 'runner.mjs');
    fs.writeFileSync(file, body);
    return file;
  };
  it('hands the job (cookies included) to the child on stdin, never through argv', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lh-job-'));
    try {
      const seenPath = path.join(dir, 'seen.json').replace(/\\/g, '/');
      const runner = makeRunner(dir, `
        import fs from 'node:fs';
        const chunks = [];
        for await (const c of process.stdin) chunks.push(c);
        const job = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        fs.writeFileSync('${seenPath}', JSON.stringify({ names: job.cookies.map((c) => c.name), argv: process.argv.slice(2) }));
        fs.writeFileSync(job.outPath, ${JSON.stringify(JSON.stringify(REPORT))});
        console.log(JSON.stringify({ ok: true }));
      `);
      const outPath = path.join(dir, 'report.json');
      const jobId = startLighthouseJob({
        url: 'https://shop.example/', formFactor: 'mobile', categories: ['performance'], outPath, timeoutMs: 30_000,
        cookies: [{ name: 'preview_theme_id', value: 'v', domain: 'shop.example', path: '/' }],
        expectRequestContains: 'themes/1182261/assets',
      }, '/unused', runner);
      const state = await getLighthouseJob(jobId, 20_000);
      assert.equal(state.status, 'done');
      if (state.status === 'done') {
        assert.equal(state.summary.matchingRequests?.count, 1);
        assert.equal(state.reportPath, outPath);
      }
      const seen = JSON.parse(fs.readFileSync(seenPath, 'utf8'));
      assert.deepEqual(seen.names, ['preview_theme_id']);
      assert.deepEqual(seen.argv, [], 'no job path or cookie on the command line');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
  it('reports the child failure code instead of throwing', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lh-job-'));
    try {
      const runner = makeRunner(dir, `console.log(JSON.stringify({ ok: false, code: 'LIGHTHOUSE_TIMEOUT', message: 'slow' })); process.exit(3);`);
      const jobId = startLighthouseJob({
        url: 'https://shop.example/', formFactor: 'desktop', categories: ['performance'], outPath: path.join(dir, 'r.json'), timeoutMs: 30_000, cookies: [],
      }, '/unused', runner);
      const state = await getLighthouseJob(jobId, 20_000);
      assert.equal(state.status, 'failed');
      if (state.status === 'failed') assert.equal(state.code, 'LIGHTHOUSE_TIMEOUT');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
  it('still returns a jobId and reports the failure when the runtime cannot be spawned', async () => {
    const previous = process.env.ANTIFAN_NODE_BIN;
    process.env.ANTIFAN_NODE_BIN = path.join(os.tmpdir(), 'does-not-exist-node.exe');
    try {
      const jobId = startLighthouseJob({
        url: 'https://shop.example/', formFactor: 'mobile', categories: ['performance'], outPath: path.join(os.tmpdir(), 'nope.json'), timeoutMs: 30_000, cookies: [],
      }, '/unused', '/unused/runner.mjs');
      assert.match(jobId, /^lh-[0-9a-f]{8}$/);
      const state = await getLighthouseJob(jobId, 20_000);
      assert.equal(state.status, 'failed');
      if (state.status === 'failed') assert.match(state.code, /LIGHTHOUSE_SPAWN_FAILED|LIGHTHOUSE_FAILED/);
    } finally {
      if (previous === undefined) delete process.env.ANTIFAN_NODE_BIN;
      else process.env.ANTIFAN_NODE_BIN = previous;
    }
  });
});
