// Throwaway: feed ThemeQaWorkflow the exact breakpoint shape NativeTabHost.runResponsiveCheck
// returns (keyed by preset id) and print the per-width `responsive` map in the report.
import { ThemeQaWorkflow, type ThemeQaWorkflowPorts } from '../../apps/AntiFan/src/main/qa/theme-qa-workflow';
import type { BrowserTarget } from '../../apps/AntiFan/src/shared/control-plane-contracts';

const target: BrowserTarget = { projectId: 'p', workspaceId: 'w', runtimeId: 'r', tabId: 'tab-1', browserEpoch: 1, documentGeneration: 1 } as BrowserTarget;
let gen = 1;
const browser = {
  dom: async () => '<html><body><main><h1>x</h1></main></body></html>',
  screenshot: async () => ({ artifactRef: { id: 'a', kind: 'screenshot' }, envelope: {} }),
  eval: async (_t: BrowserTarget, script: string) => {
    if (script.includes('rawDeltaX')) return { viewport: { name: 'mobile', width: 375, height: 667 }, measured: true, hasOverflow: false, deltaX: 0, scrollWidth: 375, clientWidth: 375, culprits: [] };
    if (script.includes('ERROR_PATTERNS')) return { hasErrors: false, errors: [], scannedElementsCount: 20 };
    if (script.includes('naturalWidth')) return { hasBrokenAssets: false, brokenAssets: [], totalImagesScanned: 1, totalStylesheetsScanned: 1 };
    if (script.includes('HS-') || script.includes('violations')) return { passed: true, totalViolations: 0, errorsCount: 0, warningsCount: 0, violations: [] };
    if (script.includes('crash')) return { hasCrash: false, errorsCount: 0, findings: [] };
    return {};
  },
  responsiveCheck: async () => ({
    ok: true,
    breakpoints: {
      'mobile-small': { width: 320, height: 568, mobile: true, hasHorizontalOverflow: true, scrollWidth: 520, clientWidth: 320 },
      'mobile-standard': { width: 375, height: 667, mobile: true, hasHorizontalOverflow: true, scrollWidth: 520, clientWidth: 375 },
      'tablet-portrait': { width: 768, height: 1024, mobile: false, hasHorizontalOverflow: false },
      'tablet-landscape': { width: 1024, height: 768, mobile: false, hasHorizontalOverflow: false },
      'desktop-laptop': { width: 1440, height: 900, mobile: false, hasHorizontalOverflow: false },
    },
  }),
  diagnostics: () => ({ console: [], failures: [] }),
  listTabs: () => [{ id: 'tab-1', url: 'https://store.example.com' }],
  getDocumentGeneration: () => gen,
  settleCapture: async () => ({ settleComplete: true, gates: { network: true, fonts: true, images: true, dom: true }, timingsMs: { network: 1, fonts: 1, images: 1, dom: 1, total: 4 }, brokenImages: [] }),
};
const ports = {
  browser,
  artifacts: { stage: (i: { kind: string }) => ({ id: `art-${i.kind}`, kind: i.kind, bytes: 1, createdAt: Date.now() }), readBytesById: () => ({ data: Buffer.from('<html></html>') }) },
  reload: async (t: BrowserTarget) => { gen++; return { reloaded: true, target: { ...t, documentGeneration: gen } }; },
} as unknown as ThemeQaWorkflowPorts;

void (async () => {
  const report = await new ThemeQaWorkflow(ports).validate({ runId: 'r', attemptId: 'a', workspaceRoot: 'E:/Work/x', target, multiBreakpoint: true } as never);
  const r = report as unknown as { summary: { verdict: string }; findings?: { overflow: { hasOverflow: boolean; viewport: { width: number } }; responsive?: unknown } };
  console.log(JSON.stringify({ verdict: r.summary.verdict, overflowHasOverflow: r.findings?.overflow.hasOverflow, overflowWidth: r.findings?.overflow.viewport.width, responsive: r.findings?.responsive }, null, 1));
})();
