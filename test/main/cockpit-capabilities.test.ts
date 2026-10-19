import { describe, it } from 'node:test';
import * as assert from 'node:assert';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

import { CapabilityCatalogue, type CapabilityCatalogueOptions } from '../../src/main/tools/capability-catalogue';
import type { BrowserControlPort } from '../../src/main/tools/browser-control-port';
import { registerCockpitCapabilities } from '../../src/main/tools/cockpit-capabilities';
import { CockpitPort, type CockpitHostPort, type CockpitQaState, type CockpitThemeQaOptions } from '../../src/main/tools/cockpit-port';
import {
  checklistScope,
  workspaceTag,
  type ThemeChecklistItem,
} from '../../src/shared/theme-checklist';
import {
  getScope,
  mutateScope,
  setScopeCas,
  isProvisionalChecklistScope,
} from '../../src/main/qa/theme-checklist-store';
import {
  CapabilityError,
  type CapabilityRequestContext,
  type BrowserTarget,
} from '../../src/shared/control-plane-contracts';

const defaultOptions = {
  runtime: { mode: 'standalone' as const, lifecycle: 'active' as const },
  projectId: 'project-12345678901234567890',
  workspaceId: 'workspace-12345678901234567890',
  runtimeId: 'binding-12345678901234567890',
};

const makeBoundContext = (): CapabilityRequestContext => {
  const target: BrowserTarget = {
    projectId: defaultOptions.projectId,
    workspaceId: defaultOptions.workspaceId,
    runtimeId: defaultOptions.runtimeId,
    tabId: 'tab-1',
    browserEpoch: 1,
    documentGeneration: 1,
  };
  return {
    lease: {
      token: 'token-1',
      runtimeId: target.runtimeId,
      expiresAt: Date.now() + 60000,
      projectId: target.projectId,
      workspaceId: target.workspaceId,
      protocolVersion: 1,
      hostEpoch: 1,
      ownerPid: process.pid,
      issuedAt: Date.now(),
    },
    leaseToken: 'token-1',
    projectId: target.projectId,
    workspaceId: target.workspaceId,
    browserTarget: target,
    grant: 'read',
  };
};

const writeContext = (): CapabilityRequestContext => ({
  ...makeBoundContext(),
  grant: 'write',
});

function makeCockpitTestFixture(options?: { isLegacy?: boolean; isHaravan?: boolean }) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'antifan-cockpit-test-'));
  const configDir = path.join(root, 'config');
  fs.mkdirSync(configDir, { recursive: true });

  if (options?.isHaravan !== false) {
    if (options?.isLegacy) {
      fs.writeFileSync(path.join(configDir, 'settings.html'), '<fieldset><legend>General</legend><input type="text" name="site_title" /></fieldset>', 'utf8');
      fs.writeFileSync(path.join(root, '.haravan-cli_local.json'), JSON.stringify({ org_id: '123', theme_id: '456' }), 'utf8');
    } else {
      fs.writeFileSync(
        path.join(configDir, 'settings_schema.json'),
        JSON.stringify([{ name: 'General', settings: [{ type: 'text', id: 'site_title', label: 'Title' }] }]),
        'utf8'
      );
      fs.writeFileSync(path.join(root, '.haravan-cli_local.json'), JSON.stringify({ org_id: '123', theme_id: '456' }), 'utf8');
    }
  }

  const navigations: Array<{ tabId: string; url: string }> = [];
  const qaCalls: Array<{ tabId: string; workspaceRoot: string | undefined }> = [];
  const qaState: CockpitQaState = { status: 'pass', issueCount: 0, updatedAt: 1 };
  const host: CockpitHostPort = {
    hasTab: (tabId) => tabId === 'tab-1',
    getTabUrl: (tabId) => (tabId === 'tab-1' ? 'https://shop.example.com/' : ''),
    resolveTabWorkspaceRoot: () => root,
    navigateAndWait: async (tabId, url) => {
      navigations.push({ tabId, url });
      return true;
    },
    runThemeQa: async (tabId, qaOpts) => {
      qaCalls.push({ tabId, workspaceRoot: qaOpts?.workspaceRoot });
      return { ok: true, report: { summary: { passed: true } } };
    },
    getThemeQaState: () => qaState,
    checklistLoad: (_tabId, input) => {
      const snap = getScope(input.workspaceRoot, input.scope);
      return {
        scope: input.scope,
        workspaceRoot: input.workspaceRoot,
        items: snap.items,
        updatedAt: snap.updatedAt,
        existed: snap.existed,
        migrated: snap.migrated,
        isProvisional: isProvisionalChecklistScope(input.scope, input.workspaceRoot),
      };
    },
    checklistMutate: (_tabId, input) => ({
      ...mutateScope(input.workspaceRoot, input.scope, input.op),
      scope: input.scope,
      workspaceRoot: input.workspaceRoot,
      isProvisional: isProvisionalChecklistScope(input.scope, input.workspaceRoot),
    }),
    checklistSave: (_tabId, input) => {
      const result = setScopeCas(input.workspaceRoot, input.scope, input.items, input.baseUpdatedAt);
      return {
        ok: !result.conflict,
        scope: input.scope,
        workspaceRoot: input.workspaceRoot,
        items: result.items,
        updatedAt: result.updatedAt,
        conflict: result.conflict,
        isProvisional: isProvisionalChecklistScope(input.scope, input.workspaceRoot),
      };
    },
  };

  const catalogue = new CapabilityCatalogue(defaultOptions);
  const cockpit = new CockpitPort(host);
  const browserStub = {
    getLiveTabUrl: async () => 'https://shop.example.com/',
  } as unknown as BrowserControlPort;

  registerCockpitCapabilities(catalogue, cockpit, browserStub);
  const scope = checklistScope('https://shop.example.com', workspaceTag(root));

  return { catalogue, cockpit, root, scope, navigations, qaCalls };
}

describe('cockpit-capabilities (Phase 5)', () => {
  it('Task 5.2: adapts qag-04 description for legacy Haravan workspaces', async () => {
    const { catalogue, root } = makeCockpitTestFixture({ isLegacy: true });
    try {
      const result = await catalogue.dispatch('theme.cockpit_list', {}, makeBoundContext()) as { items: ThemeChecklistItem[] };
      const qag04 = result.items.find((it) => it.id === 'qag-04');
      assert.ok(qag04, 'qag-04 must be present in items');
      assert.strictEqual(
        qag04.desc,
        'Validate settings.html controls, duplicate names, and upload asset_url references via theme.settings_check.'
      );
      assert.strictEqual(qag04.action, 'theme.settings_check');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('Task 5.2: adapts qag-04 description for F1GENZ workspaces', async () => {
    const { catalogue, root } = makeCockpitTestFixture({ isLegacy: false });
    try {
      const result = await catalogue.dispatch('theme.cockpit_list', {}, makeBoundContext()) as { items: ThemeChecklistItem[] };
      const qag04 = result.items.find((it) => it.id === 'qag-04');
      assert.ok(qag04, 'qag-04 must be present in items');
      assert.strictEqual(
        qag04.desc,
        'Validate settings_schema.json definitions and Liquid bindings via theme.settings_check.'
      );
      assert.strictEqual(qag04.action, 'theme.settings_check');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('Task 5.2: preserves non-blocking ticking on qag-04 even when settings check is not executed', async () => {
    const { catalogue, root } = makeCockpitTestFixture({ isLegacy: true });
    try {
      const marked = await catalogue.dispatch(
        'theme.cockpit_mark',
        { itemId: 'qag-04', done: true, note: 'manually confirmed' },
        writeContext()
      ) as { item: ThemeChecklistItem };
      assert.strictEqual(marked.item.id, 'qag-04');
      assert.strictEqual(marked.item.done, true);
      assert.strictEqual(marked.item.note, 'manually confirmed');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('Task 5.3: surfaces settingsSummary in theme.cockpit_findings and theme.cockpit_report', async () => {
    const { catalogue, root } = makeCockpitTestFixture({ isLegacy: true });
    try {
      const findingsRes = await catalogue.dispatch('theme.cockpit_findings', {}, makeBoundContext()) as {
        settingsSummary?: { ok: boolean; newFailures: number; legacyDebt: number };
      };
      assert.ok(findingsRes.settingsSummary, 'findings must contain settingsSummary for Haravan workspace');
      assert.strictEqual(typeof findingsRes.settingsSummary.ok, 'boolean');
      assert.strictEqual(typeof findingsRes.settingsSummary.newFailures, 'number');
      assert.strictEqual(typeof findingsRes.settingsSummary.legacyDebt, 'number');

      const reportRes = await catalogue.dispatch('theme.cockpit_report', {}, makeBoundContext()) as {
        markdown: string;
        settingsSummary?: { ok: boolean; newFailures: number; legacyDebt: number };
      };
      assert.ok(reportRes.settingsSummary, 'report must contain settingsSummary for Haravan workspace');
      assert.ok(reportRes.markdown.includes('Theme Settings'), 'markdown report should mention Theme Settings status');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('Task 5.3 (Kongming Contract): two consecutive calls with no file edits produce identical settingsSummary without baseline drift', async () => {
    const { catalogue, root } = makeCockpitTestFixture({ isLegacy: true });
    try {
      const call1 = await catalogue.dispatch('theme.cockpit_findings', {}, makeBoundContext()) as {
        settingsSummary?: { ok: boolean; newFailures: number; legacyDebt: number };
      };
      const call2 = await catalogue.dispatch('theme.cockpit_findings', {}, makeBoundContext()) as {
        settingsSummary?: { ok: boolean; newFailures: number; legacyDebt: number };
      };

      assert.deepStrictEqual(call1.settingsSummary, call2.settingsSummary, 'consecutive calls must yield identical settingsSummary without in-memory drift');

      const report1 = await catalogue.dispatch('theme.cockpit_report', {}, makeBoundContext()) as {
        settingsSummary?: { ok: boolean; newFailures: number; legacyDebt: number };
      };
      const report2 = await catalogue.dispatch('theme.cockpit_report', {}, makeBoundContext()) as {
        settingsSummary?: { ok: boolean; newFailures: number; legacyDebt: number };
      };

      assert.deepStrictEqual(report1.settingsSummary, report2.settingsSummary, 'consecutive report calls must yield identical settingsSummary');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('theme.cockpit_scan scans explicit same-origin PDP path on product page and refuses cross-origin, non-PDP, or omitted url off-PDP', async () => {
    const { catalogue, root, navigations, qaCalls } = makeCockpitTestFixture({ isLegacy: false });
    try {
      // Omitted url while bound tab is on / -> ROUTE_UNRESOLVED
      await assert.rejects(
        () => catalogue.dispatch('theme.cockpit_scan', { page: 'product' }, makeBoundContext()),
        (err: unknown) => err instanceof CapabilityError && err.code === 'ROUTE_UNRESOLVED'
      );
      assert.strictEqual(navigations.length, 0);

      // Cross-origin url -> ROUTE_UNRESOLVED
      await assert.rejects(
        () =>
          catalogue.dispatch(
            'theme.cockpit_scan',
            { page: 'product', url: 'https://evil.example.com/products/demo-item' },
            makeBoundContext()
          ),
        (err: unknown) => err instanceof CapabilityError && err.code === 'ROUTE_UNRESOLVED'
      );
      assert.strictEqual(navigations.length, 0);

      // Non-PDP path on product page -> ROUTE_UNRESOLVED
      await assert.rejects(
        () =>
          catalogue.dispatch(
            'theme.cockpit_scan',
            { page: 'product', url: '/collections/all' },
            makeBoundContext()
          ),
        (err: unknown) => err instanceof CapabilityError && err.code === 'ROUTE_UNRESOLVED'
      );
      assert.strictEqual(navigations.length, 0);

      // Explicit same-origin PDP path -> navigates and runs QA
      const scanRes = (await catalogue.dispatch(
        'theme.cockpit_scan',
        { page: 'product', url: '/products/demo-item' },
        makeBoundContext()
      )) as { ok: boolean };
      assert.strictEqual(scanRes.ok, true);
      assert.deepStrictEqual(navigations, [
        { tabId: 'tab-1', url: 'https://shop.example.com/products/demo-item' },
      ]);
      assert.strictEqual(qaCalls.length, 1);
      assert.strictEqual(qaCalls[0]?.tabId, 'tab-1');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('theme.cockpit_scan honors explicit url when page is omitted and refuses cross-origin url', async () => {
    const { catalogue, root, navigations, qaCalls } = makeCockpitTestFixture({ isLegacy: false });
    try {
      await assert.rejects(
        () =>
          catalogue.dispatch(
            'theme.cockpit_scan',
            { url: 'https://evil.example.com/products/demo-item' },
            makeBoundContext()
          ),
        (err: unknown) => err instanceof CapabilityError && err.code === 'ROUTE_UNRESOLVED'
      );
      assert.strictEqual(navigations.length, 0);
      assert.strictEqual(qaCalls.length, 0);

      const pdpRes = (await catalogue.dispatch(
        'theme.cockpit_scan',
        { url: '/products/demo-item' },
        makeBoundContext()
      )) as { ok: boolean };
      assert.strictEqual(pdpRes.ok, true);
      assert.deepStrictEqual(navigations, [
        { tabId: 'tab-1', url: 'https://shop.example.com/products/demo-item' },
      ]);
      assert.strictEqual(qaCalls.length, 1);

      const customRes = (await catalogue.dispatch(
        'theme.cockpit_scan',
        { url: '/pages/custom-landing' },
        makeBoundContext()
      )) as { ok: boolean };
      assert.strictEqual(customRes.ok, true);
      assert.deepStrictEqual(navigations, [
        { tabId: 'tab-1', url: 'https://shop.example.com/products/demo-item' },
        { tabId: 'tab-1', url: 'https://shop.example.com/pages/custom-landing' },
      ]);
      assert.strictEqual(qaCalls.length, 2);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

interface ScanFixtureOptions {
  themeMarkers?: boolean;
  report?: unknown;
  duringQa?: (root: string, scope: string) => void;
  liveUrl?: string;
  evalResult?: (expression: string) => unknown;
}

function makeScanFixture(options: ScanFixtureOptions = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'antifan-cockpit-scan-'));
  if (options.themeMarkers !== false) {
    fs.mkdirSync(path.join(root, 'config'), { recursive: true });
    fs.writeFileSync(path.join(root, 'config', 'settings_schema.json'), '[]', 'utf8');
  } else {
    fs.writeFileSync(path.join(root, 'notes.txt'), 'plain folder', 'utf8');
  }
  const scope = checklistScope('https://shop.example.com', workspaceTag(root));
  const navigations: Array<{ tabId: string; url: string }> = [];
  const qaCalls: Array<{ tabId: string; options: CockpitThemeQaOptions | undefined }> = [];
  const host: CockpitHostPort = {
    hasTab: (tabId) => tabId === 'tab-1',
    getTabUrl: (tabId) => (tabId === 'tab-1' ? 'https://shop.example.com/' : ''),
    resolveTabWorkspaceRoot: () => root,
    navigateAndWait: async (tabId, url) => {
      navigations.push({ tabId, url });
      return true;
    },
    runThemeQa: async (tabId, qaOptions) => {
      qaCalls.push({ tabId, options: qaOptions });
      options.duringQa?.(root, scope);
      return { ok: true, report: options.report ?? { summary: { passed: true } } };
    },
    getThemeQaState: () => ({ status: 'pass', issueCount: 0, updatedAt: 1 }),
    checklistLoad: (_tabId, input) => {
      const snap = getScope(input.workspaceRoot, input.scope);
      return {
        scope: input.scope,
        workspaceRoot: input.workspaceRoot,
        items: snap.items,
        updatedAt: snap.updatedAt,
        existed: snap.existed,
        migrated: snap.migrated,
        isProvisional: isProvisionalChecklistScope(input.scope, input.workspaceRoot),
      };
    },
    checklistMutate: (_tabId, input) => ({
      ...mutateScope(input.workspaceRoot, input.scope, input.op),
      scope: input.scope,
      workspaceRoot: input.workspaceRoot,
      isProvisional: isProvisionalChecklistScope(input.scope, input.workspaceRoot),
    }),
    checklistSave: (_tabId, input) => {
      const result = setScopeCas(input.workspaceRoot, input.scope, input.items, input.baseUpdatedAt);
      return {
        ok: !result.conflict,
        scope: input.scope,
        workspaceRoot: input.workspaceRoot,
        items: result.items,
        updatedAt: result.updatedAt,
        conflict: result.conflict,
        isProvisional: isProvisionalChecklistScope(input.scope, input.workspaceRoot),
      };
    },
  };
  const browserStub = {
    getLiveTabUrl: async () => options.liveUrl ?? 'https://shop.example.com/',
    eval: async (_target: BrowserTarget, expression: string) => options.evalResult?.(expression),
  } as unknown as BrowserControlPort;
  const catalogue = new CapabilityCatalogue(defaultOptions);
  registerCockpitCapabilities(catalogue, new CockpitPort(host), browserStub);
  return { catalogue, root, scope, navigations, qaCalls };
}

const WIDTHS = ['320', '375', '768', '1024', '1440'];

function responsiveReport(overflowing: string[]): unknown {
  return {
    summary: { passed: true },
    findings: { responsive: Object.fromEntries(WIDTHS.map((w) => [w, { documentOverflow: overflowing.includes(w) }])) },
  };
}

function itemOf(root: string, scope: string, itemId: string): ThemeChecklistItem | undefined {
  return getScope(root, scope).items.find((item) => item.id === itemId);
}

interface ScanResult {
  ok: boolean;
  workspaceRoot?: string;
  probes?: Record<string, unknown>;
  checklist?: { applied: Array<{ itemId: string; done: boolean }>; skipped: Array<{ itemId: string; reason: string }> };
}

const FULL_THRESHOLDS = { minTextPx: 12, minTapHitPx: 24 };

describe('theme.cockpit_scan grading inputs, root guard and checklist ticks', () => {
  it('forwards profile, thresholds, viewports, multiBreakpoint and waivers to the QA run untouched', async () => {
    const { catalogue, root, qaCalls } = makeScanFixture();
    try {
      const viewports = { desktop: { mismatchPercent: 0.2, passed: true }, mobile: { mismatchPercent: 0.4, passed: true } };
      const waivers = [{ rule: 'tap-target-hit-area', reason: 'third-party chat bubble' }];
      await catalogue.dispatch(
        'theme.cockpit_scan',
        { profile: 'audit', thresholds: FULL_THRESHOLDS, viewports, multiBreakpoint: false, waivers },
        makeBoundContext()
      );
      assert.strictEqual(qaCalls.length, 1);
      assert.deepStrictEqual(qaCalls[0]?.options, {
        profile: 'audit',
        thresholds: FULL_THRESHOLDS,
        viewports,
        multiBreakpoint: false,
        waivers,
        workspaceRoot: root,
      });
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('sends only the workspace root when no grading input is supplied', async () => {
    const { catalogue, root, qaCalls } = makeScanFixture();
    try {
      await catalogue.dispatch('theme.cockpit_scan', {}, makeBoundContext());
      assert.deepStrictEqual(qaCalls[0]?.options, { workspaceRoot: root });
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('refuses malformed grading inputs before navigating or scanning', async () => {
    const { catalogue, root, navigations, qaCalls } = makeScanFixture();
    try {
      const invalid = (err: unknown): boolean => err instanceof CapabilityError && err.code === 'INVALID_ARGUMENT';
      await assert.rejects(() => catalogue.dispatch('theme.cockpit_scan', { url: '/products/a', profile: 'fast' }, makeBoundContext()), invalid);
      await assert.rejects(() => catalogue.dispatch('theme.cockpit_scan', { url: '/products/a', thresholds: { minTextPx: 12 } }, makeBoundContext()), invalid);
      await assert.rejects(() => catalogue.dispatch('theme.cockpit_scan', { url: '/products/a', viewports: { watch: { mismatchPercent: 0, passed: true } } }, makeBoundContext()), invalid);
      await assert.rejects(() => catalogue.dispatch('theme.cockpit_scan', { url: '/products/a', viewports: { desktop: { passed: true } } }, makeBoundContext()), invalid);
      await assert.rejects(() => catalogue.dispatch('theme.cockpit_scan', { url: '/products/a', multiBreakpoint: 'yes' }, makeBoundContext()), invalid);
      await assert.rejects(() => catalogue.dispatch('theme.cockpit_scan', { url: '/products/a', pick: 'cheapest' }, makeBoundContext()), invalid);
      await assert.rejects(() => catalogue.dispatch('theme.cockpit_scan', { url: '/products/a', waivers: [{ rule: 'min-font-size' }] }, makeBoundContext()), invalid);
      assert.strictEqual(navigations.length, 0);
      assert.strictEqual(qaCalls.length, 0);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('refuses a bound root without theme markers before navigating, and accepts it with allowNonTheme', async () => {
    const { catalogue, root, navigations, qaCalls } = makeScanFixture({ themeMarkers: false });
    try {
      await assert.rejects(
        () => catalogue.dispatch('theme.cockpit_scan', { url: '/products/demo-item' }, makeBoundContext()),
        (err: unknown) => err instanceof CapabilityError && err.code === 'WORKSPACE_NOT_THEME'
      );
      assert.strictEqual(navigations.length, 0);
      assert.strictEqual(qaCalls.length, 0);

      const allowed = (await catalogue.dispatch(
        'theme.cockpit_scan',
        { url: '/products/demo-item', allowNonTheme: true },
        makeBoundContext()
      )) as ScanResult;
      assert.strictEqual(allowed.ok, true);
      assert.strictEqual(qaCalls.length, 1);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('confines a workspaceRoot outside the bound workspace to the bound root', async () => {
    const { catalogue, root, qaCalls } = makeScanFixture();
    const other = fs.mkdtempSync(path.join(os.tmpdir(), 'antifan-cockpit-other-'));
    try {
      const result = (await catalogue.dispatch('theme.cockpit_scan', { url: '/products/demo-item', workspaceRoot: other }, makeBoundContext())) as ScanResult;
      assert.strictEqual(result.workspaceRoot, root);
      assert.strictEqual(qaCalls.length, 1);
      assert.strictEqual(qaCalls[0]?.options?.workspaceRoot, root);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
      fs.rmSync(other, { recursive: true, force: true });
    }
  });

  it('ticks the items a clean scan measured and records the note prefix', async () => {
    const { catalogue, root, scope } = makeScanFixture({ report: responsiveReport([]) });
    try {
      assert.strictEqual(itemOf(root, scope, 'qag-07')?.done, false);
      const result = (await catalogue.dispatch('theme.cockpit_scan', {}, makeBoundContext())) as ScanResult;
      assert.deepStrictEqual(result.checklist?.applied, [{ itemId: 'qag-07', done: true }]);
      const item = itemOf(root, scope, 'qag-07');
      assert.strictEqual(item?.done, true);
      assert.ok(item?.note?.startsWith('[scan]'), 'the tick carries the scan note prefix');
      assert.ok(result.probes && 'page_structure' in result.probes && 'menu_depth' in result.probes, 'home runs page_structure and menu_depth');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('un-ticks an item a failing scan measured, naming the overflowing widths', async () => {
    const { catalogue, root, scope } = makeScanFixture({ report: responsiveReport(['320']) });
    try {
      mutateScope(root, scope, { op: 'mark', itemId: 'qag-07', done: true });
      const result = (await catalogue.dispatch('theme.cockpit_scan', {}, makeBoundContext())) as ScanResult;
      assert.deepStrictEqual(result.checklist?.applied, [{ itemId: 'qag-07', done: false }]);
      const item = itemOf(root, scope, 'qag-07');
      assert.strictEqual(item?.done, false);
      assert.match(item?.note ?? '', /320px/);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('leaves an item alone when the user changed it while the scan ran', async () => {
    const { catalogue, root, scope } = makeScanFixture({
      report: responsiveReport(['320']),
      duringQa: (scanRoot, scanScope) => {
        mutateScope(scanRoot, scanScope, { op: 'mark', itemId: 'qag-07', done: true, note: 'đã kiểm tra tay' });
      },
    });
    try {
      const result = (await catalogue.dispatch('theme.cockpit_scan', {}, makeBoundContext())) as ScanResult;
      assert.deepStrictEqual(result.checklist?.applied, []);
      assert.deepStrictEqual(result.checklist?.skipped.map((s) => s.itemId), ['qag-07']);
      assert.match(result.checklist?.skipped[0]?.reason ?? '', /changed by the user/);
      const item = itemOf(root, scope, 'qag-07');
      assert.strictEqual(item?.done, true);
      assert.strictEqual(item?.note, 'đã kiểm tra tay');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('writes no tick when the scan did not measure anything', async () => {
    const { catalogue, root, scope } = makeScanFixture({ report: { summary: { passed: true } } });
    try {
      const result = (await catalogue.dispatch('theme.cockpit_scan', {}, makeBoundContext())) as ScanResult;
      assert.deepStrictEqual(result.checklist?.applied, []);
      assert.strictEqual(itemOf(root, scope, 'qag-07')?.done, false);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('scans the product picked by strategy instead of the first product link', async () => {
    const product = (handle: string, variants: number) => ({
      handle, title: handle, variants, unavailableVariants: 0, available: true, images: 1, variantsWithoutImage: 0,
    });
    const { catalogue, root, navigations } = makeScanFixture({
      evalResult: (expression) => (
        expression.includes('/collections/all')
          ? { ok: true, scannedPages: 1, products: [product('plain', 1), product('many-sizes', 9)] }
          : undefined
      ),
    });
    try {
      await catalogue.dispatch('theme.cockpit_scan', { page: 'product', pick: 'max-variants' }, makeBoundContext());
      assert.deepStrictEqual(navigations, [{ tabId: 'tab-1', url: 'https://shop.example.com/products/many-sizes' }]);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('refuses the scan when the pick strategy matches no product', async () => {
    const { catalogue, root, navigations, qaCalls } = makeScanFixture({
      evalResult: () => ({ ok: false, error: 'no product links found on /collections/all', products: [], scannedPages: 0 }),
    });
    try {
      await assert.rejects(
        () => catalogue.dispatch('theme.cockpit_scan', { page: 'product', pick: 'sold-out' }, makeBoundContext()),
        (err: unknown) => err instanceof CapabilityError && err.code === 'ROUTE_UNRESOLVED' && /pick 'sold-out'/.test(err.message)
      );
      assert.strictEqual(navigations.length, 0);
      assert.strictEqual(qaCalls.length, 0);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
