// Argument spellings a caller naturally reaches for are accepted by the browser capabilities and
// folded onto the canonical form before the port is called: the stub port records exactly what
// reaches it.
import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import { CapabilityCatalogue } from '../../src/main/tools/capability-catalogue';
import { registerBrowserCapabilities } from '../../src/main/tools/browser-capabilities';
import { LIST_TAB_FIELDS, type BrowserControlPort } from '../../src/main/tools/browser-control-port';
import { checkRequiredArgs } from '../../src/main/tools/required-args';
import { BrowserTarget, CapabilityError } from '../../src/shared/control-plane-contracts';

const TARGET: BrowserTarget = {
  projectId: 'proj-friction',
  workspaceId: 'ws-friction',
  runtimeId: 'rt-friction',
  tabId: 'tab-1',
  browserEpoch: 1,
  documentGeneration: 1,
};

interface Recorded {
  method: string;
  args: unknown[];
}

function makeHarness() {
  const calls: Recorded[] = [];
  const record = (method: string) => async (...args: unknown[]) => {
    calls.push({ method, args });
    return { recorded: method };
  };
  const port = {
    wait: record('wait'),
    sequence: record('sequence'),
    jsDialog: record('jsDialog'),
    switchTab: record('switchTab'),
    listTabs: async (...args: unknown[]) => {
      calls.push({ method: 'listTabs', args });
      return [{ id: 'tab-1', url: 'https://shop.example/' }];
    },
  } as unknown as BrowserControlPort;
  const catalogue = new CapabilityCatalogue({
    runtime: { mode: 'standalone', lifecycle: 'active' },
    projectId: TARGET.projectId,
    workspaceId: TARGET.workspaceId,
    runtimeId: TARGET.runtimeId,
  });
  registerBrowserCapabilities(catalogue, port);
  const context = { browserTarget: TARGET, projectId: TARGET.projectId, workspaceId: TARGET.workspaceId } as never;
  const run = (name: string, params: Record<string, unknown>) => {
    const capability = catalogue.get(name);
    assert.ok(capability, `${name} must be registered`);
    return capability.execute(params as never, context);
  };
  const last = (method: string): Recorded => {
    const found = [...calls].reverse().find((call) => call.method === method);
    assert.ok(found, `${method} was not called`);
    return found;
  };
  return { catalogue, run, last, calls };
}

const invalid = (pattern: RegExp) => (err: unknown): boolean =>
  err instanceof CapabilityError && err.code === 'INVALID_ARGUMENT' && pattern.test(err.message);

describe('tabs.list fields accepts tabId as an alias of id', () => {
  it('folds tabId onto the id column and drops duplicates', async () => {
    const h = makeHarness();
    await h.run('anti.browser.tabs.list', { fields: ['tabId', 'url', 'id'] });
    const options = h.last('listTabs').args[0] as { fields?: string[] };
    assert.deepStrictEqual(options.fields, ['id', 'url']);
  });

  it('still refuses an empty fields list', async () => {
    const h = makeHarness();
    await assert.rejects(async () => h.run('anti.browser.tabs.list', { fields: [] }), invalid(/fields must be a non-empty array/));
  });

  for (const name of ['anti.browser.tabs.list', 'browser.list-tabs']) {
    it(`${name} lists the columns it knows and reports the names it did not recognise`, async () => {
      const h = makeHarness();
      const result = await h.run(name, { fields: ['id', 'url', 'active', 'viewport'] });
      assert.deepStrictEqual((h.last('listTabs').args[0] as { fields?: string[] }).fields, ['id', 'url']);
      assert.deepStrictEqual(result, {
        tabs: [{ id: 'tab-1', url: 'https://shop.example/' }],
        ignoredFields: ['active', 'viewport'],
        validFields: LIST_TAB_FIELDS,
      });
    });

    it(`${name} returns whole rows when every requested field is unknown`, async () => {
      const h = makeHarness();
      const result = await h.run(name, { fields: ['active'] }) as { tabs: unknown[]; ignoredFields: string[] };
      assert.strictEqual((h.last('listTabs').args[0] as { fields?: string[] }).fields, undefined);
      assert.deepStrictEqual(result.ignoredFields, ['active']);
      assert.strictEqual(result.tabs.length, 1);
    });

    it(`${name} keeps the plain row list when every field is known`, async () => {
      const h = makeHarness();
      const result = await h.run(name, { fields: ['tabId', 'url'] });
      assert.deepStrictEqual(result, [{ id: 'tab-1', url: 'https://shop.example/' }]);
    });
  }
});

describe('agent.sequence accepts action as an alias of a step type', () => {
  for (const name of ['anti.agent.sequence', 'browser.agent-sequence', 'antifan_agent_sequence']) {
    it(`${name} folds step.action onto step.type`, async () => {
      const h = makeHarness();
      await h.run(name, { steps: [{ action: 'click', selector: '#buy' }, { type: 'wait', waitMs: 10 }] });
      const forwarded = h.last('sequence').args[0] as { actions: Array<Record<string, unknown>> };
      assert.deepStrictEqual(forwarded.actions, [{ type: 'click', selector: '#buy' }, { type: 'wait', waitMs: 10 }]);
    });
  }

  it('refuses a step that names two different spellings', async () => {
    const h = makeHarness();
    await assert.rejects(
      async () => h.run('anti.agent.sequence', { actions: [{ type: 'click', action: 'hover', selector: '#x' }] }),
      invalid(/step 0 sets type 'click' and action 'hover'/)
    );
  });

  it('accepts the same spelling twice', async () => {
    const h = makeHarness();
    await h.run('anti.agent.sequence', { actions: [{ type: 'click', action: 'click', selector: '#x' }] });
    const forwarded = h.last('sequence').args[0] as { actions: Array<Record<string, unknown>> };
    assert.deepStrictEqual(forwarded.actions, [{ type: 'click', selector: '#x' }]);
  });

  it('still refuses actions and steps together', async () => {
    const h = makeHarness();
    await assert.rejects(
      async () => h.run('anti.agent.sequence', { actions: [], steps: [] }),
      invalid(/not both/)
    );
  });

  it('advertises the action alias on every step', () => {
    const h = makeHarness();
    const schema = h.catalogue.get('anti.agent.sequence')!.inputSchema as {
      properties: { actions: { items: { properties: Record<string, unknown>; anyOf: unknown[] } } };
    };
    assert.ok(schema.properties.actions.items.properties.action, 'step schema names action');
    assert.deepStrictEqual(schema.properties.actions.items.anyOf, [{ required: ['type'] }, { required: ['action'] }]);
  });
});

describe('browser.wait infers its condition from the target argument', () => {
  const cases: Array<[Record<string, unknown>, string]> = [
    [{ selector: '.cart' }, 'selector'],
    [{ ref: '@e3' }, 'ref'],
    [{ urlPattern: '/cart' }, 'url'],
    [{ url: 'https://shop.example.com/cart' }, 'url'],
    [{ minGeneration: 2 }, 'generation'],
  ];
  for (const name of ['browser.wait', 'anti.browser.wait']) {
    for (const [params, expected] of cases) {
      it(`${name} ${JSON.stringify(params)} waits for ${expected}`, async () => {
        const h = makeHarness();
        await h.run(name, params);
        const forwarded = h.last('wait').args[1] as { condition: string };
        assert.strictEqual(forwarded.condition, expected);
      });
    }

    it(`${name} never overrides an explicit condition or type`, async () => {
      const h = makeHarness();
      await h.run(name, { selector: '.cart', condition: 'dom-stable' });
      assert.strictEqual((h.last('wait').args[1] as { condition: string }).condition, 'dom-stable');
      await h.run(name, { selector: '.cart', type: 'network' });
      const forwarded = h.last('wait').args[1] as { condition?: string; type?: string };
      assert.strictEqual(forwarded.condition, undefined);
      assert.strictEqual(forwarded.type, 'network');
    });

    it(`${name} refuses a call that names neither a condition nor a target`, async () => {
      const h = makeHarness();
      await assert.rejects(async () => h.run(name, { timeoutMs: 100 }), invalid(/needs a condition/));
      await assert.rejects(async () => h.run(name, { tabId: 'tab-1' }), invalid(/needs a condition/));
    });

    for (const [params, expectedMs, alias] of [
      [{ timeout: 15000 }, 15000, 'timeout'],
      [{ tabId: 'tab-1', timeout: 15000 }, 15000, 'timeout'],
      [{ ms: 500 }, 500, 'ms'],
    ] as Array<[Record<string, unknown>, number, string]>) {
      it(`${name} ${JSON.stringify(params)} sleeps for that long and says what it inferred`, async () => {
        const h = makeHarness();
        const result = await h.run(name, params) as { conditionInferred?: string; aliasApplied?: unknown };
        const forwarded = h.last('wait').args[1] as Record<string, unknown>;
        assert.strictEqual(forwarded.condition, 'timeout');
        assert.strictEqual(forwarded.timeoutMs, expectedMs);
        assert.ok(!('timeout' in forwarded) && !('ms' in forwarded), 'the alias field is folded away');
        assert.strictEqual(result.conditionInferred, 'timeout');
        assert.deepStrictEqual(result.aliasApplied, [{ from: alias, to: 'timeoutMs' }]);
      });
    }

    it(`${name} reads timeout as the bound of the condition it infers from a target`, async () => {
      const h = makeHarness();
      const result = await h.run(name, { selector: '.cart', timeout: 3000 }) as { conditionInferred?: string; aliasApplied?: unknown };
      const forwarded = h.last('wait').args[1] as Record<string, unknown>;
      assert.strictEqual(forwarded.condition, 'selector');
      assert.strictEqual(forwarded.timeoutMs, 3000);
      assert.strictEqual(result.conditionInferred, 'selector');
      assert.deepStrictEqual(result.aliasApplied, [{ from: 'timeout', to: 'timeoutMs' }]);
    });

    it(`${name} never lets an alias override timeoutMs or a non-numeric value stand in for it`, async () => {
      const h = makeHarness();
      await h.run(name, { condition: 'timeout', timeoutMs: 200, timeout: 9000 });
      assert.strictEqual((h.last('wait').args[1] as { timeoutMs: number }).timeoutMs, 200);
      await assert.rejects(async () => h.run(name, { timeout: 'soon' }), invalid(/needs a condition/));
    });

    it(`${name} passes the presence gate with timeout or ms alone`, () => {
      const h = makeHarness();
      const schema = h.catalogue.get(name)!.inputSchema as Record<string, unknown>;
      assert.strictEqual(checkRequiredArgs(name, schema, { timeout: 15000 }), undefined);
      assert.strictEqual(checkRequiredArgs(name, schema, { ms: 500 }), undefined);
      assert.ok(checkRequiredArgs(name, schema, { timeoutMs: 250 }), 'a bare timeoutMs is a bound, not a condition');
    });
  }

  it('advertises the presence forms, identically on both registrations', () => {
    const h = makeHarness();
    const a = h.catalogue.get('browser.wait')!.inputSchema as { anyOf: Array<{ required: string[] }> };
    const b = h.catalogue.get('anti.browser.wait')!.inputSchema as { anyOf: Array<{ required: string[] }> };
    assert.deepStrictEqual(a.anyOf, b.anyOf);
    assert.deepStrictEqual(
      a.anyOf.map((form) => form.required[0]),
      ['condition', 'type', 'selector', 'ref', 'urlPattern', 'url', 'minGeneration', 'timeout', 'ms']
    );
  });
});

describe('agent type with clear needs no text', () => {
  const NAMES = ['anti.agent.cursor.type', 'browser.agent-type'];
  for (const name of NAMES) {
    it(`${name} accepts clear with empty or absent text and still refuses nothing to type`, () => {
      const h = makeHarness();
      const schema = h.catalogue.get(name)!.inputSchema as Record<string, unknown>;
      assert.strictEqual(checkRequiredArgs(name, schema, { selector: '#q', text: '', clear: true }), undefined);
      assert.strictEqual(checkRequiredArgs(name, schema, { selector: '#q', clear: true }), undefined);
      assert.strictEqual(checkRequiredArgs(name, schema, { selector: '#q', text: 'abc' }), undefined);
      assert.ok(checkRequiredArgs(name, schema, { selector: '#q', text: '' }), 'empty text without clear types nothing');
      assert.ok(checkRequiredArgs(name, schema, { selector: '#q' }));
    });
  }
});

describe('anti.browser.dialog defaults to reading the open dialog', () => {
  it('forwards action get when no action is given', async () => {
    const h = makeHarness();
    await h.run('anti.browser.dialog', {});
    assert.strictEqual((h.last('jsDialog').args[0] as { action: string }).action, 'get');
  });

  it('maps the read alias to get and keeps accept and dismiss', async () => {
    const h = makeHarness();
    await h.run('anti.browser.dialog', { action: 'read' });
    assert.strictEqual((h.last('jsDialog').args[0] as { action: string }).action, 'get');
    await h.run('anti.browser.dialog', { action: 'accept' });
    assert.strictEqual((h.last('jsDialog').args[0] as { action: string }).action, 'accept');
    await h.run('anti.browser.dialog', { action: 'dismiss' });
    assert.strictEqual((h.last('jsDialog').args[0] as { action: string }).action, 'dismiss');
  });

  it('does not require action in its schema', () => {
    const h = makeHarness();
    const schema = h.catalogue.get('anti.browser.dialog')!.inputSchema as { required?: string[] };
    assert.ok(!schema.required?.includes('action'));
  });
});

describe('tabs.activate restoreWindow', () => {
  for (const name of ['browser.switch-tab', 'anti.browser.tabs.activate']) {
    it(`${name} forwards restoreWindow:true to the port`, async () => {
      const h = makeHarness();
      await h.run(name, { tabId: 'tab-2', restoreWindow: true });
      const [tabId, options] = h.last('switchTab').args as [string, { restoreWindow?: boolean }];
      assert.strictEqual(tabId, 'tab-2');
      assert.strictEqual(options.restoreWindow, true);
    });

    it(`${name} sends no restoreWindow when it is absent or false`, async () => {
      const h = makeHarness();
      await h.run(name, { tabId: 'tab-2' });
      assert.ok(!('restoreWindow' in (h.last('switchTab').args[1] as object)));
      await h.run(name, { tabId: 'tab-2', restoreWindow: false });
      assert.ok(!('restoreWindow' in (h.last('switchTab').args[1] as object)));
    });

    it(`${name} refuses a non-boolean restoreWindow`, async () => {
      const h = makeHarness();
      await assert.rejects(async () => h.run(name, { tabId: 'tab-2', restoreWindow: 'yes' }), invalid(/restoreWindow must be a boolean/));
    });
  }
});

describe('theme.await_cdn_sync accepts asset as an alias of assetPath', () => {
  it('advertises either spelling as sufficient', () => {
    const h = makeHarness();
    const schema = h.catalogue.get('anti.theme.await_cdn_sync')!.inputSchema as {
      properties: Record<string, unknown>;
      anyOf: Array<{ required: string[] }>;
    };
    assert.ok(schema.properties.asset, 'asset is a declared property');
    assert.deepStrictEqual(schema.anyOf, [{ required: ['assetPath'] }, { required: ['asset'] }]);
  });
});
