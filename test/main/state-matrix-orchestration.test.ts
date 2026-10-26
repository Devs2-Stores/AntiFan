// Orchestration contract of src/main/qa/state-matrix.ts with scripted fakes. The real in-page
// behaviour (trusted CDP input against fixture overlays) is pinned by
// test/e2e/state-matrix-fixtures-probe.cjs; these tests pin the control flow around it.
import { describe, it } from 'node:test';
import * as assert from 'node:assert';
import * as path from 'node:path';
import { createRequire } from 'node:module';
import { buildDiscoverScript, failureSeverity, runStateMatrix, type StateMatrixDeps } from '../../src/main/qa/state-matrix';

const requireFromHere = createRequire(__filename);

type Step = { kind: 'eval' | 'click' | 'clickAt' | 'hover' | 'hoverAt' | 'key'; detail: string };

function fakeDeps(evalImpl: (script: string) => unknown): { deps: StateMatrixDeps; steps: Step[] } {
  const steps: Step[] = [];
  const ok = async () => ({ ok: true });
  return {
    steps,
    deps: {
      evalJs: async (script) => {
        steps.push({ kind: 'eval', detail: script.slice(0, 80) });
        return evalImpl(script);
      },
      click: async (selector) => { steps.push({ kind: 'click', detail: selector }); return ok(); },
      clickAt: async (x, y) => { steps.push({ kind: 'clickAt', detail: `${x},${y}` }); return ok(); },
      hover: async (selector) => { steps.push({ kind: 'hover', detail: selector }); return ok(); },
      hoverAt: async (x, y) => { steps.push({ kind: 'hoverAt', detail: `${x},${y}` }); return ok(); },
      pressKey: async (key) => { steps.push({ kind: 'key', detail: key }); return ok(); },
      wait: async () => undefined,
    },
  };
}

const isDiscover = (s: string) => s.includes('__antifanStateMatrixGuard') && s.includes('UNSAFE');
const isCleanup = (s: string) => s.includes('delete window.__antifanStateMatrixGuard');
const isMeasureOpen = (s: string) => s.includes('backdropPoint') && s.includes('overflowingChildren');
const isMeasureClosed = (s: string) => s.includes('focusReturned') && !s.includes('backdropPoint');
const isPointSafety = (s: string) => s.includes("reason: 'INSIDE_PANEL'");
const isRestCheck = (s: string) => s.includes('restored: !scrollLocked()');
const isPrepare = (s: string) => s.includes('scrollIntoView');

const openDialog = { opened: true, rect: { x: 900, y: 0, w: 380, h: 800 }, effectiveOpacity: 1, visibility: 'visible', pointerEvents: 'auto', withinViewport: true, clippedByAncestor: false, occluded: false, overflowingChildren: [], scrollLocked: true, focusInside: true, closeControl: 'button.close', backdropPoint: { x: 450, y: 400 }, tooSmall: false };
const notOpened = { opened: false, rect: null, effectiveOpacity: 0, visibility: 'hidden', pointerEvents: 'none', withinViewport: false, clippedByAncestor: false, occluded: false, overflowingChildren: [], scrollLocked: false, focusInside: false, closeControl: null, backdropPoint: null };

describe('state matrix severity', () => {
  it('treats Escape and a close control as hard requirements for dialogs only', () => {
    assert.strictEqual(failureSeverity('CLOSE_ESCAPE_FAILED', 'drawer'), 'critical');
    assert.strictEqual(failureSeverity('CLOSE_ESCAPE_FAILED', 'modal'), 'critical');
    assert.strictEqual(failureSeverity('CLOSE_ESCAPE_FAILED', 'dropdown'), 'warning');
    assert.strictEqual(failureSeverity('CLOSE_CONTROL_MISSING', 'megamenu'), 'warning');
    assert.strictEqual(failureSeverity('SCROLL_NOT_LOCKED', 'drawer'), 'warning');
    assert.strictEqual(failureSeverity('OVERLAY_OFFSCREEN', 'dropdown'), 'critical');
  });
});

describe('state matrix orchestration', () => {
  it('reports an unmeasured run when discovery returns nothing usable', async () => {
    const { deps } = fakeDeps(() => undefined);
    const res = await runStateMatrix(deps);
    assert.strictEqual(res.measured, false);
    assert.strictEqual(res.error, 'DISCOVERY_RETURNED_NO_RESULT');
    assert.strictEqual(res.safeMode, true);
  });

  it('always removes its page markers and guard, even when a measurement throws', async () => {
    let cleaned = false;
    const { deps } = fakeDeps((s) => {
      if (isDiscover(s)) return { ok: true, viewport: { width: 1280, height: 800 }, triggers: [{ index: 0, trigger: 'button.cart', panel: '#cart', kind: 'drawer', label: 'Cart', closeSelector: null }], skipped: [] };
      if (isCleanup(s)) { cleaned = true; return { ok: true }; }
      if (isMeasureOpen(s)) throw new Error('renderer crashed');
      return { ok: true };
    });
    await assert.rejects(runStateMatrix(deps), /renderer crashed/);
    assert.strictEqual(cleaned, true);
  });

  it('stops exercising overlays once one cannot be closed and reports the rest NOT_RUN', async () => {
    const { deps, steps } = fakeDeps((s) => {
      if (isDiscover(s)) {
        return { ok: true, viewport: { width: 1280, height: 800 }, skipped: [], triggers: [
          { index: 0, trigger: 'button.a', panel: '#a', kind: 'modal', label: 'A', closeSelector: null },
          { index: 1, trigger: 'button.b', panel: '#b', kind: 'modal', label: 'B', closeSelector: null },
        ] };
      }
      if (isMeasureOpen(s)) return { opened: true, rect: { x: 100, y: 100, w: 400, h: 300 }, effectiveOpacity: 1, visibility: 'visible', pointerEvents: 'auto', withinViewport: true, clippedByAncestor: false, occluded: false, overflowingChildren: [], scrollLocked: true, focusInside: true, closeControl: 'button.close', backdropPoint: { x: 900, y: 400 }, tooSmall: false };
      if (isMeasureClosed(s)) return { closed: false, bodyRestored: false, focusReturned: false };
      return { ok: true, measured: false };
    });
    const res = await runStateMatrix(deps, { gradeVisualQuality: false });
    const [first, second] = res.triggers;
    assert.ok(first && second);
    assert.strictEqual(first.status, 'FAIL');
    assert.ok(first.failures.some((f) => f.code === 'STATE_STUCK_OPEN'));
    assert.strictEqual(second.status, 'NOT_RUN');
    assert.strictEqual(res.measured, false);
    assert.ok(!steps.some((s) => s.detail.includes('antifan-sm-trigger="1"')), 'the second overlay must never be touched');
  });

  it('does not charge the run-wide close-poll budget for closes that were observed, however slow', async () => {
    // Trigger 0 only reads closed on the 6th read after the close input; the waits between reads are long
    // enough that those polls take 8.5 s in total, more than the whole 8 s budget. Triggers 1 and 2 close on
    // the 3rd read, which needs polling: a budget eaten by trigger 0 would leave them one sample each.
    const closeAtRead = [6, 3, 3];
    let clock = 0;
    let open = -1;
    let reads = 0;
    const { deps } = fakeDeps((s) => {
      if (isDiscover(s)) {
        return { ok: true, viewport: { width: 1280, height: 800 }, skipped: [], triggers: [0, 1, 2].map((i) => ({ index: i, trigger: `button.t${i}`, panel: `#p${i}`, kind: 'modal', label: `T${i}`, closeSelector: null })) };
      }
      if (isMeasureOpen(s)) return openDialog;
      if (isMeasureClosed(s)) {
        reads += 1;
        const closed = reads >= (closeAtRead[open] ?? 1);
        return { closed, bodyRestored: true, focusReturned: true };
      }
      if (s.includes('__antifanSmKey') && !s.includes('addEventListener')) return { seen: true, key: 'Escape', hasFocus: true };
      return { ok: true };
    });
    const baseClick = deps.click;
    deps.click = async (selector) => {
      const m = /antifan-sm-trigger="(\d+)"/.exec(selector);
      if (m) { open = Number(m[1]); reads = 0; }
      return baseClick(selector);
    };
    const basePress = deps.pressKey;
    deps.pressKey = async (key) => { reads = 0; return basePress(key); };
    deps.now = () => clock;
    deps.wait = async () => { clock += 1700; };
    const res = await runStateMatrix(deps, { gradeVisualQuality: false, closeMethods: ['escape'] });
    assert.strictEqual(res.triggers.length, 3);
    for (const t of res.triggers) {
      assert.notStrictEqual(t.status, 'NOT_RUN', `trigger ${t.index} was never exercised`);
      const codes = t.failures.map((f) => f.code);
      assert.ok(!codes.includes('STATE_STUCK_OPEN') && !codes.includes('CLOSE_ESCAPE_FAILED') && !codes.includes('CLOSE_ESCAPE_FLAKY'), `trigger ${t.index}: ${codes.join(',')}`);
      assert.strictEqual(t.closes[0]?.closed, true, `trigger ${t.index} closed`);
    }
  });

  it('closes menus with Escape, then pointer-leave, without demanding a close control', async () => {
    let pointerLeft = false;
    const { deps, steps } = fakeDeps((s) => {
      if (isDiscover(s)) return { ok: true, viewport: { width: 1280, height: 800 }, skipped: [], triggers: [{ index: 0, trigger: 'a.nav', panel: 'div.sub', kind: 'dropdown', label: 'Menu', closeSelector: null }] };
      if (isMeasureOpen(s)) return { opened: true, rect: { x: 0, y: 60, w: 220, h: 160 }, effectiveOpacity: 1, visibility: 'visible', pointerEvents: 'auto', withinViewport: true, clippedByAncestor: false, occluded: false, overflowingChildren: [], scrollLocked: false, focusInside: false, closeControl: null, backdropPoint: { x: 640, y: 500 }, tooSmall: false };
      if (isMeasureClosed(s)) return { closed: pointerLeft, bodyRestored: true, focusReturned: false };
      return { ok: true };
    });
    const realHoverAt = deps.hoverAt;
    deps.hoverAt = async (x, y) => { pointerLeft = true; return realHoverAt(x, y); };
    const res = await runStateMatrix(deps, { gradeVisualQuality: false });
    const t = res.triggers[0];
    assert.ok(t);
    assert.deepStrictEqual(t.closes.map((c) => c.method), ['escape', 'pointer-leave']);
    assert.strictEqual(t.status, 'WARN', 'a menu Escape gap is a warning');
    assert.ok(!t.failures.some((f) => f.code === 'CLOSE_CONTROL_MISSING' || f.code === 'SCROLL_NOT_LOCKED' || f.code === 'FOCUS_NOT_MOVED'));
    assert.ok(steps.some((s) => s.kind === 'hover'), 'menus open by hover first');
  });

  it('never clicks a backdrop point that lands on a control', async () => {
    let open = false;
    const { deps, steps } = fakeDeps((s) => {
      if (isDiscover(s)) return { ok: true, viewport: { width: 1280, height: 800 }, skipped: [], triggers: [{ index: 0, trigger: 'button.cart', panel: '#cart', kind: 'drawer', label: 'Cart', closeSelector: null }] };
      if (isMeasureOpen(s)) { open = true; return openDialog; }
      if (isPointSafety(s)) return { safe: false, reason: 'INTERACTIVE_TARGET', target: 'button.product-buy' };
      if (isMeasureClosed(s)) return { closed: !open, bodyRestored: true, focusReturned: true };
      return { ok: true };
    });
    const realClick = deps.click;
    const realKey = deps.pressKey;
    deps.click = async (sel) => { if (sel.includes('sm-close')) open = false; return realClick(sel); };
    deps.pressKey = async (key) => { open = false; return realKey(key); };
    const res = await runStateMatrix(deps, { gradeVisualQuality: false });
    const t = res.triggers[0]!;
    const backdrop = t.closes.find((c) => c.method === 'backdrop');
    assert.ok(backdrop, 'the backdrop attempt is still reported');
    assert.match(backdrop.skipped || '', /^POINT_UNSAFE: INTERACTIVE_TARGET button\.product-buy/);
    assert.ok(!steps.some((st) => st.kind === 'clickAt'), 'no coordinate click may happen');
    assert.ok(!t.failures.some((f) => f.code === 'CLOSE_BACKDROP_FAILED'), 'a refused point is not a theme defect');
    assert.ok(!t.failures.some((f) => f.code === 'STATE_STUCK_OPEN'), 'the panel is closed the way that already worked');
    assert.strictEqual(steps.filter((st) => st.kind === 'key').length, 2, 'Escape once as a method, once to recover');
  });

  it('runs only the menu close methods the caller allowed', async () => {
    const { deps, steps } = fakeDeps((s) => {
      if (isDiscover(s)) return { ok: true, viewport: { width: 1280, height: 800 }, skipped: [], triggers: [{ index: 0, trigger: 'a.nav', panel: 'div.sub', kind: 'dropdown', label: 'Menu', closeSelector: null }] };
      if (isMeasureOpen(s)) return { ...openDialog, scrollLocked: false, closeControl: null };
      if (isMeasureClosed(s)) return { closed: false, bodyRestored: true, focusReturned: false };
      return { ok: true };
    });
    await runStateMatrix(deps, { gradeVisualQuality: false, closeMethods: ['close-button'] });
    assert.ok(!steps.some((st) => st.kind === 'key'), 'Escape was not allowed');
    assert.ok(!steps.some((st) => st.kind === 'clickAt'), 'an outside click was not allowed');
    assert.ok(steps.some((st) => st.kind === 'hoverAt'), 'the pointer leaving is always tried');
  });

  it('records the at-rest state once per trigger, before the first open', async () => {
    const prepares: string[] = [];
    let open = false;
    const { deps } = fakeDeps((s) => {
      if (isDiscover(s)) return { ok: true, viewport: { width: 1280, height: 800 }, skipped: [], triggers: [{ index: 0, trigger: 'button.cart', panel: '#cart', kind: 'drawer', label: 'Cart', closeSelector: null }] };
      if (isPrepare(s)) { prepares.push(s); return { ok: true, scrollLocked: false }; }
      if (isMeasureOpen(s)) { open = true; return openDialog; }
      if (isPointSafety(s)) return { safe: true, reason: 'OVERLAY', target: 'div.backdrop' };
      if (isMeasureClosed(s)) return { closed: !open, bodyRestored: true, focusReturned: true };
      return { ok: true };
    });
    const realKey = deps.pressKey;
    const realClick = deps.click;
    const realClickAt = deps.clickAt;
    deps.pressKey = async (key) => { open = false; return realKey(key); };
    deps.click = async (sel) => { if (sel.includes('sm-close')) open = false; return realClick(sel); };
    deps.clickAt = async (x, y) => { open = false; return realClickAt(x, y); };
    const res = await runStateMatrix(deps, { gradeVisualQuality: false });
    assert.strictEqual(res.triggers[0]!.status, 'PASS');
    assert.strictEqual(prepares.length, 3, 'one open per close method');
    assert.ok(prepares[0]!.includes('if (true ||'));
    assert.ok(prepares.slice(1).every((p) => p.includes('if (false ||')), 're-opens keep the first baseline');
  });

  it('escapes and stops when a trigger leaves the page locked without a measurable overlay', async () => {
    const { deps, steps } = fakeDeps((s) => {
      if (isDiscover(s)) {
        return { ok: true, viewport: { width: 1280, height: 800 }, skipped: [], triggers: [
          { index: 0, trigger: 'button.mystery', panel: null, kind: 'modal', label: 'Mystery', closeSelector: null },
          { index: 1, trigger: 'button.b', panel: '#b', kind: 'modal', label: 'B', closeSelector: null },
        ] };
      }
      if (isMeasureOpen(s)) return notOpened;
      if (isRestCheck(s)) return { restored: false };
      return { ok: true };
    });
    const res = await runStateMatrix(deps, { gradeVisualQuality: false });
    const [first, second] = res.triggers;
    assert.ok(first && second);
    assert.ok(first.failures.some((f) => f.code === 'OVERLAY_NOT_OPENED'));
    assert.ok(first.failures.some((f) => f.code === 'STATE_STUCK_OPEN'));
    assert.ok(steps.some((st) => st.kind === 'key' && st.detail === 'Escape'));
    assert.strictEqual(second.status, 'NOT_RUN');
  });

  it('moves on after a trigger that opened nothing and left the page at rest', async () => {
    const { deps, steps } = fakeDeps((s) => {
      if (isDiscover(s)) {
        return { ok: true, viewport: { width: 1280, height: 800 }, skipped: [], triggers: [
          { index: 0, trigger: 'button.dead', panel: null, kind: 'modal', label: 'Dead', closeSelector: null },
          { index: 1, trigger: 'button.dead2', panel: null, kind: 'modal', label: 'Dead 2', closeSelector: null },
        ] };
      }
      if (isMeasureOpen(s)) return notOpened;
      if (isRestCheck(s)) return { restored: true };
      return { ok: true };
    });
    const res = await runStateMatrix(deps, { gradeVisualQuality: false });
    assert.deepStrictEqual(res.triggers.map((t) => t.status), ['FAIL', 'FAIL']);
    assert.ok(!res.triggers.some((t) => t.failures.some((f) => f.code === 'STATE_STUCK_OPEN')));
    assert.ok(!steps.some((st) => st.kind === 'key'), 'nothing to escape from');
  });

  it('clamps trigger and settle bounds', async () => {
    let discoverScript = '';
    const { deps } = fakeDeps((s) => {
      if (isDiscover(s)) { discoverScript = s; return { ok: true, viewport: { width: 1, height: 1 }, triggers: [], skipped: [] }; }
      return { ok: true };
    });
    const res = await runStateMatrix(deps, { maxTriggers: 999 });
    assert.ok(discoverScript.includes('const MAX = 12;'));
    assert.strictEqual(res.error, 'NO_OVERLAY_TRIGGERS_FOUND');
  });
});

describe('state matrix trigger wording', () => {
  // The discover script is a plain template literal: a single backslash in a regex there silently
  // becomes a different pattern. Extract the generated literals and run them on real labels.
  const script = buildDiscoverScript([], 8);
  const literal = (name: string): RegExp => {
    const m = script.match(new RegExp(`const ${name} = (\\/.*\\/[a-z]*);`));
    assert.ok(m && m[1], `${name} literal not found in the generated script`);
    return new Function(`return ${m[1]};`)() as RegExp;
  };

  it('never treats store-mutating controls as triggers', () => {
    const unsafe = literal('UNSAFE_TEXT');
    for (const label of ['Thêm Dock Mở Rộng Thunderbolt 4 vào giỏ hàng', 'Thêm Bàn phím cơ vào yêu thích', 'Mua ngay', 'Add Laptop to cart', 'Thanh toán', 'Đặt hàng', 'Xóa', 'Đăng xuất']) {
      assert.ok(unsafe.test(label), `"${label}" must be refused`);
    }
    for (const label of ['Giỏ hàng', 'Mở menu', 'Tìm kiếm', 'Bộ lọc', 'Yêu thích']) {
      assert.ok(!unsafe.test(label), `"${label}" must stay usable`);
    }
  });

  it('recognises ARIA-less overlay openers by their wording', () => {
    const opener = literal('OPENER_WORDS');
    for (const sig of ['pc hd tool pc hd tool cart Giỏ hàng', 'Mở menu', 'Tìm kiếm', 'header search toggle', 'Bộ lọc', 'Xem nhanh']) {
      assert.ok(opener.test(sig), `"${sig}" must be an opener`);
    }
    for (const sig of ['Xem ngay', 'Chuyển đến banner 2', 'Cuộn sang phải']) {
      assert.ok(!opener.test(sig), `"${sig}" must not be an opener`);
    }
  });
});

describe('state matrix product-page openers', () => {
  const script = buildDiscoverScript([], 8, 'pdp');
  const literal = (name: string): RegExp => {
    const m = script.match(new RegExp(`const ${name} = (\\/.*\\/[a-z]*);`));
    assert.ok(m && m[1], `${name} literal not found in the generated script`);
    return new Function(`return ${m[1]};`)() as RegExp;
  };

  it('recognises size-guide, quick-view, share and review openers by their wording', () => {
    const opener = literal('PDP_OPENER_WORDS');
    for (const label of ['Size guide', 'Bảng size', 'Hướng dẫn chọn size', 'Xem nhanh', 'Quick view', 'Share', 'Chia sẻ', 'Đánh giá', 'Reviews']) {
      assert.ok(opener.test(label), `"${label}" must be a product-page opener`);
    }
    for (const label of ['Thêm vào giỏ hàng', 'Add to cart', 'Sharpen', 'Xem ngay']) {
      assert.ok(!opener.test(label), `"${label}" must not be a product-page opener`);
    }
  });

  it('turns the product-page pass on only when asked', async () => {
    assert.ok(buildDiscoverScript([], 8, 'pdp').includes('const PDP = true'));
    assert.ok(buildDiscoverScript([], 8).includes('const PDP = false'));
    let discoverScript = '';
    const { deps } = fakeDeps((s) => {
      if (isDiscover(s)) { discoverScript = s; return { ok: true, viewport: { width: 1, height: 1 }, triggers: [], skipped: [] }; }
      return { ok: true };
    });
    await runStateMatrix(deps, { autoPopulate: 'pdp' });
    assert.ok(discoverScript.includes('const PDP = true'));
  });

  it('skips an in-flow <details> summary but keeps <details> overlays as openers', () => {
    const req = createRequire(__filename);
    const jsdomPath = req.resolve('jsdom', { paths: process.env.ANTIFAN_JSDOM ? [process.env.ANTIFAN_JSDOM, __dirname] : [__dirname] });
    const { JSDOM } = req(jsdomPath) as { JSDOM: new (html: string, opts: Record<string, unknown>) => { window: { eval(code: string): unknown } } };
    const dom = new JSDOM(`<!doctype html><html><body><main>
<details class="acc"><summary class="acc-head">Đánh giá &amp; Hỏi đáp</summary><p>Chưa có đánh giá.</p></details>
<details-modal class="quick"><details><summary class="modal-share">Chia sẻ</summary><div role="dialog">Link</div></details></details-modal>
<details class="pop"><summary class="popover-share">Share</summary><div style="position: absolute">Link</div></details>
<button type="button" class="review-open">Đánh giá</button>
</main></body></html>`, { runScripts: 'outside-only', url: 'https://shop.example.com/products/demo' });
    const res = dom.window.eval(buildDiscoverScript([], 8, 'pdp')) as { triggers: Array<{ trigger: string }>; skipped: Array<{ selector: string }> };
    const seen = [...res.triggers.map((t) => t.trigger), ...res.skipped.map((s) => s.selector)];
    const has = (re: RegExp) => seen.some((s) => re.test(s));
    assert.ok(!has(/acc-head/), `an in-flow accordion summary must not be a candidate: ${JSON.stringify(seen)}`);
    assert.ok(has(/modal-share/), `a details-modal summary must stay a candidate: ${JSON.stringify(seen)}`);
    assert.ok(has(/popover-share/), `a summary with a positioned popover must stay a candidate: ${JSON.stringify(seen)}`);
    assert.ok(has(/review-open/), `the review button must stay a candidate: ${JSON.stringify(seen)}`);
  });

  it('refuses an unknown auto-populate mode', async () => {
    const { deps } = fakeDeps(() => ({ ok: true }));
    await assert.rejects(runStateMatrix(deps, { autoPopulate: 'cart' as never }), /autoPopulate must be "pdp"/);
  });
});

describe('anti.qa.state_matrix advertisement', () => {
  it('is advertised as a non-replayable interactive tool', () => {
    const proxy = requireFromHere(path.resolve(process.cwd(), 'scripts/antifan-omp-mcp.cjs')) as {
      definitions: Array<[string, string, Record<string, any>, string[]]>;
      READ_SAFE_CAPABILITIES: Record<string, boolean>;
    };
    const row = proxy.definitions.find(([name]) => name === 'anti.qa.state_matrix');
    assert.ok(row);
    assert.notStrictEqual(proxy.READ_SAFE_CAPABILITIES['anti.qa.state_matrix'], true);
    assert.deepStrictEqual(row[2].triggers.items.required, ['selector']);
  });
});
