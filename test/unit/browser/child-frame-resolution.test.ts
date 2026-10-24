/**
 * Frame-targeted evaluation picks its frame by URL, frame-tree node id, child-frame index or the
 * selector of the `<iframe>` element; a miss lists every frame so the caller can name one.
 */
import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import { CapabilityError } from '../../../src/shared/control-plane-contracts';
import {
  buildIframeProbeExpression,
  describeFrameCensus,
  normalizeFrameRef,
  readIframeProbe,
  selectChildFrame,
  type FrameLike,
  type IframeElementFacts,
} from '../../../src/main/browser/child-frame-resolution';

const root: FrameLike = { frameTreeNodeId: 1, url: 'https://shop.example/', name: '' };
const launcher: FrameLike = { frameTreeNodeId: 11, url: 'https://apps.example/launcher:inline?x=1', name: 'launcher' };
const widgetA: FrameLike = { frameTreeNodeId: 12, url: 'https://apps.example/widget', name: '' };
const widgetB: FrameLike = { frameTreeNodeId: 13, url: 'https://apps.example/widget#second', name: '' };
const blank: FrameLike = { frameTreeNodeId: 14, url: 'about:blank', name: '' };
const frames = [root, launcher, widgetA, widgetB, blank];

const select = (ref: unknown, facts?: IframeElementFacts) => selectChildFrame(root, frames, normalizeFrameRef(ref), 'tab-9', facts);
const code = (fn: () => unknown): string | undefined => {
  try { fn(); } catch (err) { return err instanceof CapabilityError ? err.code : 'other'; }
  return undefined;
};

describe('normalizeFrameRef', () => {
  it('a string is a URL substring', () => {
    assert.deepEqual(normalizeFrameRef('launcher'), { kind: 'url', frameUrl: 'launcher' });
  });

  it('the most specific identity wins when several are given', () => {
    assert.deepEqual(normalizeFrameRef({ frameUrl: 'a', selector: '#f', index: 2, frameId: 12 }), { kind: 'frameId', frameId: 12 });
    assert.deepEqual(normalizeFrameRef({ frameUrl: 'a', selector: '#f', index: 2 }), { kind: 'index', index: 2 });
    assert.deepEqual(normalizeFrameRef({ frameUrl: 'a', selector: '#f' }), { kind: 'selector', selector: '#f' });
    assert.deepEqual(normalizeFrameRef({ frameUrl: 'a' }), { kind: 'url', frameUrl: 'a' });
    assert.deepEqual(normalizeFrameRef({ index: 0 }), { kind: 'index', index: 0 });
  });

  it('an empty or malformed reference is INVALID_ARGUMENT', () => {
    assert.equal(code(() => normalizeFrameRef('  ')), 'INVALID_ARGUMENT');
    assert.equal(code(() => normalizeFrameRef({})), 'INVALID_ARGUMENT');
    assert.equal(code(() => normalizeFrameRef(undefined)), 'INVALID_ARGUMENT');
    assert.equal(code(() => normalizeFrameRef({ frameId: -3 })), 'INVALID_ARGUMENT');
    assert.equal(code(() => normalizeFrameRef({ index: 1.5 })), 'INVALID_ARGUMENT');
  });
});

describe('selectChildFrame', () => {
  it('by URL substring, case-insensitively, never the top frame', () => {
    assert.equal(select('LAUNCHER:inline'), launcher);
    assert.equal(code(() => select({ frameUrl: 'shop.example' })), 'SELECTOR_NOT_FOUND', 'a URL only the top frame has is a miss');
  });

  it('by frame-tree node id', () => {
    assert.equal(select({ frameId: 13 }), widgetB);
    assert.equal(code(() => select({ frameId: 1 })), 'SELECTOR_NOT_FOUND', 'the top frame id is not a child frame');
  });

  it('by index among child frames, the top frame not counted', () => {
    assert.equal(select({ index: 0 }), launcher);
    assert.equal(select({ index: 3 }), blank);
    assert.equal(code(() => select({ index: 4 })), 'SELECTOR_NOT_FOUND');
  });

  it('by selector: the iframe name first', () => {
    assert.equal(select({ selector: '#app' }, { src: '', name: 'launcher', domIndex: 0, sameSrcOrdinal: 0 }), launcher);
  });

  it('by selector: the committed URL, the occurrence among same-src iframes disambiguating repeats', () => {
    const facts = (sameSrcOrdinal: number): IframeElementFacts => ({ src: 'https://apps.example/widget', name: '', domIndex: 1 + sameSrcOrdinal, sameSrcOrdinal });
    // widgetB's URL only differs by the hash, which is not part of frame identity.
    assert.equal(select({ selector: 'iframe.widget' }, facts(0)), widgetA);
    assert.equal(select({ selector: 'iframe.widget' }, facts(1)), widgetB);
  });

  it('by selector: a src-less frame is found by its place in the document', () => {
    assert.equal(select({ selector: 'iframe[srcdoc]' }, { src: '', name: '', domIndex: 3, sameSrcOrdinal: 0 }), blank);
  });

  it('a miss lists every frame with its index, id, name and URL', () => {
    try {
      select('nothing-matches');
      assert.fail('must throw');
    } catch (err) {
      assert.ok(err instanceof CapabilityError);
      assert.equal(err.code, 'SELECTOR_NOT_FOUND');
      assert.match(err.message, /"nothing-matches"/);
      assert.match(err.message, /top@1=https:\/\/shop\.example\//);
      assert.match(err.message, /child#0@11 name="launcher"=https:\/\/apps\.example\/launcher:inline/);
      assert.match(err.message, /child#3@14=about:blank/);
    }
  });

  it('census of a tab with no frames says so', () => {
    assert.equal(describeFrameCensus(null, []), '(none)');
  });
});

describe('iframe probe', () => {
  type FakeEl = { tagName: string; src?: string; name?: string; getAttribute: (n: string) => string | null };
  const frameEl = (src: string, name: string): FakeEl => ({ tagName: 'IFRAME', src, name, getAttribute: (n) => (n === 'name' ? name : null) });
  const runProbe = (selector: string, bySelector: Record<string, FakeEl | 'throws'>, all: FakeEl[]): unknown => {
    const document = {
      querySelector: (s: string) => {
        const hit = bySelector[s];
        if (hit === 'throws') throw new Error(`'${s}' is not a valid selector`);
        return hit ?? null;
      },
      querySelectorAll: () => all,
    };
    return new Function('document', `return ${buildIframeProbeExpression(selector)};`)(document);
  };

  it('reads src, name, DOM index and the same-src ordinal of the matched iframe', () => {
    const a = frameEl('https://apps.example/widget', '');
    const b = frameEl('https://apps.example/widget', 'second');
    const other = frameEl('https://apps.example/other', '');
    const facts = readIframeProbe('iframe.w', 'tab-9', runProbe('iframe.w', { 'iframe.w': b }, [other, a, b]));
    assert.deepEqual(facts, { src: 'https://apps.example/widget', name: 'second', domIndex: 2, sameSrcOrdinal: 1 });
  });

  it('typed refusals: invalid selector, no match, not an iframe', () => {
    const refusal = (selector: string, raw: unknown) => {
      try { readIframeProbe(selector, 'tab-9', raw); } catch (err) { return err as CapabilityError; }
      return undefined;
    };
    const invalid = refusal('a[', runProbe('a[', { 'a[': 'throws' }, []));
    assert.equal(invalid?.code, 'INVALID_SELECTOR');
    const missing = refusal('#nope', runProbe('#nope', {}, []));
    assert.equal(missing?.code, 'SELECTOR_NOT_FOUND');
    const notFrame = refusal('#div', runProbe('#div', { '#div': { tagName: 'DIV', getAttribute: () => null } }, []));
    assert.equal(notFrame?.code, 'SELECTOR_NOT_FOUND');
    assert.match(notFrame?.message ?? '', /<div>, not an <iframe>/);
    assert.equal(refusal('#x', undefined)?.code, 'SELECTOR_NOT_FOUND');
  });
});
