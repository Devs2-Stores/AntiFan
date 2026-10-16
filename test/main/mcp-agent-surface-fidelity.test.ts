// Regression pins for agent-facing MCP surface defects found by a live session against a real
// storefront: a scoped snapshot that returned the whole page, tab rows inflated by inline
// favicons, a source resolver that ignored snapshot refs, before/after style probes that
// repeated the full custom-property map, and proxy schemas that hid the real argument shapes.
import { describe, it } from 'node:test';
import * as assert from 'node:assert';
import * as path from 'node:path';
import { createRequire } from 'node:module';
import { CapabilityCatalogue } from '../../src/main/tools/capability-catalogue';
import { registerBrowserCapabilities } from '../../src/main/tools/browser-capabilities';
import { BrowserControlPort, BrowserHostPort, compactStylePairForResponse } from '../../src/main/tools/browser-control-port';
import { issueRuntimeLease, makeControlPlaneId, BrowserTarget } from '../../src/shared/control-plane-contracts';

const requireFromHere = createRequire(__filename);

function makeScope() {
  const projectId = makeControlPlaneId('project');
  const workspaceId = makeControlPlaneId('workspace');
  const lease = issueRuntimeLease(projectId, workspaceId, 30_000, 1);
  const target: BrowserTarget = {
    tabId: 'tab-1',
    browserEpoch: 1,
    documentGeneration: 1,
    runtimeId: lease.runtimeId,
    projectId,
    workspaceId,
  };
  const catalogue = new CapabilityCatalogue({
    runtime: { mode: 'standalone', lifecycle: 'active' },
    projectId,
    workspaceId,
    runtimeId: lease.runtimeId,
    hostEpoch: 1,
    resolveTabId: (id) => (id === 'tab-1' ? 'tab-1' : undefined),
    isTabAllowed: () => true,
    getDocumentGeneration: () => 1,
  });
  const dispatchContext = { lease, leaseToken: lease.token, projectId, workspaceId, browserTarget: target };
  return { projectId, workspaceId, lease, target, catalogue, dispatchContext };
}

function baseHost(overrides: Partial<BrowserHostPort>): BrowserHostPort {
  return {
    navigate: () => true,
    reload: () => true,
    getDom: async () => '<html></html>',
    captureScreenshot: async () => 'data:image/png;base64,mock',
    getTabList: () => [{ id: 'tab-1' }],
    evalJs: async () => null,
    ...overrides,
  } as BrowserHostPort;
}

function errorCode(err: unknown): string | undefined {
  if (err && typeof err === 'object' && 'code' in err) return String((err as { code: unknown }).code);
  return undefined;
}

describe('trace style pair response shaping', () => {
  it('reports an unchanged custom-property map once and an empty delta after', () => {
    const vars = { '--pc-primary': '#e10600', '--pc-gutter': '16px' };
    const out = compactStylePairForResponse(
      { typography: { color: 'black' }, cssVariables: { ...vars } },
      { typography: { color: 'red' }, cssVariables: { ...vars } }
    );
    assert.deepStrictEqual(out.beforeStyles.cssVariables, vars);
    assert.ok(!('cssVariables' in out.afterStyles), 'after side must not repeat the full map');
    assert.deepStrictEqual(out.afterStyles.cssVariablesDelta, {});
    assert.deepStrictEqual((out.afterStyles.typography as { color: string }).color, 'red');
  });

  it('keeps every changed, added and removed custom property in the delta', () => {
    const out = compactStylePairForResponse(
      { cssVariables: { '--a': '1', '--b': '2', '--gone': 'x' } },
      { cssVariables: { '--a': '1', '--b': '3', '--new': 'y' } }
    );
    assert.deepStrictEqual(out.afterStyles.cssVariablesDelta, { '--b': '3', '--gone': null, '--new': 'y' });
  });

  it('leaves probes without custom-property maps untouched', () => {
    const before = { typography: { color: 'black' } };
    const after = { typography: { color: 'red' } };
    const out = compactStylePairForResponse(before, after);
    assert.strictEqual(out.beforeStyles, before);
    assert.strictEqual(out.afterStyles, after);
  });
});

describe('agent tab rows', () => {
  it('drops inline data: favicons but keeps remote favicon URLs', () => {
    const { target } = makeScope();
    const host = baseHost({
      getTabList: () => [
        { id: 'tab-1', url: 'https://a.example/', favicon: 'data:image/png;base64,' + 'A'.repeat(4000) },
        { id: 'tab-2', url: 'https://b.example/', favicon: 'https://b.example/favicon.ico' },
      ],
    });
    const port = new BrowserControlPort(host);
    const rows = port.listTabs({ target, scope: 'global' }) as Array<Record<string, unknown>>;
    const first = rows.find((row) => row.id === 'tab-1');
    const second = rows.find((row) => row.id === 'tab-2');
    assert.ok(first && second);
    assert.ok(!('favicon' in first), 'inline favicon pixels must not reach the agent row');
    assert.strictEqual(second.favicon, 'https://b.example/favicon.ico');
    assert.strictEqual(first.isBoundTab, true);
  });
});

describe('anti.theme.resolve_element element resolution', () => {
  const fixtureThemeRoot = path.resolve(process.cwd(), 'test/fixtures/golden-workflow/product-card/theme');

  function setup(evalResult: unknown) {
    const scope = makeScope();
    const scripts: string[] = [];
    const host = baseHost({
      evalJs: async (script: string) => {
        scripts.push(script);
        return evalResult;
      },
    });
    registerBrowserCapabilities(scope.catalogue, new BrowserControlPort(host), undefined, () => fixtureThemeRoot);
    return { ...scope, scripts };
  }

  it('resolves a snapshot ref through its data-antifan-ref stamp', async () => {
    const { catalogue, dispatchContext, scripts } = setup({ classes: ['product-card'], attributes: {}, tagName: 'article' });
    await catalogue.dispatch('anti.theme.resolve_element', { ref: 'e7', workspaceRoot: fixtureThemeRoot, tabId: 'tab-1' }, dispatchContext);
    const script = scripts.find((s) => s.includes('data-antifan-ref'));
    assert.ok(script, 'the inspect script must look the ref up');
    assert.ok(script.includes('"@e7"'), 'a bare ref is normalized to its @-prefixed stamp');
  });

  it('refuses a ref that matches no live element instead of mapping empty evidence', async () => {
    const { catalogue, dispatchContext } = setup(null);
    await assert.rejects(
      catalogue.dispatch('anti.theme.resolve_element', { ref: '@e99', workspaceRoot: fixtureThemeRoot, tabId: 'tab-1' }, dispatchContext),
      (err: unknown) => errorCode(err) === 'REF_NOT_FOUND'
    );
  });

  it('refuses a selector that matches nothing', async () => {
    const { catalogue, dispatchContext } = setup(null);
    await assert.rejects(
      catalogue.dispatch('anti.theme.resolve_element', { selector: '.nope', workspaceRoot: fixtureThemeRoot, tabId: 'tab-1' }, dispatchContext),
      (err: unknown) => errorCode(err) === 'SELECTOR_NOT_FOUND'
    );
  });

  it('requires a selector or a ref', async () => {
    const { catalogue, dispatchContext } = setup({ classes: [], attributes: {}, tagName: 'div' });
    await assert.rejects(
      catalogue.dispatch('anti.theme.resolve_element', { workspaceRoot: fixtureThemeRoot, tabId: 'tab-1' }, dispatchContext),
      (err: unknown) => errorCode(err) === 'INVALID_ARGUMENT'
    );
  });

  it('walks the registry descriptor of a snapshot ref (refs are not stamped on the DOM)', async () => {
    const scope = makeScope();
    const scripts: string[] = [];
    const asked: string[] = [];
    const host = baseHost({
      evalJs: async (script: string) => { scripts.push(script); return { classes: ['pc-hd__tool'], attributes: {}, tagName: 'button' }; },
      resolveSemanticRefDescriptor: (tabId, _pane, ref) => {
        asked.push(`${tabId} ${ref}`);
        return { path: [{ kind: 'dom', index: 0 }, { kind: 'dom', index: 1 }, { kind: 'dom', index: 3 }], fingerprint: { tag: 'button' } };
      },
    });
    registerBrowserCapabilities(scope.catalogue, new BrowserControlPort(host), undefined, () => fixtureThemeRoot);
    await scope.catalogue.dispatch('anti.theme.resolve_element', { ref: 'e4', workspaceRoot: fixtureThemeRoot, tabId: 'tab-1' }, scope.dispatchContext);
    assert.deepStrictEqual(asked, ['tab-1 @e4']);
    const script = scripts.find((s) => s.includes('const desc = '));
    assert.ok(script, 'the inspect script must carry the descriptor');
    assert.ok(script.includes('"kind":"dom","index":3') && script.includes('"tag":"button"'), 'path and tag are passed to the page');
    assert.ok(!script.includes('const desc = null'), 'the registry path is used, not the stamped-ref fallback');
  });

  it('reports a stale registry ref as stale instead of mapping something else', async () => {
    const scope = makeScope();
    const host = baseHost({
      evalJs: async () => ({ classes: [], attributes: {}, tagName: 'div' }),
      resolveSemanticRefDescriptor: () => { throw Object.assign(new Error('Semantic ref "@e2" is stale'), { code: 'REF_STALE' }); },
    });
    registerBrowserCapabilities(scope.catalogue, new BrowserControlPort(host), undefined, () => fixtureThemeRoot);
    await assert.rejects(
      scope.catalogue.dispatch('anti.theme.resolve_element', { ref: '@e2', workspaceRoot: fixtureThemeRoot, tabId: 'tab-1' }, scope.dispatchContext),
      (err: unknown) => errorCode(err) === 'REF_STALE'
    );
  });

  it('refuses a ref that is not a snapshot ref instead of splicing it into a selector', async () => {
    const { catalogue, dispatchContext, scripts } = setup({ classes: [], attributes: {}, tagName: 'body' });
    await assert.rejects(
      catalogue.dispatch('anti.theme.resolve_element', { ref: '@e1"], body, [x="', workspaceRoot: fixtureThemeRoot, tabId: 'tab-1' }, dispatchContext),
      (err: unknown) => errorCode(err) === 'INVALID_ARGUMENT'
    );
    assert.ok(!scripts.some((s) => s.includes('data-antifan-ref')), 'no page lookup ran');
  });
});

describe('anti.inspect.layout visibility facts', () => {
  it('asks the page for opacity, visibility, transform and a rendered/in-viewport verdict', async () => {
    const { target } = makeScope();
    let captured = '';
    const host = baseHost({
      evalJs: async (script: string) => {
        captured = script;
        return { ok: true, viewport: { width: 1, height: 1, scrollX: 0, scrollY: 0 }, selectors: {} };
      },
    });
    await new BrowserControlPort(host).inspectLayout(target, { selector: 'aside.drawer' });
    for (const token of ['visibility: cs.visibility', 'opacity: cs.opacity', 'pointerEvents: cs.pointerEvents', 'transform:', 'visibleState: visibleStateOf(node, r)', 'checkVisibility', 'effectiveOpacity']) {
      assert.ok(captured.includes(token), `inspect.layout script must report ${token}`);
    }
  });
});

describe('anti.qa.visual_quality', () => {
  it('runs the visual-quality scanner on the bound tab with the caller options and normalizes the result', async () => {
    const scope = makeScope();
    let script = '';
    const host = baseHost({
      evalJs: async (s: string) => {
        script = s;
        return {
          measured: true,
          viewport: { width: 375, height: 667 },
          mobile: true,
          findings: [{ ruleId: 'tap-target-tiny', severity: 'warning', selector: 'button.x', details: '16x16' }],
          stats: { textElementsChecked: 1, contrastIndeterminate: 0, controlsChecked: 1, floatingWidgets: 0, scrollPositions: 1, durationMs: 1, truncated: false, truncatedReasons: [] },
        };
      },
    });
    registerBrowserCapabilities(scope.catalogue, new BrowserControlPort(host));
    const res = await scope.catalogue.dispatch('anti.qa.visual_quality', { tabId: 'tab-1', scopeSelector: '.drawer', skipPageEnd: true }, scope.dispatchContext) as { measured: boolean; findings: unknown[] };
    assert.strictEqual(res.measured, true);
    assert.strictEqual(res.findings.length, 1);
    assert.ok(script.includes('"scopeSelector":".drawer"'), 'scope selector reaches the page script');
    assert.ok(script.includes('"skipPageEnd":true'));
  });

  it('reports an unmeasured scan instead of an empty clean result when the page returns garbage', async () => {
    const scope = makeScope();
    registerBrowserCapabilities(scope.catalogue, new BrowserControlPort(baseHost({ evalJs: async () => ({}) })));
    const res = await scope.catalogue.dispatch('anti.qa.visual_quality', { tabId: 'tab-1' }, scope.dispatchContext) as { measured: boolean; error?: string };
    assert.strictEqual(res.measured, false);
    assert.ok(res.error);
  });
});

describe('advertised MCP schemas', () => {
  const proxy = requireFromHere(path.resolve(process.cwd(), 'scripts/antifan-omp-mcp.cjs')) as {
    definitions: Array<[string, string, Record<string, any>, string[], unknown[], string?]>;
    READ_SAFE_CAPABILITIES: Record<string, boolean>;
  };
  const row = (name: string) => {
    const found = proxy.definitions.find(([defName]) => defName === name);
    assert.ok(found, `${name} must be advertised`);
    return found;
  };

  it('lets style_override clear every override without an id', () => {
    for (const name of ['theme.style_override', 'anti.theme.style_override']) {
      assert.deepStrictEqual(row(name)[3], ['operation']);
    }
  });

  it('publishes the typed agent.sequence step schema, including waitMs and pressKey', () => {
    const items = row('anti.agent.sequence')[2].actions.items;
    assert.strictEqual(items.type, 'object');
    assert.deepStrictEqual(items.required, ['type']);
    assert.ok(items.properties.type.enum.includes('pressKey'));
    assert.strictEqual(items.properties.waitMs.type, 'number');
    assert.strictEqual(items.properties.key.type, 'string');
  });

  it('advertises the visual-quality scan as replay-safe and the QA profile switch', () => {
    assert.ok(row('anti.qa.visual_quality'));
    assert.strictEqual(proxy.READ_SAFE_CAPABILITIES['anti.qa.visual_quality'], true);
    for (const name of ['theme.qa_validate', 'anti.theme.qa_validate']) {
      assert.deepStrictEqual(row(name)[2].profile.enum, ['audit', 'build-strict']);
    }
  });

  it('tells agents that a structural PASS is not a matrix certification', () => {
    assert.ok(row('theme.qa_validate')[1].includes('summary.certification'));
    assert.ok(row('anti.theme.qa_validate')[1].includes('summary.certification'));
  });
});
