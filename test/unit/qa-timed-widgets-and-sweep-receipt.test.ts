import { describe, it } from 'node:test';
import * as assert from 'node:assert';
import { ThemeQaWorkflow, type ThemeQaWorkflowPorts } from '../../src/main/qa/theme-qa-workflow';
import { BrowserTarget } from '../../src/shared/control-plane-contracts';
import { DEFAULT_SWEEP_BREAKPOINTS } from '../../src/main/browser/sweep-viewports';
import { PLATFORM_PREVIEW_CHROME_SELECTORS } from '../../src/main/qa/platform-preview-chrome';

const target: BrowserTarget = {
  projectId: 'proj-test',
  workspaceId: 'ws-test',
  runtimeId: 'rt-test',
  tabId: 'tab-1',
  browserEpoch: 1,
  documentGeneration: 1,
};

const visualResult = (timedWidgets?: { latent: number; appeared: number; waitedMs: number; selectors: string[] }) => ({
  measured: true,
  viewport: { width: 1440, height: 900 },
  mobile: false,
  findings: [],
  stats: { textElementsChecked: 10, contrastIndeterminate: 0, controlsChecked: 0, floatingWidgets: 0, scrollPositions: 2, durationMs: 3, truncated: false, truncatedReasons: [], ...(timedWidgets ? { timedWidgets } : {}) },
});

interface SweepCall {
  tabId?: string;
  perWidthScript?: string;
  breakpoints?: unknown;
}

function makePorts(visual: unknown, sweepCalls: SweepCall[] = []): ThemeQaWorkflowPorts {
  const browser: Record<string, unknown> = {
    dom: async () => '<html><body><main><h1>Storefront</h1></main></body></html>',
    screenshot: async () => ({ artifactRef: { id: 'art-screenshot', kind: 'screenshot' }, envelope: {} }),
    eval: async (_t: BrowserTarget, script: string) => {
      if (script.includes("ruleId: 'contrast-low'")) return visual;
      if (script.includes('naturalWidth') || script.includes('img.decode')) {
        return { hasBrokenAssets: false, brokenAssets: [], totalImagesScanned: 5, totalStylesheetsScanned: 1 };
      }
      if (script.includes('ERROR_PATTERNS')) return { hasErrors: false, errors: [], scannedElementsCount: 20 };
      if (script.includes('deadband = 1.0 * dpr') || script.includes('rawDeltaX')) {
        return { viewport: { name: 'desktop', width: 1440, height: 900 }, hasOverflow: false, deltaX: 0, scrollWidth: 1440, clientWidth: 1440, culprits: [] };
      }
      if (script.includes('HS-') || script.includes('violations') || script.includes('evaluateHtml')) {
        return { passed: true, totalViolations: 0, errorsCount: 0, warningsCount: 0, violations: [] };
      }
      if (script.includes('crash') || script.includes('ServerCrashScanner')) return { hasCrash: false, errorsCount: 0, findings: [] };
      return {};
    },
    diagnostics: () => ({ console: [], failures: [] }),
    listTabs: () => [{ id: 'tab-1', url: 'https://store.example.com' }],
    getDocumentGeneration: () => 1,
    settleCapture: async () => ({
      settleComplete: true,
      gates: { network: true, fonts: true, images: true, dom: true },
      timingsMs: { network: 1, fonts: 1, images: 1, dom: 1, total: 4 },
      brokenImages: [],
    }),
    responsiveCheck: async (params: SweepCall) => {
      sweepCalls.push(params);
      return {
        ok: true,
        breakpoints: Object.fromEntries(
          DEFAULT_SWEEP_BREAKPOINTS.map((bp) => [bp.id, { width: bp.width, height: bp.height, mobile: bp.mobile, hasHorizontalOverflow: false, scrollWidth: bp.width, clientWidth: bp.width }]),
        ),
      };
    },
  };
  return {
    browser: browser as unknown as ThemeQaWorkflowPorts['browser'],
    artifacts: {
      stage: (item: { kind: string; data: Buffer | string }) => ({ id: `art-${item.kind}`, kind: item.kind, bytes: 1, createdAt: Date.now() }),
      readBytesById: () => ({ data: Buffer.from('<html><body><main>Clean</main></body></html>') }),
    } as unknown as ThemeQaWorkflowPorts['artifacts'],
    reload: async (t: BrowserTarget) => ({ reloaded: true, target: t }),
  };
}

const validate = (ports: ThemeQaWorkflowPorts) =>
  new ThemeQaWorkflow(ports).validate({
    runId: 'run-receipt',
    attemptId: 'att-receipt',
    workspaceRoot: 'E:/Work/test-theme',
    target,
    profile: 'audit',
  });

describe('theme.qa_validate timer-widget receipt', () => {
  it('records that a hidden popup never showed and how long the scan waited', async () => {
    const report = await validate(makePorts(visualResult({ latent: 1, appeared: 0, waitedMs: 9000, selectors: ['div.pop-sale'] })));
    assert.deepStrictEqual(report.findings?.timedWidgets, { seen: false, waitedMs: 9000 });
  });

  it('records that the popup showed once it appeared', async () => {
    const report = await validate(makePorts(visualResult({ latent: 1, appeared: 1, waitedMs: 4200, selectors: ['div.pop-sale'] })));
    assert.deepStrictEqual(report.findings?.timedWidgets, { seen: true, waitedMs: 4200 });
  });

  it('omits the field when no timer-driven popup was waited for', async () => {
    const report = await validate(makePorts(visualResult()));
    assert.strictEqual(report.findings?.timedWidgets, undefined);
    assert.ok(!('timedWidgets' in (report.findings ?? {})));
  });
});

describe('theme.qa_validate default sweep', () => {
  it('asks the host for its default widths and reports the 1920 and 2560 readings', async () => {
    const sweepCalls: SweepCall[] = [];
    const report = await validate(makePorts(visualResult(), sweepCalls));
    assert.strictEqual(sweepCalls.length, 1, 'the default run performs the multi-width sweep');
    assert.strictEqual(sweepCalls[0]?.breakpoints, undefined, 'no caller width list narrows the default sweep');
    const responsive = report.findings?.responsive ?? {};
    assert.deepStrictEqual(Object.keys(responsive).sort((a, b) => Number(a) - Number(b)), DEFAULT_SWEEP_BREAKPOINTS.map((bp) => String(bp.width)));
    for (const width of ['1920', '2560']) {
      assert.strictEqual(responsive[width]?.documentOverflow, false, `${width}px must carry a measured overflow reading`);
    }
  });

  it('runs the integrity scan at every sweep width with the full preview chrome skip list', async () => {
    const sweepCalls: SweepCall[] = [];
    await validate(makePorts(visualResult(), sweepCalls));
    const script = sweepCalls[0]?.perWidthScript ?? '';
    for (const selector of PLATFORM_PREVIEW_CHROME_SELECTORS) {
      assert.ok(script.includes(JSON.stringify(selector).slice(1, -1)), `sweep integrity script is missing ${selector}`);
    }
  });
});
