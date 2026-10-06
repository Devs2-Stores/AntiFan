import { describe, it } from 'node:test';
import * as assert from 'node:assert';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

import { CapabilityCatalogue, type CapabilityCatalogueOptions } from '../../src/main/tools/capability-catalogue';
import type { BrowserControlPort } from '../../src/main/tools/browser-control-port';
import { registerCockpitCapabilities } from '../../src/main/tools/cockpit-capabilities';
import { CockpitPort, type CockpitHostPort, type CockpitQaState } from '../../src/main/tools/cockpit-port';
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
import type {
  CapabilityRequestContext,
  BrowserTarget,
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

  const qaState: CockpitQaState = { status: 'pass', issueCount: 0, updatedAt: 1 };
  const host: CockpitHostPort = {
    hasTab: (tabId) => tabId === 'tab-1',
    getTabUrl: (tabId) => (tabId === 'tab-1' ? 'https://shop.example.com/' : ''),
    resolveTabWorkspaceRoot: () => root,
    navigateAndWait: async () => true,
    runThemeQa: async () => ({ ok: true, report: { summary: { passed: true } } }),
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

  return { catalogue, cockpit, root, scope };
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
});
