import { describe, it } from 'node:test';
import * as assert from 'node:assert';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createRequire } from 'node:module';
import { CapabilityCatalogue } from '../../src/main/tools/capability-catalogue';
import { BrowserControlPort } from '../../src/main/tools/browser-control-port';
import { registerBrowserCapabilities, parseQaValidateOptions } from '../../src/main/tools/browser-capabilities';
import { BrowserTarget, CapabilityError, CapabilityRequestContext } from '../../src/shared/control-plane-contracts';
import { ThemeQaWorkflow, type ThemeQaWorkflowPorts, type ThemeQaReport } from '../../src/main/qa/theme-qa-workflow';
import type { VisualSettleReceipt } from '../../src/main/verification/capture-settle';
import { buildDomQuietScript } from '../../src/main/verification/capture-settle';
import { LayoutOverflowEngine } from '../../src/main/qa/scanners/layout-overflow-engine';
import { LayoutIntegrityEngine } from '../../src/main/qa/scanners/layout-integrity-engine';
import { DomSemanticsScanner } from '../../src/main/qa/scanners/dom-semantics-scanner';
import { IMAGE_FRAME_RULE_IDS } from '../../src/main/qa/scanners/image-frame-scanner';
import { LiquidErrorScanner } from '../../src/main/qa/scanners/liquid-error-scanner';
import { BrokenAssetScanner } from '../../src/main/qa/scanners/broken-asset-scanner';
import { ServerCrashScanner } from '../../src/main/qa/scanners/server-crash-scanner';

const defaultOptions = {
  runtime: { mode: 'standalone' as const, lifecycle: 'active' as const },
  projectId: 'project-12345678901234567890',
  workspaceId: 'workspace-12345678901234567890',
  runtimeId: 'binding-12345678901234567890',
};

const THRESHOLDS = { minTextPx: 12, minControlPx: 44, minTapHitPx: 24, tapSpacingCirclePx: 24 };

const makeBoundBrowser = (liveUrl?: string) =>
  new BrowserControlPort({
    getTabList: () => [{ id: 'tab-1', url: liveUrl }],
    navigate: () => true,
    reload: () => true,
    getDom: async () => '<html></html>',
    captureScreenshot: async () => Buffer.from('png').toString('base64'),
    evalJs: async () => null,
  });

const makeBoundContext = (): CapabilityRequestContext => {
  const target: BrowserTarget = { projectId: defaultOptions.projectId, workspaceId: defaultOptions.workspaceId, runtimeId: defaultOptions.runtimeId, tabId: 'tab-1', browserEpoch: 1, documentGeneration: 1 };
  return { lease: { token: 'token-1', runtimeId: target.runtimeId, expiresAt: Date.now() + 60000, projectId: target.projectId, workspaceId: target.workspaceId, protocolVersion: 1, hostEpoch: 1, ownerPid: process.pid, issuedAt: Date.now() }, leaseToken: 'token-1', projectId: target.projectId, workspaceId: target.workspaceId, browserTarget: target, grant: 'read' };
};

const receiptFiles = (root: string): string[] => {
  const dir = path.join(root, '.antifan', 'qa-receipts');
  return fs.existsSync(dir) && fs.statSync(dir).isDirectory() ? fs.readdirSync(dir).filter((name) => name.endsWith('.json')) : [];
};

const readReceipts = (root: string): Array<Record<string, unknown>> =>
  receiptFiles(root).map((name) => JSON.parse(fs.readFileSync(path.join(root, '.antifan', 'qa-receipts', name), 'utf8')));

const layoutScript = LayoutOverflowEngine.getBrowserScanScript('active');
const integrityScript = LayoutIntegrityEngine.getBrowserScanScript('active');
const domSemanticsScript = DomSemanticsScanner.getBrowserScanScript();
const liquidScript = LiquidErrorScanner.getBrowserScanScript();
const assetScript = BrokenAssetScanner.getBrowserScanScript();
const serverCrashScript = ServerCrashScanner.getBrowserScanScript();

/** Ports whose every scanner returns a valid, clean measurement, so only the settle barrier decides completeness. */
const createMeasuredPorts = (overrides?: {
  settleCapture?: (options: Record<string, unknown>) => Promise<VisualSettleReceipt>;
  diagnostics?: () => { console: unknown[]; failures: unknown[] };
  tabUrl?: string;
}): ThemeQaWorkflowPorts => {
  let currentGen = 1;
  const browserObj: Record<string, unknown> = {
    dom: async () => '<html><body><main><h1>Storefront</h1></main></body></html>',
    screenshot: async () => ({ artifactRef: { id: 'art-screenshot', kind: 'screenshot' }, envelope: {} }),
    eval: async (_target: BrowserTarget, script: string) => {
      if (script === integrityScript) {
        return { measured: true, viewport: { width: 375, height: 812 }, findings: [], stats: { truncated: false, truncatedReasons: [], failedDetectors: [] } };
      }
      if (script === domSemanticsScript) {
        return { measured: true, score: 100, summary: { totalIssues: 0, criticalIssues: 0, h1Count: 1, imgMissingAltCount: 0, controlsMissingNameCount: 0, formControlsMissingLabelCount: 0, duplicateIdCount: 0, jsonLdInvalidCount: 0, jsonLdBlocksCount: 0, jsonLdTypes: [] }, findings: [] };
      }
      if (script === layoutScript || script.includes('deadband = 1.0 * dpr') || script.includes('rawDeltaX')) {
        return { measured: true, viewport: { name: 'mobile', width: 375, height: 812 }, hasOverflow: false, deltaX: 0, scrollWidth: 375, clientWidth: 375, culprits: [] };
      }
      if (script === liquidScript || script.includes('ERROR_PATTERNS')) return { hasErrors: false, errors: [], scannedElementsCount: 20 };
      if (script.includes('image-low-res')) {
        return {
          measured: true,
          viewport: { width: 375, height: 812 },
          findings: [],
          stats: { imagesChecked: 5, imagesPending: 0, durationMs: 2, truncated: false, truncatedReasons: [], measuredRules: [...IMAGE_FRAME_RULE_IDS], unmeasuredRules: [] },
        };
      }
      if (script === assetScript || script.includes('naturalWidth') || script.includes('img.decode')) {
        return { hasBrokenAssets: false, brokenAssets: [], totalImagesScanned: 5, totalStylesheetsScanned: 1 };
      }
      if (script.includes('floating-widget-overlap')) {
        return {
          measured: true,
          viewport: { width: 375, height: 812 },
          mobile: true,
          findings: [],
          stats: { textElementsChecked: 10, contrastIndeterminate: 0, controlsChecked: 4, floatingWidgets: 0, scrollPositions: 1, durationMs: 3, truncated: false, truncatedReasons: [], measuredRules: ['contrast-low', 'tap-target-small', 'tap-target-tiny', 'floating-widget-overlap', 'invisible-click-blocker', 'font-below-min', 'control-height-band', 'wrapped-label', 'icon-stroke-mismatch', 'overlay-fit'], unmeasuredRules: [] },
        };
      }
      if (script.includes('HS-') || script.includes('violations') || script.includes('sapo') || script.includes('haravan') || script.includes('evaluateHtml')) {
        return { passed: true, totalViolations: 0, errorsCount: 0, warningsCount: 0, violations: [] };
      }
      if (script === serverCrashScript || script.includes('crash') || script.includes('ServerCrashScanner')) return { hasCrash: false, errorsCount: 0, findings: [] };
      return {};
    },
    diagnostics: () => (overrides?.diagnostics ? overrides.diagnostics() : { console: [], failures: [] }),
    stateMatrix: async () => ({
      measured: true,
      safeMode: true,
      viewport: { width: 375, height: 812 },
      triggers: [],
      summary: { total: 0, passed: 0, warned: 0, failed: 0, notRun: 0, criticalCount: 0 },
      skippedTriggers: [],
      durationMs: 1,
    }),
    listTabs: () => [{ id: 'tab-1', url: overrides?.tabUrl ?? 'https://store.example.com/products/demo' }],
    getDocumentGeneration: () => currentGen,
    settleCapture: async (_target: BrowserTarget, _pane: string, _clip: unknown, options: Record<string, unknown>) =>
      overrides?.settleCapture
        ? overrides.settleCapture(options)
        : ({ settleComplete: true, gates: { network: true, fonts: true, images: true, dom: true }, timingsMs: { network: 1, fonts: 1, images: 1, dom: 1, total: 4 }, brokenImages: [] } as VisualSettleReceipt),
  };
  return {
    browser: browserObj as unknown as ThemeQaWorkflowPorts['browser'],
    artifacts: {
      stage: (item: { kind: string; data: Buffer | string }) => ({ id: `art-${item.kind}`, kind: item.kind, bytes: typeof item.data === 'string' ? Buffer.byteLength(item.data) : item.data.length, createdAt: Date.now() }),
      readBytesById: () => ({ data: Buffer.from('<html><body><main>Clean</main></body></html>') }),
    } as unknown as ThemeQaWorkflowPorts['artifacts'],
    reload: async (target: BrowserTarget) => {
      currentGen++;
      return { reloaded: true, target: { ...target, documentGeneration: currentGen } };
    },
    fsQuiescenceMs: 0,
  };
};

const markAsTheme = (root: string): string => {
  fs.mkdirSync(path.join(root, 'layout'), { recursive: true });
  fs.writeFileSync(path.join(root, 'layout', 'theme.liquid'), '', 'utf8');
  return root;
};

const withRoots = async <T>(count: number, run: (roots: [string, string]) => Promise<T>): Promise<T> => {
  const roots = Array.from({ length: Math.max(count, 2) }, () => markAsTheme(fs.mkdtempSync(path.join(os.tmpdir(), 'antifan-qa-receipt-v13-'))));
  try {
    return await run(roots as [string, string]);
  } finally {
    for (const root of roots) fs.rmSync(root, { recursive: true, force: true });
  }
};

const mockWorkflow = (report: Record<string, unknown>, calls?: { count: number }) =>
  ({ validate: async () => { if (calls) calls.count++; return report; } }) as unknown as ThemeQaWorkflow;

describe('theme.qa_validate receipt truthfulness', () => {
  it('refuses a workspaceRoot outside the bound workspace and leaves no receipt behind', async () => {
    await withRoots(2, async ([defaultRoot, outside]) => {
      const calls = { count: 0 };
      const catalogue = new CapabilityCatalogue(defaultOptions);
      registerBrowserCapabilities(catalogue, makeBoundBrowser('https://shop.example.com/'), mockWorkflow({ summary: { passed: true, criticalCount: 0 } }, calls), () => defaultRoot);
      for (let i = 0; i < 10; i++) {
        await assert.rejects(
          catalogue.dispatch('theme.qa_validate', { tabId: 'tab-1', workspaceRoot: outside }, makeBoundContext()),
          (err: unknown) => err instanceof CapabilityError && err.code === 'WORKSPACE_MISMATCH'
        );
      }
      assert.strictEqual(calls.count, 0, 'the workflow must not run for a refused root');
      assert.deepStrictEqual(receiptFiles(defaultRoot), []);
      assert.deepStrictEqual(receiptFiles(outside), []);
      assert.strictEqual(fs.existsSync(path.join(defaultRoot, '.antifan')), false);
    });
  });

  it('still accepts the bound root and a directory inside it', async () => {
    await withRoots(1, async ([root]) => {
      const nested = path.join(root, 'theme');
      markAsTheme(nested);
      const catalogue = new CapabilityCatalogue(defaultOptions);
      registerBrowserCapabilities(catalogue, makeBoundBrowser(), mockWorkflow({ summary: { passed: true, criticalCount: 0 } }), () => root);
      await catalogue.dispatch('theme.qa_validate', { tabId: 'tab-1', workspaceRoot: root }, makeBoundContext());
      await catalogue.dispatch('theme.qa_validate', { tabId: 'tab-1', workspaceRoot: nested }, makeBoundContext());
      assert.strictEqual(receiptFiles(root).length, 1);
      assert.strictEqual(receiptFiles(nested).length, 1);
    });
  });

  it('reports RECEIPT_WRITE_FAILED and refuses certification when the receipt cannot be persisted', async () => {
    await withRoots(1, async ([root]) => {
      fs.writeFileSync(path.join(root, '.antifan'), 'not a directory');
      const catalogue = new CapabilityCatalogue(defaultOptions);
      registerBrowserCapabilities(catalogue, makeBoundBrowser(), mockWorkflow({ summary: { passed: true, criticalCount: 0, certification: 'CERTIFIED' } }), () => root);
      const report = (await catalogue.dispatch('theme.qa_validate', { tabId: 'tab-1', workspaceRoot: root }, makeBoundContext())) as ThemeQaReport;
      assert.deepStrictEqual(report.receipt, { written: false, code: 'RECEIPT_WRITE_FAILED' });
      assert.notStrictEqual(report.summary.certification, 'CERTIFIED');
    });
  });

  it('reports the written receipt path on the returned report', async () => {
    await withRoots(1, async ([root]) => {
      const catalogue = new CapabilityCatalogue(defaultOptions);
      registerBrowserCapabilities(catalogue, makeBoundBrowser(), mockWorkflow({ summary: { passed: true, criticalCount: 0, certification: 'CERTIFIED' } }), () => root);
      const report = (await catalogue.dispatch('theme.qa_validate', { tabId: 'tab-1', workspaceRoot: root }, makeBoundContext())) as ThemeQaReport;
      assert.strictEqual(report.receipt?.written, true);
      assert.ok(report.receipt?.path && fs.existsSync(report.receipt.path));
      assert.strictEqual(report.summary.certification, 'CERTIFIED');
    });
  });

  it('writes a v1.3 receipt with profile, measuredRules, coverage, requested root, redirect flag and a per-call id', async () => {
    await withRoots(1, async ([root]) => {
      const report = {
        summary: { passed: true, criticalCount: 0 },
        profile: 'build-strict',
        measuredRules: ['liquid', 'tap-target-small'],
        coverage: { measured: 8, expected: 8 },
        coverageFloor: 1,
      };
      const catalogue = new CapabilityCatalogue(defaultOptions);
      registerBrowserCapabilities(catalogue, makeBoundBrowser(), mockWorkflow(report), () => root);
      await catalogue.dispatch('theme.qa_validate', { tabId: 'tab-1', workspaceRoot: root }, makeBoundContext());
      await catalogue.dispatch('theme.qa_validate', { tabId: 'tab-1' }, makeBoundContext());
      const receipts = readReceipts(root);
      assert.strictEqual(receipts.length, 2, 'two calls sharing a run id must not overwrite each other');
      for (const receipt of receipts) {
        assert.strictEqual(receipt.receiptVersion, '1.3');
        assert.strictEqual(receipt.profile, 'build-strict');
        assert.deepStrictEqual(receipt.measuredRules, ['liquid', 'tap-target-small']);
        assert.deepStrictEqual(receipt.coverage, { measured: 8, expected: 8 });
        assert.strictEqual(receipt.workspaceRootRedirected, false);
        assert.ok(typeof receipt.callId === 'string' && (receipt.callId as string).length >= 8);
      }
      assert.notStrictEqual(receipts[0]!.callId, receipts[1]!.callId);
      assert.deepStrictEqual(receipts.map((r) => r.workspaceRootRequested).sort(), [null, root].sort());
    });
  });

  it('echoes accepted waivers on the receipt', async () => {
    await withRoots(1, async ([root]) => {
      const catalogue = new CapabilityCatalogue(defaultOptions);
      registerBrowserCapabilities(catalogue, makeBoundBrowser(), mockWorkflow({ summary: { passed: true, criticalCount: 0 } }), () => root);
      await catalogue.dispatch('theme.qa_validate', { tabId: 'tab-1', workspaceRoot: root, waivers: [{ rule: 'overlay-fit', reason: 'cookie banner is intentionally full width' }] }, makeBoundContext());
      assert.deepStrictEqual(readReceipts(root)[0]!.waivers, [{ rule: 'overlay-fit', reason: 'cookie banner is intentionally full width' }]);
    });
  });

  it('rejects malformed waivers, thresholds, coverage floor and settle overrides', () => {
    assert.throws(() => parseQaValidateOptions({ waivers: [{ rule: 'overlay-fit' }] }), (e: unknown) => e instanceof CapabilityError && e.code === 'INVALID_ARGUMENT');
    assert.throws(() => parseQaValidateOptions({ waivers: [{ rule: ' ', reason: 'x' }] }), CapabilityError);
    assert.throws(() => parseQaValidateOptions({ thresholds: { minTextPx: 12 } }), CapabilityError);
    assert.throws(() => parseQaValidateOptions({ thresholds: { ...THRESHOLDS, minTextPx: -1 } }), CapabilityError);
    assert.throws(() => parseQaValidateOptions({ coverageFloor: 1.5 }), CapabilityError);
    assert.throws(() => parseQaValidateOptions({ ignoreSelectors: ['', '.a'] }), CapabilityError);
    assert.throws(() => parseQaValidateOptions({ settle: { domTimeoutMs: 0 } }), CapabilityError);
    assert.throws(() => parseQaValidateOptions({ profile: 'lenient' }), CapabilityError);
  });

  it('merges top-level and settle ignore selectors without duplicates', () => {
    const parsed = parseQaValidateOptions({ thresholds: THRESHOLDS, coverageFloor: 0.5, ignoreSelectors: ['.ticker', '.clock'], settle: { ignoreSelectors: ['.clock'], domTimeoutMs: 800 } });
    assert.deepStrictEqual(parsed.settle, { ignoreSelectors: ['.clock', '.ticker'], domTimeoutMs: 800 });
    assert.deepStrictEqual(parsed.thresholds, THRESHOLDS);
    assert.strictEqual(parsed.coverageFloor, 0.5);
  });
});

describe('theme.qa_validate coverage floor', () => {
  const run = (floor: number | undefined, profile: 'audit' | 'build-strict' = 'audit') =>
    new ThemeQaWorkflow({
      ...createMeasuredPorts(),
      browser: { ...(createMeasuredPorts().browser as unknown as Record<string, unknown>), eval: async () => ({}) } as unknown as ThemeQaWorkflowPorts['browser'],
    }).validate({
      runId: 'run-floor',
      attemptId: 'att-floor',
      workspaceRoot: os.tmpdir(),
      target: makeBoundContext().browserTarget as BrowserTarget,
      multiBreakpoint: false,
      profile,
      ...(floor !== undefined ? { coverageFloor: floor } : {}),
    });

  it('turns a below-floor run INCONCLUSIVE with the unmeasured families named', async () => {
    const report = await run(1);
    assert.ok(report.coverage.measured < report.coverage.expected);
    assert.strictEqual(report.coverageFloor, 1);
    assert.notStrictEqual(report.summary.verdict, 'PASS');
    assert.ok((report.findings?.evidenceGaps ?? []).some((gap) => /below the floor 1/.test(gap)));
  });

  it('does not add a coverage gap when the floor is met', async () => {
    const report = await run(0);
    assert.strictEqual(report.coverageFloor, 0);
    assert.ok(!(report.findings?.evidenceGaps ?? []).some((gap) => /below the floor/.test(gap)));
  });

  it('defaults the floor to 1 under build-strict and 0 under audit', async () => {
    assert.strictEqual((await run(undefined, 'build-strict')).coverageFloor, 1);
    assert.strictEqual((await run(undefined, 'audit')).coverageFloor, 0);
  });
});

describe('theme.qa_validate settle overrides', () => {
  const dispatchWithTicker = async (root: string, ignoreSelectors: string[] | undefined, seen: Array<Record<string, unknown>>) => {
    const ports = createMeasuredPorts({
      settleCapture: async (options) => {
        seen.push(options);
        const ignored = Array.isArray(options.ignoreSelectors) && (options.ignoreSelectors as string[]).includes('.ticker');
        return ignored
          ? ({ settleComplete: true, gates: { network: true, fonts: true, images: true, dom: true }, timingsMs: { network: 1, fonts: 1, images: 1, dom: 1, total: 4 }, brokenImages: [] } as VisualSettleReceipt)
          : ({ settleComplete: false, failingPredicate: 'dom', gates: { network: true, fonts: true, images: true, dom: false }, timingsMs: { network: 1, fonts: 1, images: 1, dom: 400, total: 403 }, brokenImages: [] } as VisualSettleReceipt);
      },
    });
    const catalogue = new CapabilityCatalogue(defaultOptions);
    registerBrowserCapabilities(catalogue, makeBoundBrowser('https://store.example.com/products/demo'), new ThemeQaWorkflow(ports), () => root);
    const report = (await catalogue.dispatch(
      'theme.qa_validate',
      { tabId: 'tab-1', workspaceRoot: root, multiBreakpoint: false, profile: 'audit', ...(ignoreSelectors ? { ignoreSelectors } : {}) },
      makeBoundContext()
    )) as ThemeQaReport;
    return { report, receipt: readReceipts(root)[0]! };
  };

  it('names the failing settle predicate on a DEGRADED receipt instead of leaving it blank', async () => {
    await withRoots(1, async ([root]) => {
      const { report, receipt } = await dispatchWithTicker(root, undefined, []);
      assert.strictEqual(report.execution, 'DEGRADED');
      assert.strictEqual(receipt.execution, 'DEGRADED');
      assert.strictEqual(receipt.errorCode, 'SETTLE_INCOMPLETE');
      assert.strictEqual(receipt.errorReason, 'dom');
      const settle = receipt.settle as Record<string, unknown>;
      assert.strictEqual(settle.failingPredicate, 'dom');
      assert.strictEqual(settle.domUnstable, true);
      assert.ok((settle.evidenceGaps as string[]).some((gap) => /DOM mutations/.test(gap)));
      assert.ok(!(settle.ignoreSelectors as string[]).includes('.ticker'));
    });
  });

  it('forwards a per-call ignoreSelectors override and echoes it so the pass is auditable', async () => {
    await withRoots(1, async ([root]) => {
      const seen: Array<Record<string, unknown>> = [];
      const { report, receipt } = await dispatchWithTicker(root, ['.ticker'], seen);
      assert.deepStrictEqual(seen[0]!.ignoreSelectors, ['.ticker']);
      assert.strictEqual(report.execution, 'COMPLETED');
      assert.strictEqual(receipt.execution, 'COMPLETED');
      assert.strictEqual(receipt.errorCode, null);
      assert.strictEqual(receipt.errorReason, null);
      assert.ok(((receipt.settle as Record<string, unknown>).ignoreSelectors as string[]).includes('.ticker'));
    });
  });
});

describe('DOM-quiet predicate ignores mutations inside matching subtrees', () => {
  type JsdomWindow = Window & typeof globalThis & { eval: (src: string) => unknown };
  type JsdomCtor = new (html: string, options?: Record<string, unknown>) => { window: JsdomWindow };
  const loadJsdom = (): JsdomCtor => {
    const req = createRequire(__filename);
    const resolved = req.resolve('jsdom', { paths: process.env.ANTIFAN_JSDOM ? [process.env.ANTIFAN_JSDOM, path.dirname(__filename)] : [path.dirname(__filename)] });
    return (req(resolved) as { JSDOM: JsdomCtor }).JSDOM;
  };

  const settleWithTicker = async (ignoreSelectors: string[] | undefined): Promise<unknown> => {
    const JSDOM = loadJsdom();
    const dom = new JSDOM('<!doctype html><body><main><p>Static copy</p><span class="ticker">0</span></main></body>', { pretendToBeVisual: true, runScripts: 'outside-only' });
    const w = dom.window;
    let n = 0;
    // A real page timer is the behavior under test: the predicate must see genuine MutationObserver records from a 5ms text ticker.
    const timer = w.setInterval(() => {
      const text = w.document.querySelector('.ticker')!.firstChild as CharacterData;
      text.data = String(++n);
    }, 5);
    try {
      return await (w.eval(buildDomQuietScript(300, ignoreSelectors ? { ignoreSelectors } : {})) as Promise<unknown>);
    } finally {
      w.clearInterval(timer);
      w.close();
    }
  };

  it('stays unquiet while a text ticker mutates and no override is given', async () => {
    assert.strictEqual(await settleWithTicker(undefined), false);
  });

  it('settles once the ticker subtree is named in ignoreSelectors (character-data mutations included)', async () => {
    assert.strictEqual(await settleWithTicker(['.ticker']), true);
  });
});

describe('v1.3 receipt sample from a real ThemeQaWorkflow run', () => {
  it('produces a QA_PASSED / COMPLETED receipt with every v1.3 field', async () => {
    await withRoots(1, async ([root]) => {
      const catalogue = new CapabilityCatalogue(defaultOptions);
      registerBrowserCapabilities(catalogue, makeBoundBrowser('https://store.example.com/products/demo'), new ThemeQaWorkflow(createMeasuredPorts()), () => root);
      const report = (await catalogue.dispatch(
        'theme.qa_validate',
        { tabId: 'tab-1', workspaceRoot: root, multiBreakpoint: false, profile: 'build-strict', thresholds: THRESHOLDS, expectedUrl: 'https://store.example.com/products/demo' },
        makeBoundContext()
      )) as ThemeQaReport;
      const receipt = readReceipts(root)[0]!;
      assert.strictEqual(receipt.receiptVersion, '1.3');
      assert.strictEqual(receipt.verdict, 'QA_PASSED', JSON.stringify({ gaps: report.findings?.evidenceGaps, settle: receipt.settle, errorMessage: receipt.errorMessage }));
      assert.strictEqual(receipt.execution, 'COMPLETED');
      assert.strictEqual(receipt.errorCode, null);
      assert.strictEqual(receipt.profile, 'build-strict');
      assert.deepStrictEqual(receipt.coverage, { measured: report.coverage.measured, expected: report.coverage.expected });
      assert.strictEqual(report.coverage.measured, report.coverage.expected);
      assert.ok((receipt.measuredRules as string[]).includes('font-below-min'));
      assert.ok((receipt.measuredRules as string[]).includes('liquid'));
      const sampleOut = process.env.ANTIFAN_RECEIPT_SAMPLE_OUT;
      if (sampleOut) {
        fs.mkdirSync(path.dirname(sampleOut), { recursive: true });
        fs.writeFileSync(sampleOut, JSON.stringify({ ...receipt, workspaceRoot: '__ROOT__' }, null, 2), 'utf8');
      }
    });
  });
});

describe('theme.qa_validate expected document status', () => {
  const NOT_FOUND_URL = 'https://store.example.com/pages/khong-ton-tai';
  const notFoundDiagnostics = () => ({ console: [], failures: [{ isMainFrame: true, status: 404, validatedURL: NOT_FOUND_URL, errorCode: 0 }] });
  const run = async (root: string, extra: Record<string, unknown>) => {
    const catalogue = new CapabilityCatalogue(defaultOptions);
    const ports = createMeasuredPorts({ diagnostics: notFoundDiagnostics, tabUrl: NOT_FOUND_URL });
    registerBrowserCapabilities(catalogue, makeBoundBrowser(NOT_FOUND_URL), new ThemeQaWorkflow(ports), () => root);
    const report = (await catalogue.dispatch('theme.qa_validate', { tabId: 'tab-1', workspaceRoot: root, multiBreakpoint: false, profile: 'audit', ...extra }, makeBoundContext())) as ThemeQaReport;
    return { report, receipt: readReceipts(root)[0]! };
  };

  it('reports ROUTE_404 as critical on a route that was not declared a 404 screen', async () => {
    await withRoots(1, async ([root]) => {
      const { report } = await run(root, {});
      assert.ok(report.summary.criticalCount >= 1);
      assert.strictEqual(report.summary.passed, false);
    });
  });

  it('accepts the 404 the contract screen declares and echoes it on the receipt', async () => {
    await withRoots(1, async ([root]) => {
      const { report, receipt } = await run(root, { expectedStatus: 404 });
      assert.strictEqual(report.summary.criticalCount, 0);
      assert.strictEqual(receipt.expectedStatus, 404);
    });
  });

  it('still reports a 404 when the contract expects a different status', async () => {
    await withRoots(1, async ([root]) => {
      const { report } = await run(root, { expectedStatus: 200 });
      assert.ok(report.summary.criticalCount >= 1);
    });
  });

  it('refuses a malformed expectedStatus', () => {
    assert.throws(() => parseQaValidateOptions({ expectedStatus: 99 }), CapabilityError);
    assert.throws(() => parseQaValidateOptions({ expectedStatus: '404' }), CapabilityError);
    assert.strictEqual(parseQaValidateOptions({ expectedStatus: 404 }).expectedStatus, 404);
  });
});

describe('theme.qa_validate auth redirect', () => {
  it('classifies a hosted sign-in landing that dropped themeid as unmeasured instead of a route-gate error', async () => {
    await withRoots(1, async ([root]) => {
      const catalogue = new CapabilityCatalogue(defaultOptions);
      registerBrowserCapabilities(catalogue, makeBoundBrowser('https://store.example.com/account/login'), new ThemeQaWorkflow(createMeasuredPorts()), () => root);
      const report = (await catalogue.dispatch(
        'theme.qa_validate',
        { tabId: 'tab-1', workspaceRoot: root, multiBreakpoint: false, profile: 'audit', expectedUrl: 'https://store.example.com/account/login?themeid=1001' },
        makeBoundContext()
      )) as ThemeQaReport;
      const receipt = readReceipts(root)[0]!;
      assert.strictEqual(receipt.authRedirect, true);
      assert.strictEqual(receipt.verdict, 'QA_INCONCLUSIVE');
      assert.strictEqual(receipt.execution, 'DEGRADED');
      assert.strictEqual(receipt.errorCode, 'AUTH_REDIRECT');
      assert.strictEqual(receipt.passed, false);
      assert.strictEqual(report.summary.passed, false);
      assert.strictEqual(report.summary.verdict, 'INCONCLUSIVE');
      assert.ok((report.findings?.evidenceGaps ?? []).some((gap) => /^AUTH_REDIRECT:/.test(gap)));
    });
  });

  it('still refuses a theme mismatch on a route that is not an authentication page', async () => {
    await withRoots(1, async ([root]) => {
      const catalogue = new CapabilityCatalogue(defaultOptions);
      registerBrowserCapabilities(catalogue, makeBoundBrowser('https://store.example.com/products/demo'), new ThemeQaWorkflow(createMeasuredPorts()), () => root);
      await assert.rejects(
        catalogue.dispatch('theme.qa_validate', { tabId: 'tab-1', workspaceRoot: root, expectedUrl: 'https://store.example.com/products/demo?themeid=1001' }, makeBoundContext()),
        (err: unknown) => err instanceof CapabilityError && err.code === 'URL_THEME_MISMATCH'
      );
    });
  });
});

describe('theme.qa_validate font settle retry', () => {
  const complete = { settleComplete: true, gates: { network: true, fonts: true, images: true, dom: true }, timingsMs: { network: 1, fonts: 1, images: 1, dom: 1, total: 4 }, brokenImages: [] } as VisualSettleReceipt;
  const fontsPending = { settleComplete: false, failingPredicate: 'fonts', gates: { network: true, fonts: false, images: true, dom: true }, timingsMs: { network: 1, fonts: 500, images: 1, dom: 1, total: 503 }, brokenImages: [] } as VisualSettleReceipt;
  const validate = (settle: (call: number) => VisualSettleReceipt) => {
    let calls = 0;
    const ports = createMeasuredPorts({ settleCapture: async () => settle(++calls) });
    const promise = new ThemeQaWorkflow(ports).validate({
      runId: 'run-fonts',
      attemptId: 'att-fonts',
      workspaceRoot: os.tmpdir(),
      target: makeBoundContext().browserTarget as BrowserTarget,
      multiBreakpoint: false,
      profile: 'audit',
    });
    return { promise, calls: () => calls };
  };

  it('retries once when the font gate was intermittently unsettled and records the retry', async () => {
    const run = validate((call) => (call === 1 ? fontsPending : complete));
    const report = await run.promise;
    assert.strictEqual(run.calls(), 2);
    assert.strictEqual(report.execution, 'COMPLETED');
    assert.strictEqual(report.settleReceipt?.settleRetries, 1);
  });

  it('stays bounded to one retry and still refuses a font gate that never settles', async () => {
    const run = validate(() => fontsPending);
    await assert.rejects(run.promise, (err: unknown) => err instanceof CapabilityError && err.code === 'SETTLE_INCOMPLETE');
    assert.strictEqual(run.calls(), 2);
  });

  it('does not retry a soft gate gap', async () => {
    const domPending = { settleComplete: false, failingPredicate: 'dom', gates: { network: true, fonts: true, images: true, dom: false }, timingsMs: { network: 1, fonts: 1, images: 1, dom: 400, total: 403 }, brokenImages: [] } as VisualSettleReceipt;
    const run = validate(() => domPending);
    const report = await run.promise;
    assert.strictEqual(run.calls(), 1);
    assert.strictEqual(report.execution, 'DEGRADED');
  });
});

describe('theme.qa_validate receipt certification fields', () => {
  const validateWith = async (root: string, summary: Record<string, unknown>, extra: Record<string, unknown> = {}) => {
    const catalogue = new CapabilityCatalogue(defaultOptions);
    registerBrowserCapabilities(catalogue, makeBoundBrowser(), mockWorkflow({ summary: { passed: true, criticalCount: 0, ...summary } }), () => root);
    await catalogue.dispatch('theme.qa_validate', { tabId: 'tab-1', workspaceRoot: root, ...extra }, makeBoundContext());
    return readReceipts(root)[0]!;
  };

  it('records a structural pass with its reasons and threshold source', async () => {
    await withRoots(1, async ([root]) => {
      const receipt = await validateWith(root, { certification: 'STRUCTURAL', certificationReasons: ['mobile viewport not measured'], thresholdsSource: 'default' });
      assert.strictEqual(receipt.certification, 'STRUCTURAL');
      assert.deepStrictEqual(receipt.certificationReasons, ['mobile viewport not measured']);
      assert.strictEqual(receipt.thresholdsSource, 'default');
      assert.strictEqual(receipt.scope, 'structural');
    });
  });

  it('records a certified pass and an annotation-scoped pass distinctly', async () => {
    await withRoots(1, async ([root]) => {
      const certified = await validateWith(root, { certification: 'CERTIFIED', thresholdsSource: 'contract' });
      assert.strictEqual(certified.certification, 'CERTIFIED');
      assert.strictEqual(certified.thresholdsSource, 'contract');
      assert.strictEqual(certified.scope, 'certified');
      assert.deepStrictEqual(certified.certificationReasons, []);
    });
    await withRoots(1, async ([root]) => {
      const scoped = await validateWith(root, { certification: 'STRUCTURAL' }, { annotationId: 'annotation_1' });
      assert.strictEqual(scoped.scope, 'annotation');
    });
  });

  it('leaves thresholdsSource null when the report names none', async () => {
    await withRoots(1, async ([root]) => {
      const receipt = await validateWith(root, { certification: 'STRUCTURAL' });
      assert.strictEqual(receipt.thresholdsSource, null);
    });
  });
});

describe('theme.qa_validate theme-root guard', () => {
  const notTheme = (err: unknown) => err instanceof CapabilityError && err.code === 'WORKSPACE_NOT_THEME';

  it('refuses an empty root before the workflow runs and writes no receipt', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'antifan-qa-notheme-'));
    try {
      const calls = { count: 0 };
      const catalogue = new CapabilityCatalogue(defaultOptions);
      registerBrowserCapabilities(catalogue, makeBoundBrowser(), mockWorkflow({ summary: { passed: true, criticalCount: 0 } }, calls), () => root);
      await assert.rejects(catalogue.dispatch('theme.qa_validate', { tabId: 'tab-1', workspaceRoot: root }, makeBoundContext()), notTheme);
      assert.strictEqual(calls.count, 0);
      assert.strictEqual(receiptFiles(root).length, 0);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('names the diacritic-named sibling that holds the theme when the bound root is an ASCII-folded stray', async () => {
    const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'antifan-qa-stray-'));
    try {
      const real = markAsTheme(path.join(parent, 'Thời Trang'));
      const stray = path.join(parent, 'Thoi Trang');
      fs.mkdirSync(stray);
      const catalogue = new CapabilityCatalogue(defaultOptions);
      registerBrowserCapabilities(catalogue, makeBoundBrowser(), mockWorkflow({ summary: { passed: true, criticalCount: 0 } }), () => stray);
      await assert.rejects(
        catalogue.dispatch('theme.qa_validate', { tabId: 'tab-1', workspaceRoot: stray }, makeBoundContext()),
        (err: unknown) => notTheme(err) && (err as CapabilityError).message.includes(real)
      );
      assert.strictEqual(receiptFiles(stray).length, 0);
    } finally {
      fs.rmSync(parent, { recursive: true, force: true });
    }
  });

  it('accepts a root carrying only config/settings.html and a plain folder when allowNonTheme is set', async () => {
    const legacy = fs.mkdtempSync(path.join(os.tmpdir(), 'antifan-qa-legacy-'));
    const plain = fs.mkdtempSync(path.join(os.tmpdir(), 'antifan-qa-plain-'));
    try {
      fs.mkdirSync(path.join(legacy, 'config'));
      fs.writeFileSync(path.join(legacy, 'config', 'settings.html'), '', 'utf8');
      for (const [root, extra] of [[legacy, {}], [plain, { allowNonTheme: true }]] as Array<[string, Record<string, unknown>]>) {
        const catalogue = new CapabilityCatalogue(defaultOptions);
        registerBrowserCapabilities(catalogue, makeBoundBrowser(), mockWorkflow({ summary: { passed: true, criticalCount: 0 } }), () => root);
        await catalogue.dispatch('theme.qa_validate', { tabId: 'tab-1', workspaceRoot: root, ...extra }, makeBoundContext());
        assert.strictEqual(receiptFiles(root).length, 1);
      }
    } finally {
      fs.rmSync(legacy, { recursive: true, force: true });
      fs.rmSync(plain, { recursive: true, force: true });
    }
  });

  it('treats a root holding only the AntiFan-owned directory as empty', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'antifan-qa-owned-'));
    try {
      fs.mkdirSync(path.join(root, '.antifan'));
      const catalogue = new CapabilityCatalogue(defaultOptions);
      registerBrowserCapabilities(catalogue, makeBoundBrowser(), mockWorkflow({ summary: { passed: true, criticalCount: 0 } }), () => root);
      await assert.rejects(catalogue.dispatch('theme.qa_validate', { tabId: 'tab-1', workspaceRoot: root }, makeBoundContext()), notTheme);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
