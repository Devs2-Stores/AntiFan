/**
 * Refused close/quit notice — real DOM proof.
 *
 * Loads the shipped toolbar chrome (toolbar.html + its compiled toolbar.js) into jsdom with a
 * stubbed antifanToolbar bridge and drives the shipped subscription for the behavior the
 * close gate depends on: a refusal Main already decided is rendered as the summary it carries
 * plus one row per reason, each reason's named controls are shown as guidance, a vetoed close
 * also names the tab that is blocking it and the route that clears it, the latest
 * notice replaces the previous one, dismiss clears the region, a malformed payload paints
 * nothing and throws nothing, and none of it takes focus.
 *
 * The markup and the exports shim are read from the source tree — the build copies both
 * verbatim into every output tree — while the script is the nearest compiled build of
 * `toolbar.js`, which is where an outDir emit lands. Reading them independently is what keeps
 * this suite honest when it runs from a throwaway outDir: a stale compiled script cannot be
 * paired with fresh markup and pass, because these rows drive the shipped subscription and a
 * stale build never registered one.
 *
 * jsdom is a declared devDependency and a hard prerequisite of this suite; when the shared
 * node_modules copy is broken the test honors ANTIFAN_JSDOM (a dir containing node_modules/jsdom)
 * and fails with the resolution error as the named blocker.
 */
import { test, describe, after } from 'node:test';
import * as assert from 'node:assert';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { createRequire } from 'node:module';

/**
 * A jsdom window: the DOM, plus the `eval` this suite injects the chrome scripts through.
 * `antifanToolbar` is rewritten here with a stub narrower than the shipped bridge, so the
 * shipped declaration is omitted rather than widened.
 */
interface ToolbarWindow extends Omit<Window, 'antifanToolbar'> {
  eval: (src: string) => unknown;
  antifanToolbar?: unknown;
}
interface JsdomLike { window: ToolbarWindow }
type JsdomCtor = new (html: string, options?: { runScripts?: string; url?: string }) => JsdomLike;

function loadJsdom(): { JSDOM: JsdomCtor } {
  const req = createRequire(__filename);
  // ANTIFAN_JSDOM points at a dir containing node_modules/jsdom and wins first;
  // the default lookup (junctioned node_modules) is the fallback.
  const searchPaths = process.env.ANTIFAN_JSDOM
    ? [process.env.ANTIFAN_JSDOM, path.dirname(__filename)]
    : [path.dirname(__filename)];
  try {
    const resolved = req.resolve('jsdom', { paths: searchPaths });
    // `createRequire` returns `any`; naming the shape once keeps every later read checked.
    const jsdomModule: { JSDOM: JsdomCtor } = req(resolved);
    return { JSDOM: jsdomModule.JSDOM };
  } catch (err) {
    throw new Error(`jsdom is a declared devDependency and a hard prerequisite of this suite; resolution failed (searched: ${searchPaths.join(', ')}): ${err instanceof Error ? err.message : String(err)}`);
  }
}

/**
 * The shipped chrome markup, from the nearest tree that has it: the repository's own
 * `src/renderer`, or a build tree the same file was copied into.
 */
const RENDERER_MARKUP_DIR = (() => {
  let dir = __dirname;
  for (let i = 0; i < 8; i++) {
    for (const candidate of [path.join(dir, 'src', 'renderer'), path.join(dir, '.compiled', 'src', 'renderer')]) {
      if (fs.existsSync(path.join(candidate, 'toolbar.html'))) return candidate;
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return path.resolve(__dirname, '..', '..', 'src', 'renderer');
})();

/** The compiled renderer script, from the nearest build tree an outDir emit could land in. */
const RENDERER_SCRIPT_DIR = (() => {
  let dir = __dirname;
  for (let i = 0; i < 8; i++) {
    // The outDir tree first, then the default build tree at the same level: an isolated
    // build must win over a stale `.compiled` sitting next to it.
    for (const candidate of [path.join(dir, 'src', 'renderer'), path.join(dir, '.compiled', 'src', 'renderer')]) {
      if (fs.existsSync(path.join(candidate, 'toolbar.js'))) return candidate;
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return path.resolve(__dirname, '..', '..', '.compiled', 'src', 'renderer');
})();

/**
 * What the stub can do to the renderer: deliver one notice through the subscription the
 * chrome registered at init. Delivery is synchronous, so a renderer that threw while
 * rendering would throw here — which is exactly the malformed-payload proof.
 */
interface BridgeStub {
  pushRefusal: (notice: unknown) => void;
}

function makeApi(state: Record<string, unknown>, stub: BridgeStub) {
  const noop = () => () => undefined;
  const refusalSubscribers: Array<(notice: unknown) => void> = [];
  stub.pushRefusal = (notice) => {
    assert.ok(
      refusalSubscribers.length > 0,
      'the toolbar chrome subscribes to refusal notices during init, or no refusal could ever be shown'
    );
    for (const subscriber of [...refusalSubscribers]) subscriber(notice);
  };
  return {
    getInitialState: () => Promise.resolve(state),
    getWorkflowState: () => Promise.resolve({ workflows: [], tools: [] }),
    onStateUpdated: noop,
    onThemeQaState: noop,
    onFocusFind: noop,
    onFocusOmnibox: noop,
    onShowShortcuts: noop,
    onFindResult: noop,
    onPhoneStatusChanged: noop,
    onWorkflowEvent: noop,
    getPhoneStatus: () => Promise.resolve({ state: 'unknown' }),
    // The overlay owner chain reports its strip height to Main; the stub records nothing,
    // but the call must exist so a passing run has no stray TypeErrors in its output.
    setOverlay: () => Promise.resolve(),
    onCloseRefused: (callback: (notice: unknown) => void) => {
      refusalSubscribers.push(callback);
      return () => {
        const index = refusalSubscribers.indexOf(callback);
        if (index >= 0) refusalSubscribers.splice(index, 1);
      };
    },
  };
}

async function flush(rounds = 12) {
  // Microtask yields only — every async hop in the init path is promise-based, so draining
  // the microtask queue is the deterministic wait (no timers).
  for (let i = 0; i < rounds; i++) {
    const { promise, resolve } = Promise.withResolvers<void>();
    queueMicrotask(resolve);
    await promise;
  }
}

async function loadToolbar(projectWindow: unknown, tabs: unknown[] = []) {
  // Replaced by `makeApi` with the real channel to the chrome's own subscription.
  const stub: BridgeStub = { pushRefusal: () => { throw new Error('the bridge was never installed'); } };
  const { JSDOM } = loadJsdom();
  const html = fs.readFileSync(path.join(RENDERER_MARKUP_DIR, 'toolbar.html'), 'utf8');
  const dom = new JSDOM(html, { runScripts: 'outside-only', url: 'http://localhost/' });
  const win = dom.window;
  const state: Record<string, unknown> = { tabs, activeTabId: '', bookmarks: [], projectWindow };
  win.antifanToolbar = makeApi(state, stub);
  win.eval(fs.readFileSync(path.join(RENDERER_MARKUP_DIR, 'exports-shim.js'), 'utf8'));
  win.eval(fs.readFileSync(path.join(RENDERER_SCRIPT_DIR, 'toolbar.js'), 'utf8'));
  await flush();
  return { dom, win, doc: win.document, stub };
}

/**
 * A refused close as Main reports it for a two-page shell: two reasons, each naming the
 * existing control that would release it. The strings carry colons, brackets and an action
 * id, which is what makes a `textContent` handler distinguishable from an `innerHTML` one.
 */
const REFUSED_CLOSE = {
  kind: 'close',
  ownerKey: 'project:acme',
  haltedBy: 'busy',
  summary:
    'Close of project:acme: shell retained, stopped by busy (closed 0, skipped 2, failed 0); earlier closes stand and are not transactional.',
  reasons: [
    {
      code: 'busy',
      detail: '2 in-flight operations are admitted on tab-acme-1',
      tabId: 'tab-acme-1',
      controls: [
        {
          id: 'antifan:workflow:abort',
          label: 'Stop the run where it was started (the toolbar stop button for a workflow, the agent client for its own run), or wait for it to finish',
        },
      ],
    },
    {
      code: 'agent-affinity',
      detail: 'A verified agent affinity holds tab-acme-2 through terminal session term-7',
      tabId: 'tab-acme-2',
      controls: [
        {
          id: 'antifan:terminal:close-session',
          label: 'Close the terminal session that owns this page (✕ on the terminal tab in the terminal workbench), or stop the agent session running in it',
        },
      ],
    },
  ],
};

/** The same refusal one moment later: that in-flight operation ended, so its row is gone. */
const REFUSED_CLOSE_AFTER_RELEASE = {
  kind: 'close',
  ownerKey: 'project:acme',
  haltedBy: 'busy',
  summary:
    'Close of project:acme: shell retained, stopped by busy (closed 0, skipped 1, failed 0); earlier closes stand and are not transactional.',
  reasons: [
    {
      code: 'agent-affinity',
      detail: 'A verified agent affinity holds tab-acme-2 through terminal session term-7',
      tabId: 'tab-acme-2',
      controls: [
        {
          id: 'antifan:terminal:close-session',
          label: 'Close the terminal session that owns this page (✕ on the terminal tab in the terminal workbench), or stop the agent session running in it',
        },
      ],
    },
  ],
};

function noticeEl(doc: Document): HTMLElement {
  const el = doc.getElementById('closeRefusalNotice');
  assert.ok(el, 'the chrome always carries the refusal notice region');
  return el;
}

function reasonsEl(doc: Document): HTMLElement {
  const el = doc.getElementById('closeRefusalReasons');
  assert.ok(el, 'the region carries a reason list container');
  return el;
}

function summaryText(doc: Document): string {
  return doc.getElementById('closeRefusalSummary')?.textContent ?? '';
}

function reasonRows(doc: Document): HTMLElement[] {
  // `Array.from`, not a spread: this project's `lib` has no `dom.iterable`.
  return Array.from(reasonsEl(doc).querySelectorAll<HTMLElement>('.close-refusal-reason'));
}

function rowDetail(row: HTMLElement | undefined): string {
  return row?.querySelector('.close-refusal-reason-detail')?.textContent ?? '';
}

function rowControls(row: HTMLElement | undefined): Array<{ id: string; label: string }> {
  if (!row) return [];
  return Array.from(row.querySelectorAll<HTMLElement>('.close-refusal-control')).map((line) => ({
    id: line.getAttribute('data-control-id') ?? '',
    label: line.textContent ?? '',
  }));
}

describe('Refused close/quit notice', () => {
  let dom: JsdomLike | undefined;
  after(() => { dom?.window.close(); });

  test('renders the summary, every reason and each named control as guidance, without taking focus', async () => {
    const ctx = await loadToolbar({ owner: { kind: 'unassigned' } });
    dom = ctx.dom;
    const { doc, stub } = ctx;

    // A shell that was never refused looks exactly as it always did.
    assert.strictEqual(noticeEl(doc).style.display, 'none', 'the notice is hidden until a refusal arrives');
    assert.strictEqual(reasonsEl(doc).childElementCount, 0, 'no reason rows exist before a refusal');

    const input = doc.getElementById('urlInput') as HTMLInputElement | null;
    assert.ok(input, 'the omnibox exists');
    input.focus();
    assert.strictEqual(doc.activeElement, input, 'the omnibox holds focus before the refusal arrives');

    stub.pushRefusal(REFUSED_CLOSE);
    await flush();

    assert.strictEqual(noticeEl(doc).style.display, 'flex', 'the refusal is shown');
    assert.strictEqual(doc.activeElement, input, 'a refusal notice does not take focus');
    assert.strictEqual(summaryText(doc), REFUSED_CLOSE.summary, '#closeRefusalSummary carries Main summary verbatim');

    const rows = reasonRows(doc);
    assert.strictEqual(rows.length, 2, 'one row per reason, in the order Main reported them');
    assert.strictEqual(rows[0]?.getAttribute('data-reason-code'), 'busy');
    assert.strictEqual(rows[0]?.getAttribute('data-tab-id'), 'tab-acme-1');
    assert.strictEqual(rowDetail(rows[0]), '2 in-flight operations are admitted on tab-acme-1');
    assert.strictEqual(rowDetail(rows[1]), 'A verified agent affinity holds tab-acme-2 through terminal session term-7');
    assert.deepStrictEqual(rowControls(rows[0]), [{
      id: 'antifan:workflow:abort',
      label: 'Stop the run where it was started (the toolbar stop button for a workflow, the agent client for its own run), or wait for it to finish',
    }]);
    assert.deepStrictEqual(rowControls(rows[1]), [{
      id: 'antifan:terminal:close-session',
      label: 'Close the terminal session that owns this page (✕ on the terminal tab in the terminal workbench), or stop the agent session running in it',
    }]);
  });

  test('a vetoed close names the tab that is blocking it and the one route past it', async () => {
    const ctx = await loadToolbar({ owner: { kind: 'unassigned' } }, [
      {
        id: 'tab-music-1',
        title: 'Nhạc thư giãn, tĩnh tâm | 1 Hour Relaxing Piano Music',
        url: 'https://music.youtube.com/watch?v=QU_ZXKlBk9I',
      },
    ]);
    dom = ctx.dom;
    const { doc, stub } = ctx;

    stub.pushRefusal({
      kind: 'close',
      ownerKey: 'project:acme',
      haltedBy: 'unload-veto',
      summary:
        'Close of project:acme: shell retained, stopped by unload-veto (closed 2, skipped 7, failed 0); earlier closes stand and are not transactional.',
      reasons: [
        { code: 'unload-veto', detail: 'Page tab-music-1 refused to unload', tabId: 'tab-music-1', controls: [] },
      ],
    });
    await flush();

    const row = reasonRows(doc)[0];
    assert.strictEqual(row?.getAttribute('data-reason-code'), 'unload-veto');
    // Main refuses this close and offers no control, so the row is the only place the user can
    // learn what stands in the way and what actually clears it.
    assert.strictEqual(rowControls(row).length, 0, 'the veto names no control over the blocking page');
    const hint = row?.querySelector('.close-refusal-reason-hint')?.textContent ?? '';
    assert.ok(
      hint.includes('Nhạc thư giãn, tĩnh tâm'),
      'the veto names the tab the user is looking at, not only its id'
    );
    assert.ok(hint.includes('Đóng tab đó'), 'the veto carries the route that does work: closing that tab');

    // An id whose tab the strip no longer shows still gets the route, just without a name.
    stub.pushRefusal({
      kind: 'close',
      summary: 'Close refused',
      reasons: [{ code: 'unload-veto', detail: 'Page gone-1 refused to unload', tabId: 'gone-1', controls: [] }],
    });
    await flush();

    const unnamed = reasonRows(doc)[0]?.querySelector('.close-refusal-reason-hint')?.textContent ?? '';
    assert.ok(unnamed.includes('Đóng tab đang chặn'), 'an unnamed veto still names the route');
    assert.ok(!unnamed.includes('gone-1'), 'a tab id is not a name to show the user');

    // Every other refusal keeps exactly the text Main wrote for it, controls included.
    stub.pushRefusal(REFUSED_CLOSE);
    await flush();

    const otherRows = reasonRows(doc);
    assert.strictEqual(otherRows.length, 2);
    for (const otherRow of otherRows) {
      assert.strictEqual(
        otherRow.querySelector('.close-refusal-reason-hint'),
        null,
        'a refusal that is not a veto gains no instruction of its own'
      );
    }
    assert.deepStrictEqual(rowControls(otherRows[1]), [{
      id: 'antifan:terminal:close-session',
      label: 'Close the terminal session that owns this page (✕ on the terminal tab in the terminal workbench), or stop the agent session running in it',
    }]);
  });

  test('reason text is written as text, so an HTML-shaped detail cannot become markup', async () => {
    const ctx = await loadToolbar({ owner: { kind: 'unassigned' } });
    dom = ctx.dom;
    const { doc, stub } = ctx;

    // Main's details name paths, ids and action ids. A detail carrying markup is therefore a
    // realistic payload, and the only honest rendering of it is the literal string.
    const detail = '<img src=x onerror="globalThis.refusalPwned = true"> & <b>bold</b>';
    stub.pushRefusal({
      kind: 'close',
      haltedBy: 'busy',
      summary: '<script>globalThis.refusalPwned = true</script>',
      reasons: [{ code: 'busy', detail, controls: [{ id: 'antifan:workflow:abort', label: '<i>Stop it</i>' }] }],
    });
    await flush();

    const row = reasonRows(doc)[0];
    assert.strictEqual(rowDetail(row), detail, 'the detail is displayed verbatim');
    assert.strictEqual(summaryText(doc), '<script>globalThis.refusalPwned = true</script>');
    assert.deepStrictEqual(rowControls(row), [{ id: 'antifan:workflow:abort', label: '<i>Stop it</i>' }]);
    assert.strictEqual(reasonsEl(doc).querySelector('img, b, i, script'), null, 'no payload became an element');
    assert.strictEqual(ctx.win.eval('typeof globalThis.refusalPwned'), 'undefined', 'no payload ran as script');
  });

  test('dismiss hides the region and clears the rendered reasons', async () => {
    const ctx = await loadToolbar({ owner: { kind: 'unassigned' } });
    dom = ctx.dom;
    const { doc, stub } = ctx;

    stub.pushRefusal(REFUSED_CLOSE);
    await flush();
    assert.strictEqual(reasonRows(doc).length, 2);

    const dismiss = doc.getElementById('closeRefusalDismiss');
    assert.ok(dismiss, 'the region carries a dismiss control');
    (dismiss as HTMLButtonElement).click();

    assert.strictEqual(noticeEl(doc).style.display, 'none', 'dismissing hides the notice');
    assert.strictEqual(reasonsEl(doc).childElementCount, 0, 'dismissing clears the reasons it showed');
    // The region holds nothing the user can read once it is hidden, and the next refusal
    // rebuilds it from its own payload rather than from anything left behind here.
    assert.strictEqual(reasonRows(doc).length, 0);
  });

  test('a later notice replaces the earlier one, so no stale reason survives', async () => {
    const ctx = await loadToolbar({ owner: { kind: 'unassigned' } });
    dom = ctx.dom;
    const { doc, stub } = ctx;

    stub.pushRefusal(REFUSED_CLOSE);
    await flush();
    assert.strictEqual(reasonRows(doc).length, 2);

    stub.pushRefusal(REFUSED_CLOSE_AFTER_RELEASE);
    await flush();

    assert.strictEqual(reasonRows(doc).length, 1, 'the released reason is gone, not appended to');
    assert.strictEqual(summaryText(doc), REFUSED_CLOSE_AFTER_RELEASE.summary, 'the summary is the latest refusal');
    assert.ok(
      !(doc.body.textContent ?? '').includes('2 in-flight operations are admitted on tab-acme-1'),
      'a reason that no longer blocks the close is not still on screen'
    );
    assert.ok(
      (doc.body.textContent ?? '').includes('A verified agent affinity holds tab-acme-2'),
      'the reason that still blocks the close is on screen'
    );
  });

  test('a malformed payload renders nothing and throws nothing', async () => {
    const ctx = await loadToolbar({ owner: { kind: 'unassigned' } });
    dom = ctx.dom;
    const { doc, stub } = ctx;

    // Nothing valid yet: a message that is not a notice must leave the region exactly as it
    // was, and the push itself would throw here if rendering it did.
    for (const payload of [null, undefined, 42, 'refused', {}, { summary: 12, reasons: [] }, { summary: 'x', reasons: 'nope' }, { summary: 'x' }]) {
      stub.pushRefusal(payload);
    }
    await flush();
    assert.strictEqual(noticeEl(doc).style.display, 'none', 'a payload that is not a notice shows nothing');
    assert.strictEqual(reasonsEl(doc).childElementCount, 0);

    // A valid notice on screen is not blanked by a malformed follow-up: the malformed message
    // carries no news, and a region that emptied itself would claim the refusal was resolved.
    stub.pushRefusal(REFUSED_CLOSE);
    await flush();
    stub.pushRefusal({ kind: 'close', summary: 7, reasons: [] });
    stub.pushRefusal('close: refused');
    await flush();

    assert.strictEqual(noticeEl(doc).style.display, 'flex');
    assert.strictEqual(summaryText(doc), REFUSED_CLOSE.summary);
    assert.strictEqual(reasonRows(doc).length, 2);

    // A notice whose reasons are unreadable is still a notice: Main's own summary is what
    // explains the refusal, and the rows it could not read are dropped, never rendered blank.
    stub.pushRefusal({ kind: 'close', haltedBy: 'busy', summary: 'Close refused', reasons: [{ code: 'busy' }, 'nope', null] });
    await flush();

    assert.strictEqual(summaryText(doc), 'Close refused');
    assert.strictEqual(reasonRows(doc).length, 0, 'an unreadable reason contributes no row');
  });
});
