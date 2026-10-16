import { describe, it } from 'node:test';
import * as assert from 'node:assert';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { CapabilityCatalogue } from '../../src/main/tools/capability-catalogue';
import type { BrowserControlPort } from '../../src/main/tools/browser-control-port';
import { registerQaProbeCapabilities } from '../../src/main/tools/qa-probe-capabilities';
import {
  CapabilityError,
  type BrowserTarget,
  type CapabilityRequestContext,
} from '../../src/shared/control-plane-contracts';

const defaultOptions = {
  runtime: { mode: 'standalone' as const, lifecycle: 'active' as const },
  projectId: 'project-12345678901234567890',
  workspaceId: 'workspace-12345678901234567890',
  runtimeId: 'binding-12345678901234567890',
};

const PROBE_TOOLS = [
  'anti.qa.variant_image_probe',
  'anti.qa.pdp_contract',
  'anti.qa.menu_depth',
  'anti.qa.page_structure',
  'anti.qa.pick_product',
  'theme.package_check',
] as const;

function makeBoundContext(tabId = 'tab-1'): CapabilityRequestContext {
  const target: BrowserTarget = {
    projectId: defaultOptions.projectId,
    workspaceId: defaultOptions.workspaceId,
    runtimeId: defaultOptions.runtimeId,
    tabId,
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
    grant: 'write',
  };
}

interface EvalCall {
  expression: string;
  tabId: string;
  paneId: string;
}

function makeFixture(options: { evalResult?: unknown; workspaceRoot?: string } = {}) {
  const evalCalls: EvalCall[] = [];
  const browser = {
    eval: async (_target: BrowserTarget, expression: string, tabId: string, paneId: string) => {
      evalCalls.push({ expression, tabId, paneId });
      return options.evalResult;
    },
  } as unknown as BrowserControlPort;
  const catalogue = new CapabilityCatalogue(defaultOptions);
  registerQaProbeCapabilities(catalogue, browser, () => options.workspaceRoot ?? '');
  return { catalogue, evalCalls };
}

function themeRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'antifan-probe-caps-'));
  fs.mkdirSync(path.join(root, 'config'), { recursive: true });
  fs.writeFileSync(path.join(root, 'config', 'settings_schema.json'), '[]', 'utf8');
  return root;
}

interface ObjectSchema {
  properties?: Record<string, unknown>;
  required?: string[];
}

const FIXTURE_THEME = path.resolve(process.cwd(), 'test/fixtures/probes/package-theme');

describe('qa-probe-capabilities registration', () => {
  it('registers exactly the six probe tools', () => {
    const { catalogue } = makeFixture();
    for (const name of PROBE_TOOLS) assert.ok(catalogue.has(name), `${name} is registered`);
    assert.strictEqual(catalogue.listAll().filter((c) => PROBE_TOOLS.includes(c.name as (typeof PROBE_TOOLS)[number])).length, PROBE_TOOLS.length);
  });

  it('declares the click/hover probe as a write and the passive probes as reads', () => {
    const { catalogue } = makeFixture();
    assert.strictEqual(catalogue.get('anti.qa.variant_image_probe')?.risk, 'write');
    assert.strictEqual(catalogue.getPolicy('anti.qa.variant_image_probe')?.effect, 'interactive-effect');
    assert.strictEqual(catalogue.get('anti.qa.menu_depth')?.risk, 'read');
    assert.strictEqual(catalogue.getPolicy('anti.qa.menu_depth')?.effect, 'interactive-effect');
    for (const name of ['anti.qa.pdp_contract', 'anti.qa.page_structure', 'anti.qa.pick_product', 'theme.package_check']) {
      assert.strictEqual(catalogue.get(name)?.risk, 'read', `${name} risk`);
      assert.strictEqual(catalogue.getPolicy(name)?.effect, 'read', `${name} effect`);
    }
  });

  it('binds every probe to a browser tab except the offline package check', () => {
    const { catalogue } = makeFixture();
    for (const name of PROBE_TOOLS) {
      assert.strictEqual(catalogue.get(name)?.requiresBrowserTarget, name !== 'theme.package_check', `${name} browser target`);
    }
  });

  it('advertises the documented input properties', () => {
    const { catalogue } = makeFixture();
    const schemaOf = (name: string): ObjectSchema => {
      const schema = catalogue.get(name)?.inputSchema;
      assert.ok(schema, `${name} advertises an input schema`);
      // Capability schemas are JSON-schema objects by registration contract.
      const objectSchema = schema as ObjectSchema;
      return objectSchema;
    };
    const props = (name: string): string[] => Object.keys(schemaOf(name).properties ?? {});
    assert.deepStrictEqual(props('anti.qa.pick_product').sort(), ['paneId', 'sampleLimit', 'strategy', 'tabId']);
    assert.deepStrictEqual(schemaOf('anti.qa.pick_product').required, ['strategy']);
    assert.ok(props('anti.qa.variant_image_probe').includes('maxValues'));
    assert.ok(props('anti.qa.menu_depth').includes('expectedMaxDepth'));
    assert.ok(props('anti.qa.page_structure').includes('rules'));
    for (const key of ['workspaceRoot', 'zipPath', 'expectedBrand', 'forbiddenWords', 'formBefore', 'formAfter', 'allowNonTheme']) {
      assert.ok(props('theme.package_check').includes(key), `theme.package_check advertises ${key}`);
    }
  });
});

describe('qa-probe-capabilities validation', () => {
  it('refuses an unknown pick_product strategy without touching the page', async () => {
    const { catalogue, evalCalls } = makeFixture();
    await assert.rejects(
      () => catalogue.dispatch('anti.qa.pick_product', { strategy: 'cheapest' }, makeBoundContext()),
      (err: unknown) => err instanceof CapabilityError && err.code === 'INVALID_ARGUMENT' && /strategy must be one of/.test(err.message)
    );
    assert.strictEqual(evalCalls.length, 0);
  });

  it('refuses out-of-range numeric arguments', async () => {
    const { catalogue, evalCalls } = makeFixture();
    const invalid = (err: unknown): boolean => err instanceof CapabilityError && err.code === 'INVALID_ARGUMENT';
    await assert.rejects(() => catalogue.dispatch('anti.qa.variant_image_probe', { maxValues: 0 }, makeBoundContext()), invalid);
    await assert.rejects(() => catalogue.dispatch('anti.qa.variant_image_probe', { maxValues: 41 }, makeBoundContext()), invalid);
    await assert.rejects(() => catalogue.dispatch('anti.qa.menu_depth', { expectedMaxDepth: 9 }, makeBoundContext()), invalid);
    await assert.rejects(() => catalogue.dispatch('anti.qa.menu_depth', { mobile: 'yes' }, makeBoundContext()), invalid);
    await assert.rejects(() => catalogue.dispatch('anti.qa.page_structure', { rules: [] }, makeBoundContext()), invalid);
    await assert.rejects(() => catalogue.dispatch('anti.qa.page_structure', { viewportHeight: 10 }, makeBoundContext()), invalid);
    await assert.rejects(() => catalogue.dispatch('anti.qa.pick_product', { strategy: 'long-title', sampleLimit: 1000 }, makeBoundContext()), invalid);
    assert.strictEqual(evalCalls.length, 0);
  });
});

describe('qa-probe-capabilities execution', () => {
  it('runs pick_product against the bound tab and returns the best handle', async () => {
    const product = (handle: string, variants: number) => ({
      handle, title: handle, variants, unavailableVariants: 0, available: true, images: 1, variantsWithoutImage: 0,
    });
    const { catalogue, evalCalls } = makeFixture({
      evalResult: { ok: true, scannedPages: 1, products: [product('plain', 1), product('many', 9)] },
    });
    const result = (await catalogue.dispatch('anti.qa.pick_product', { strategy: 'max-variants' }, makeBoundContext())) as {
      measured: boolean;
      data: { handles: string[] };
    };
    assert.strictEqual(result.measured, true);
    assert.deepStrictEqual(result.data.handles, ['many', 'plain']);
    assert.strictEqual(evalCalls.length, 1);
    assert.strictEqual(evalCalls[0]?.tabId, 'tab-1');
    assert.strictEqual(evalCalls[0]?.paneId, 'desktop');
    assert.match(evalCalls[0]!.expression, /\/collections\/all/);
  });

  it('reports pdp_contract as unmeasured when the page script returns nothing', async () => {
    const { catalogue } = makeFixture({ evalResult: undefined });
    const result = (await catalogue.dispatch('anti.qa.pdp_contract', {}, makeBoundContext())) as { measured: boolean; passed: boolean | null };
    assert.strictEqual(result.measured, false);
    assert.strictEqual(result.passed, null);
  });

  it('honours an explicit tabId and paneId when binding the probe', async () => {
    const { catalogue, evalCalls } = makeFixture({ evalResult: undefined });
    await catalogue.dispatch('anti.qa.page_structure', { tabId: 'tab-9', paneId: 'mobile' }, makeBoundContext('tab-9'));
    assert.strictEqual(evalCalls[0]?.tabId, 'tab-9');
    assert.strictEqual(evalCalls[0]?.paneId, 'mobile');
  });
});

describe('theme.package_check', () => {
  it('lists the fixture zip and reports its entry count', async () => {
    const { catalogue } = makeFixture({ workspaceRoot: path.resolve(FIXTURE_THEME, '..') });
    // The fixture folder holds the zip next to package-theme/, so it is the bound root here.
    const result = (await catalogue.dispatch(
      'theme.package_check',
      { zipPath: 'package-theme.zip', allowNonTheme: true },
      makeBoundContext()
    )) as { passed: boolean; zipEntries?: number; findings: unknown[] };
    assert.ok((result.zipEntries ?? 0) > 0, 'the zip entries were listed');
    assert.ok(Array.isArray(result.findings));
  });

  it('refuses a zipPath that resolves outside the workspace', async () => {
    const root = themeRoot();
    try {
      const { catalogue } = makeFixture({ workspaceRoot: root });
      await assert.rejects(
        () => catalogue.dispatch('theme.package_check', { zipPath: '../outside.zip' }, makeBoundContext()),
        (err: unknown) => err instanceof CapabilityError && err.code === 'INVALID_ARGUMENT' && /outside the workspace/.test(err.message)
      );
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('refuses a workspaceRoot outside the bound workspace', async () => {
    const root = themeRoot();
    const other = themeRoot();
    try {
      const { catalogue } = makeFixture({ workspaceRoot: root });
      await assert.rejects(
        () => catalogue.dispatch('theme.package_check', { workspaceRoot: other }, makeBoundContext()),
        (err: unknown) => err instanceof CapabilityError && err.code === 'WORKSPACE_MISMATCH'
      );
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
      fs.rmSync(other, { recursive: true, force: true });
    }
  });

  it('refuses a bound root without theme markers unless allowNonTheme is set', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'antifan-probe-caps-plain-'));
    try {
      fs.writeFileSync(path.join(root, 'notes.txt'), 'plain', 'utf8');
      const { catalogue } = makeFixture({ workspaceRoot: root });
      await assert.rejects(
        () => catalogue.dispatch('theme.package_check', {}, makeBoundContext()),
        (err: unknown) => err instanceof CapabilityError && err.code === 'WORKSPACE_NOT_THEME'
      );
      const allowed = (await catalogue.dispatch('theme.package_check', { allowNonTheme: true }, makeBoundContext())) as { findings: unknown[] };
      assert.ok(Array.isArray(allowed.findings));
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('refuses when no workspace is bound and none is supplied', async () => {
    const { catalogue } = makeFixture({ workspaceRoot: '' });
    await assert.rejects(
      () => catalogue.dispatch('theme.package_check', {}, makeBoundContext()),
      (err: unknown) => err instanceof CapabilityError && err.code === 'WORKSPACE_UNBOUND'
    );
  });

  it('rejects malformed forbiddenWords and form values', async () => {
    const root = themeRoot();
    try {
      const { catalogue } = makeFixture({ workspaceRoot: root });
      const invalid = (err: unknown): boolean => err instanceof CapabilityError && err.code === 'INVALID_ARGUMENT';
      await assert.rejects(() => catalogue.dispatch('theme.package_check', { forbiddenWords: [''] }, makeBoundContext()), invalid);
      await assert.rejects(() => catalogue.dispatch('theme.package_check', { formBefore: { price: 5 } }, makeBoundContext()), invalid);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
