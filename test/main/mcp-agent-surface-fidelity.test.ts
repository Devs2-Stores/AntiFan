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
import { BrowserControlPort, BrowserHostPort, batchRouteVerdict, buildRefLookupExpression, compactStylePairForResponse } from '../../src/main/tools/browser-control-port';
import * as fs from 'node:fs';
import * as os from 'node:os';
// @ts-ignore jsdom ships no type declarations (same as theme-qa-automation-stack.test.ts)
import { JSDOM } from 'jsdom';
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
    const script = scripts.find((s) => s.includes('var loc = '));
    assert.ok(script, 'the inspect script must carry the descriptor');
    assert.ok(script.includes('"kind":"dom","index":3') && script.includes('"tag":"button"'), 'path and tag are passed to the page');
    assert.ok(!script.includes('var loc = null'), 'the registry path is used, not the stamped-ref fallback');
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
    assert.strictEqual(items.required, undefined);
    assert.deepStrictEqual(items.anyOf, [{ required: ['type'] }, { required: ['action'] }]);
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

describe('tools that navigate or reload are never classed as reads', () => {
  // A read may be replayed by the proxy after a reconnect; replaying a navigation sweep or a
  // reload changes the tab under the agent.
  for (const name of ['anti.qa.batch_matrix', 'anti.theme.await_cdn_sync', 'anti.sheet.write_cell']) {
    it(`${name} is a write in the catalogue and absent from the proxy's read-safe set`, () => {
      const scope = makeScope();
      registerBrowserCapabilities(scope.catalogue, new BrowserControlPort(baseHost({})));
      const cap = scope.catalogue.get(name);
      assert.ok(cap, `${name} is registered`);
      assert.strictEqual(cap.risk, 'write');
      assert.notStrictEqual(scope.catalogue.getPolicy(name)?.effect, 'read');
      const proxy = requireFromHere(path.resolve(process.cwd(), 'scripts/antifan-omp-mcp.cjs')) as { READ_SAFE_CAPABILITIES: Record<string, boolean> };
      assert.notStrictEqual(proxy.READ_SAFE_CAPABILITIES[name], true);
    });
  }
});

describe('snapshot refs resolve through the registry path in page scripts', () => {
  const page = () => new JSDOM('<!doctype html><html><head></head><body><header><nav><a href="#a">A</a><button class="cart">Cart</button></nav></header><main><button class="cart">Other</button></main></body></html>', { runScripts: 'outside-only' });
  const run = (dom: JSDOM, expr: string) => dom.window.eval(expr) as Element | null;
  // document > html(0) > body(1) > header(0) > nav(0) > button(1)
  const cartPath = [{ kind: 'dom', index: 0 }, { kind: 'dom', index: 1 }, { kind: 'dom', index: 0 }, { kind: 'dom', index: 0 }, { kind: 'dom', index: 1 }];

  it('walks the descriptor path to the element the snapshot described', () => {
    const el = run(page(), buildRefLookupExpression({ path: cartPath, tag: 'button', id: null }, '@e4', 'main .cart'));
    assert.strictEqual(el?.textContent, 'Cart', 'the header button, not the selector fallback');
  });

  it('refuses a path that now lands on a different tag, then falls back to the selector', () => {
    const el = run(page(), buildRefLookupExpression({ path: cartPath, tag: 'a', id: null }, '@e4', 'main .cart'));
    assert.strictEqual(el?.textContent, 'Other');
  });

  it('uses a legacy stamp only for a well-formed ref and never splices a malformed one', () => {
    const dom = page();
    dom.window.document.querySelector('main .cart')!.setAttribute('data-antifan-ref', '@e9');
    assert.strictEqual(run(dom, buildRefLookupExpression(null, 'e9', ''))?.textContent, 'Other');
    assert.strictEqual(run(dom, buildRefLookupExpression(null, '@e1"], body, [x="', '')), null);
  });
});

describe('trace and wait resolve registry refs', () => {
  function hostWith(descriptor: unknown, scripts: string[]) {
    return baseHost({
      evalJs: async (script: string) => { scripts.push(script); return { actionable: true }; },
      resolveSemanticRefDescriptor: () => {
        if (descriptor instanceof Error) throw descriptor;
        return descriptor as { path: unknown[]; fingerprint?: { tag?: string } };
      },
    });
  }

  it('an actionability wait on a ref looks the element up by its registry path', async () => {
    const scope = makeScope();
    const scripts: string[] = [];
    const port = new BrowserControlPort(hostWith({ path: [{ kind: 'dom', index: 0 }], fingerprint: { tag: 'html' } }, scripts));
    await port.wait(scope.target, { condition: 'actionability', ref: '@e3', timeoutMs: 2000 });
    const check = scripts.find((x) => x.includes('NOT_CONNECTED'));
    assert.ok(check && check.includes('"kind":"dom"') && check.includes('"tag":"html"'));
  });

  it('a trace on a stale ref fails instead of tracing the whole document', async () => {
    const scope = makeScope();
    const stale = Object.assign(new Error('Semantic ref "@e5" is stale'), { code: 'REF_STALE' });
    const port = new BrowserControlPort(hostWith(stale, []));
    await assert.rejects(
      port.traceInteraction(scope.target, 'run-trace', 'attempt-trace', { action: 'hover', ref: '@e5' }),
      (err: unknown) => errorCode(err) === 'REF_STALE'
    );
  });
});

describe('batch_matrix verdicts and route bounds', () => {
  const clean = { emulationApplied: true, hasHorizontalOverflow: false, integrity: { measured: true, findings: [] } };

  it('fails on overflow or a critical finding and never passes an unmeasured width', () => {
    assert.strictEqual(batchRouteVerdict({ a: clean, b: clean }, 2).passed, true);
    assert.strictEqual(batchRouteVerdict({ a: clean, b: { ...clean, hasHorizontalOverflow: true } }, 2).passed, false);
    assert.strictEqual(batchRouteVerdict({ a: clean, b: { ...clean, integrity: { measured: true, findings: [{ severity: 'critical' }] } } }, 2).passed, false);
    assert.strictEqual(batchRouteVerdict({ a: clean, b: { ...clean, emulationApplied: false, hasHorizontalOverflow: null } }, 2).passed, null);
    assert.strictEqual(batchRouteVerdict({ a: clean, b: { ...clean, integrity: { measured: false } } }, 2).passed, null);
    assert.strictEqual(batchRouteVerdict({ a: clean }, 2).passed, null, 'a width missing from the sweep is unmeasured');
  });

  it('refuses a route on another origin before the tab moves', async () => {
    const scope = makeScope();
    const navigations: string[] = [];
    const port = new BrowserControlPort(baseHost({
      getTabUrl: () => 'https://shop.example.com/',
      navigate: (url: string) => { navigations.push(url); return true; },
    }));
    await assert.rejects(
      port.runBatchMatrix(scope.target, { routes: ['/collections/all', 'https://evil.example.net/'] }),
      (err: unknown) => errorCode(err) === 'INVALID_ARGUMENT' && /leaves the storefront origin/.test((err as Error).message)
    );
    assert.deepStrictEqual(navigations, []);
  });
});

describe('await_cdn_sync reads only inside the bound workspace', () => {
  const workspace = () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'antifan-cdn-sync-'));
    fs.mkdirSync(path.join(root, 'assets'), { recursive: true });
    fs.writeFileSync(path.join(root, 'assets', 'theme.css'), 'body{color:red}', 'utf8');
    return root;
  };

  it('refuses a Liquid source up front', async () => {
    const port = new BrowserControlPort(baseHost({}));
    await assert.rejects(
      port.awaitCdnSync(makeScope().target, { assetPath: 'theme.scss.liquid', workspaceRoot: workspace() }),
      (err: unknown) => errorCode(err) === 'INVALID_ARGUMENT' && /Liquid source/.test((err as Error).message)
    );
  });

  it('never resolves a path past the workspace root, and says so without the root path', async () => {
    const root = workspace();
    const port = new BrowserControlPort(baseHost({}));
    await assert.rejects(
      port.awaitCdnSync(makeScope().target, { assetPath: 'assets/../../outside.css', workspaceRoot: root }),
      (err: unknown) => errorCode(err) === 'INVALID_ARGUMENT' && !(err as Error).message.includes(root)
    );
  });

  it('is unbound without a workspace instead of reading the process directory', async () => {
    const port = new BrowserControlPort(baseHost({ resolveTabWorkspace: () => '' }));
    await assert.rejects(
      port.awaitCdnSync(makeScope().target, { assetPath: 'theme.css' }),
      (err: unknown) => errorCode(err) === 'WORKSPACE_UNBOUND'
    );
  });

  it('reports why the last poll did not match', async () => {
    const port = new BrowserControlPort(baseHost({
      evalJs: async () => ({ error: 'ASSET_NOT_REFERENCED: no stylesheet or script on the page loads theme.css' }),
    }));
    const res = await port.awaitCdnSync(makeScope().target, { assetPath: 'theme.css', workspaceRoot: workspace(), timeoutMs: 200, pollIntervalMs: 50 });
    assert.strictEqual(res.synced, false);
    assert.match(String(res.lastError), /ASSET_NOT_REFERENCED/);
  });
});

describe('trace evidence and the pointer arriving on the target', () => {
  const snap = (hovered: boolean, color: string) => ({
    url: 'https://shop.example.com/',
    bodyClasses: [],
    activeOverlays: [],
    target: { found: true, hovered, computedStyles: { color }, children: [{ tagName: 'span', className: '', computedStyles: { color } }] },
  });
  const evaluate = (before: unknown, after: unknown, action: string) =>
    (new BrowserControlPort(baseHost({})) as any).evaluateBehaviorEvidence(before, after, { color: 'x' }, { color: 'y' }, action);

  it('does not count a click whose only change is the hover restyle', () => {
    assert.strictEqual(evaluate(snap(false, 'rgb(0, 0, 0)'), snap(true, 'rgb(255, 0, 0)'), 'click').verdict, 'NO_OBSERVABLE_EFFECT');
  });

  it('keeps the restyle as evidence for a hover', () => {
    assert.strictEqual(evaluate(snap(false, 'rgb(0, 0, 0)'), snap(true, 'rgb(255, 0, 0)'), 'hover').verdict, 'IN_PAGE_MUTATION');
  });

  it('counts a click restyle when the pointer was already over the target', () => {
    assert.strictEqual(evaluate(snap(true, 'rgb(0, 0, 0)'), snap(true, 'rgb(255, 0, 0)'), 'click').verdict, 'IN_PAGE_MUTATION');
  });
});

describe('state_matrix holds the tab on the page under test', () => {
  it('refuses page-initiated navigation for the run and reports where a trigger tried to go', async () => {
    let released = 0;
    const port = new BrowserControlPort(baseHost({
      executeActionSequence: async () => ({ success: true, results: [{ success: true }] }),
      holdPageNavigation: () => ({ release: () => { released += 1; return ['https://shop.example.com/auth/sign-in']; } }),
    }));
    const res = await port.stateMatrix(makeScope().target, { maxTriggers: 2 });
    assert.deepStrictEqual(res.blockedNavigations, ['https://shop.example.com/auth/sign-in']);
    assert.ok(released >= 1, 'the hold is released when the run ends');
  });

  it('releases the hold when the run throws', async () => {
    let released = 0;
    const port = new BrowserControlPort(baseHost({
      executeActionSequence: async () => ({ success: true, results: [{ success: true }] }),
      holdPageNavigation: () => ({ release: () => { released += 1; return []; } }),
      withPaintingSurface: async () => { throw new Error('surface lost'); },
    }));
    await assert.rejects(port.stateMatrix(makeScope().target, {}), /surface lost/);
    assert.strictEqual(released, 1);
  });
});

describe('batch_matrix keeps the theme preview', () => {
  it('carries themeid onto routes that name none and returns the settled generation', async () => {
    const navigations: string[] = [];
    let url = 'https://shop.example.com/?themeid=1001506727';
    const port = new BrowserControlPort(baseHost({
      getTabUrl: () => url,
      navigate: (_tabId: string, next: string) => { navigations.push(next); url = next; return true; },
      getDocumentGeneration: () => 9,
    }));
    (port as any).responsiveCheck = async () => ({ breakpoints: {} });
    const res = await port.runBatchMatrix({ ...makeScope().target, documentGeneration: 9 }, { routes: ['/collections/all', '/pages/about?themeid=42'], breakpoints: [375] });
    assert.deepStrictEqual(navigations.slice(0, 2), [
      'https://shop.example.com/collections/all?themeid=1001506727',
      'https://shop.example.com/pages/about?themeid=42',
    ]);
    assert.strictEqual(navigations[navigations.length - 1], 'https://shop.example.com/?themeid=1001506727', 'the tab goes back');
    assert.strictEqual(res.documentGeneration, 9);
  });
});
