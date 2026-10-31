import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
// @ts-ignore jsdom ships no type declarations (same as menu-depth.test.ts)
import { JSDOM } from 'jsdom';
import {
  buildFieldReadBackScript,
  buildIsolatedExecutorScript,
  buildLocatorResolveScript,
  parseControlStateInput,
  parseElementLocator,
  parseFieldReadBack,
  parseLocatorResolution,
  type ElementLocator,
  type IsolatedExecutorRequest,
} from '../../src/main/browser/semantic-ref-executor';

const PAGE_URL = 'https://shop.example.com/';
const NONCE = 'a1b2c3d4-e5f6-7a8b-9c0d-1e2f3a4b5c6d';

interface Box { x: number; y: number; width: number; height: number }

function load(html: string, boxes: Record<string, Box> = {}) {
  const dom = new JSDOM(html, { url: PAGE_URL, runScripts: 'outside-only', pretendToBeVisual: true });
  const win = dom.window as any;
  // jsdom lays nothing out: every element reports an empty box unless the test gives it one.
  win.Element.prototype.getBoundingClientRect = function (this: Element) {
    const box = (this.id && boxes[this.id]) || { x: 0, y: 0, width: 0, height: 0 };
    return { ...box, left: box.x, top: box.y, right: box.x + box.width, bottom: box.y + box.height, toJSON() { return this; } };
  };
  win.Element.prototype.getClientRects = function (this: Element) {
    const box = (this.id && boxes[this.id]) || undefined;
    return box && box.width > 0 && box.height > 0 ? [this.getBoundingClientRect()] : [];
  };
  return { dom, win, doc: win.document as Document };
}

function run(win: any, script: string): Promise<any> {
  return win.eval(script);
}

function action(extra: Partial<IsolatedExecutorRequest>): IsolatedExecutorRequest {
  return { action: 'click', nonce: NONCE, documentUrl: PAGE_URL, ...extra } as IsolatedExecutorRequest;
}

describe('executor: zero-size targets', () => {
  it('refuses a pointer gesture on a box with no area and names the size', async () => {
    const { win } = load('<button id="ghost">Pay</button>');
    const res = await run(win, buildIsolatedExecutorScript(action({ selector: '#ghost' })));
    assert.equal(res.ok, false);
    assert.equal(res.code, 'TARGET_ZERO_SIZE');
    assert.equal(res.metadata.width, 0);
    assert.equal(res.metadata.height, 0);
    assert.match(res.error, /zero-size/);
    assert.match(res.error, /set_control/);
  });

  it('refuses hover on the same box', async () => {
    const { win } = load('<a id="ghost" href="/x">x</a>');
    const res = await run(win, buildIsolatedExecutorScript(action({ action: 'hover', selector: '#ghost' })));
    assert.equal(res.code, 'TARGET_ZERO_SIZE');
  });

  it('still types into a zero-size field: typing needs focus, not a pointer target', async () => {
    const { win, doc } = load('<input id="otp" type="text">');
    const res = await run(win, buildIsolatedExecutorScript(action({ action: 'type', selector: '#otp', text: '1234', clear: true })));
    assert.equal(res.ok, true, JSON.stringify(res));
    assert.equal((doc.getElementById('otp') as HTMLInputElement).value, '1234');
  });

  it('judges a hidden checkbox by the label that wraps it, not by its own empty box', async () => {
    const { win, doc } = load(
      '<label id="wrap"><input id="agree" type="checkbox" style="position:absolute;width:0;height:0"> I agree</label>',
      { wrap: { x: 10, y: 10, width: 120, height: 24 } }
    );
    const label = doc.getElementById('wrap')!;
    (doc as any).elementsFromPoint = () => [label];
    (doc as any).elementFromPoint = () => label;
    const res = await run(win, buildIsolatedExecutorScript(action({ selector: '#agree' })));
    assert.equal(res.ok, true, JSON.stringify(res));
    assert.notEqual(res.code, 'TARGET_ZERO_SIZE');
    assert.equal((doc.getElementById('agree') as HTMLInputElement).checked, true);
  });

  it('refuses a hidden checkbox that has no label to stand in for it', async () => {
    const { win } = load('<input id="lonely" type="checkbox" style="width:0;height:0">');
    const res = await run(win, buildIsolatedExecutorScript(action({ selector: '#lonely' })));
    assert.equal(res.ok, false);
    assert.equal(res.code, 'TARGET_ZERO_SIZE');
  });

  it('lets force through an empty box: the caller waived the actionability checks', async () => {
    const { win, doc } = load('<button id="ghost">Pay</button>');
    let clicks = 0;
    doc.getElementById('ghost')!.addEventListener('click', () => { clicks++; });
    const res = await run(win, buildIsolatedExecutorScript(action({ selector: '#ghost', force: true })));
    assert.equal(res.ok, true, JSON.stringify(res));
    assert.equal(clicks, 1);
  });

  it('clicks an empty box synthetically when trusted is false, since that click needs no pointer target', async () => {
    const { win, doc } = load('<button id="ghost">Pay</button>');
    let clicks = 0;
    doc.getElementById('ghost')!.addEventListener('click', () => { clicks++; });
    const res = await run(win, buildIsolatedExecutorScript(action({ selector: '#ghost', trusted: false })));
    assert.equal(res.ok, true, JSON.stringify(res));
    assert.equal(clicks, 1);
  });

  it('still refuses the pre-flight of a trusted click on an empty box', async () => {
    const { win } = load('<button id="ghost">Pay</button>');
    const res = await run(win, buildIsolatedExecutorScript(action({ action: 'focus', selector: '#ghost' })));
    assert.equal(res.ok, false);
    assert.equal(res.code, 'TARGET_ZERO_SIZE');
  });
});

describe('executor: control state probe', () => {
  const probe = (win: any, selector: string) =>
    run(win, buildIsolatedExecutorScript(action({ action: 'probe', selector, controlState: true })));

  it('reads a native checkbox without moving the page or needing a laid-out box', async () => {
    const { win } = load('<input id="c" type="checkbox" checked>');
    const res = await probe(win, '#c');
    assert.equal(res.ok, true, JSON.stringify(res));
    assert.equal(res.executed, false);
    assert.equal(res.metadata.controlState.checked, true);
    assert.equal(res.metadata.controlState.kind, 'checkbox');
  });

  it('reads the input a label points at', async () => {
    const { win } = load('<input id="c" type="checkbox"><label id="l" for="c">Subscribe</label>');
    const res = await probe(win, '#l');
    assert.equal(res.ok, true, JSON.stringify(res));
    assert.equal(res.metadata.controlState.checked, false);
  });

  it('reads an ARIA switch and reports a disabled control', async () => {
    const { win } = load('<div id="s" role="switch" aria-checked="true" aria-disabled="true">Dark mode</div>');
    const res = await probe(win, '#s');
    assert.equal(res.ok, true, JSON.stringify(res));
    assert.equal(res.metadata.controlState.checked, true);
    assert.equal(res.metadata.controlState.disabled, true);
  });

  it('answers a plain button with no checked state instead of guessing', async () => {
    const { win } = load('<button id="b">Go</button>');
    const res = await probe(win, '#b');
    assert.equal(res.ok, true, JSON.stringify(res));
    assert.notEqual(typeof res.metadata.controlState.checked, 'boolean');
  });
});

describe('executor: locator resolution', () => {
  const html = `
    <main>
      <button id="a">Add to cart</button>
      <button id="b">Add to cart</button>
      <button id="c">Checkout</button>
      <a id="d" href="/cart">View cart</a>
      <button id="hidden" style="display:none">Secret deal</button>
      <section id="promo"><button id="e">Add to cart</button></section>
      <label for="mail">Email address</label><input id="mail" type="email">
    </main>`;
  const boxes: Record<string, Box> = {};
  for (const [i, id] of ['a', 'b', 'c', 'd', 'e', 'mail', 'promo'].entries()) boxes[id] = { x: 10, y: 10 + i * 40, width: 100, height: 30 };

  const resolve = async (locator: ElementLocator) => {
    const { win } = load(html, boxes);
    return parseLocatorResolution(await run(win, buildLocatorResolveScript(locator, 0)));
  };

  it('reports ambiguity with candidates instead of picking the first match', async () => {
    const res = await resolve({ role: 'button', name: 'Add to cart' });
    assert.equal(res.ok, false);
    if (!res.ok) {
      assert.equal(res.code, 'LOCATOR_AMBIGUOUS');
      assert.equal(res.matchCount, 3);
      assert.ok(res.candidates.length >= 2);
      assert.ok(res.candidates.every((c) => typeof c.index === 'number' && typeof c.tag === 'string'));
    }
  });

  it('resolves a unique role + name to a selector that addresses exactly that element', async () => {
    const { win, doc } = load(html, boxes);
    const res = parseLocatorResolution(await run(win, buildLocatorResolveScript({ role: 'button', name: 'Checkout' }, 0)));
    assert.equal(res.ok, true);
    if (res.ok) {
      assert.equal(res.matchCount, 1);
      const hits = doc.querySelectorAll(res.selector);
      assert.equal(hits.length, 1);
      assert.equal(hits[0]!.id, 'c');
    }
  });

  it('narrows an ambiguous locator with nth and with within', async () => {
    const nth = await resolve({ role: 'button', name: 'Add to cart', nth: 1 });
    assert.equal(nth.ok, true);
    if (nth.ok) assert.equal(nth.index, 1);
    const within = await resolve({ role: 'button', name: 'Add to cart', within: '#promo' });
    assert.equal(within.ok, true);
    if (within.ok) assert.equal(within.matchCount, 1);
  });

  it('reports LOCATOR_NOT_FOUND for an element that is not rendered', async () => {
    const res = await resolve({ role: 'button', name: 'Secret deal' });
    assert.equal(res.ok, false);
    if (!res.ok) assert.equal(res.code, 'LOCATOR_NOT_FOUND');
  });

  it('reports an nth beyond the matches as not found, not as the last match', async () => {
    const res = await resolve({ role: 'button', name: 'Add to cart', nth: 9 });
    assert.equal(res.ok, false);
    if (!res.ok) {
      assert.equal(res.code, 'LOCATOR_NOT_FOUND');
      assert.match(res.error, /out of range/);
    }
  });

  it('resolves a visible-text locator to the smallest element containing it', async () => {
    const res = await resolve({ text: 'View cart' });
    assert.equal(res.ok, true);
    if (res.ok) assert.equal(res.candidate.tag, 'a');
  });

  it('finds a field by its label text through role + name', async () => {
    const res = await resolve({ role: 'textbox', name: 'Email address' });
    assert.equal(res.ok, true, JSON.stringify(res));
  });

  it('rejects malformed locators before any page is touched', () => {
    assert.throws(() => parseElementLocator({ nth: 1 }), /at least one of role, name or text/);
    assert.throws(() => parseElementLocator({ role: 'button', color: 'red' }), /unknown key/);
    assert.throws(() => parseElementLocator({ text: '' }), /non-empty string/);
    assert.throws(() => parseElementLocator({ text: 'x', nth: -1 }), /non-negative/);
    assert.throws(() => parseElementLocator('Checkout'), /must be an object/);
    assert.deepEqual(parseElementLocator({ role: 'Button', name: ' Go ' }), { role: 'button', name: 'Go' });
  });

  it('parses a malformed resolver answer as a failed resolution', () => {
    const res = parseLocatorResolution(undefined);
    assert.equal(res.ok, false);
  });
});

describe('executor: type read-back', () => {
  it('reports verified:true and echoes the field content after a synthetic type', async () => {
    const { win } = load('<input id="q" type="text">');
    const res = await run(win, buildIsolatedExecutorScript(action({ action: 'type', selector: '#q', text: 'hello', clear: true })));
    assert.equal(res.ok, true, JSON.stringify(res));
    assert.equal(res.verified, true);
    assert.equal(res.readBack, 'hello');
  });

  it('reports verified:false with the real content when the page reverts the edit', async () => {
    const { win, doc } = load('<input id="q" type="text">');
    const input = doc.getElementById('q') as HTMLInputElement;
    // A framework that owns the value and rewrites it on every input event.
    input.addEventListener('input', () => {
      setTimeout(() => {
        input.value = 'reverted';
      }, 5);
    });
    const res = await run(win, buildIsolatedExecutorScript(action({ action: 'type', selector: '#q', text: 'hello', clear: true })));
    assert.equal(res.ok, true, JSON.stringify(res));
    assert.equal(res.verified, false);
    assert.equal(res.readBack, 'reverted');
  });

  it('never echoes a password input', async () => {
    const { win } = load('<input id="pw" type="password">');
    const res = await run(win, buildIsolatedExecutorScript(action({ action: 'type', selector: '#pw', text: 'hunter2-secret', clear: true })));
    assert.equal(res.ok, true, JSON.stringify(res));
    assert.equal(res.verified, true);
    assert.equal(res.readBack, undefined);
    assert.equal(JSON.stringify(res).includes('hunter2-secret'), false);
  });

  it('page-side read-back script: focused field is compared, a password is not echoed', async () => {
    const { win, doc } = load('<input id="pw" type="password"><input id="plain" type="text">');
    (doc.getElementById('pw') as HTMLInputElement).value = 'topsecret';
    (doc.getElementById('pw') as HTMLInputElement).focus();
    const secretRes = parseFieldReadBack(await run(win, buildFieldReadBackScript('topsecret', true)));
    assert.equal(secretRes.verified, true);
    assert.equal(secretRes.readBack, undefined);

    (doc.getElementById('plain') as HTMLInputElement).value = 'abc';
    (doc.getElementById('plain') as HTMLInputElement).focus();
    const plainRes = parseFieldReadBack(await run(win, buildFieldReadBackScript('xyz', true)));
    assert.equal(plainRes.verified, false);
    assert.equal(plainRes.readBack, 'abc');
  });

  it('keeps the tail of a long value and flags the cut', async () => {
    const { win, doc } = load('<textarea id="t"></textarea>');
    const ta = doc.getElementById('t') as HTMLTextAreaElement;
    ta.value = `${'a'.repeat(700)}END`;
    ta.focus();
    const res = parseFieldReadBack(await run(win, buildFieldReadBackScript('zzz', false)));
    assert.equal(res.verified, false);
    assert.equal(res.readBackTruncated, true);
    assert.ok(res.readBack!.endsWith('END'));
    assert.equal(res.readBack!.length, 500);
  });

  it('reads as unverifiable when no field has focus', async () => {
    const { win } = load('<p>nothing editable</p>');
    const res = parseFieldReadBack(await run(win, buildFieldReadBackScript('x', true)));
    assert.equal(res.verified, null);
    assert.deepEqual(parseFieldReadBack('garbage'), { verified: null });
  });
});

describe('set_control state words', () => {
  it('maps booleans, 1/0 and words; refuses anything else with the valid words', () => {
    assert.equal(parseControlStateInput(true), true);
    assert.equal(parseControlStateInput(0), false);
    assert.equal(parseControlStateInput('On'), true);
    assert.equal(parseControlStateInput('unchecked'), false);
    assert.throws(() => parseControlStateInput('maybe'), /state must be true or false/);
    assert.throws(() => parseControlStateInput(undefined), /state must be true or false/);
  });
});
