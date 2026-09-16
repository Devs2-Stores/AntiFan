import { describe, it } from 'node:test';
import * as assert from 'node:assert';
import * as vm from 'node:vm';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createRequire } from 'node:module';
import {
  ELEMENT_PICKER_SCRIPT,
  computeRelativeSubselectorTS,
  resolveRobustElementIdentityTS,
  extractSourceHintsTS,
} from '../../src/main/browser/element-picker';
import { AnnotationManager } from '../../src/main/bridge/annotation-manager';

interface JsdomLike {
  window: Window & typeof globalThis & { eval: (src: string) => unknown; __antifanPickerCleanup?: () => void };
}

type JsdomCtor = new (html: string, options?: Record<string, unknown>) => JsdomLike;

/**
 * jsdom is a transitive dep; when the shared node_modules copy is broken the
 * test honors ANTIFAN_JSDOM (a dir containing node_modules/jsdom) and skips
 * with the resolution error as the named blocker.
 */
function loadJsdom(): { JSDOM?: JsdomCtor; error?: string } {
  const req = createRequire(__filename);
  const searchPaths = process.env.ANTIFAN_JSDOM
    ? [process.env.ANTIFAN_JSDOM, path.dirname(__filename)]
    : [path.dirname(__filename)];
  try {
    const resolved = req.resolve('jsdom', { paths: searchPaths });
    // jsdom ships no bundled types; the parsed module is asserted to its documented export shape.
    const jsdomModule = req(resolved) as unknown as { JSDOM: JsdomCtor };
    return { JSDOM: jsdomModule.JSDOM };
  } catch (err) {
    return { error: String(err instanceof Error ? err.message : err) };
  }
}

class MockDOMElement {
  public tagName: string;
  public id: string;
  public className: string;
  public classList: string[];
  public attributes: Record<string, string>;
  public children: MockDOMElement[];
  public parentElement: MockDOMElement | null;
  public textContent: string;

  constructor(tag: string, attrs: Record<string, string> = {}, className = '') {
    this.tagName = tag.toUpperCase();
    this.id = attrs.id || '';
    this.className = className;
    this.classList = className ? className.split(/\s+/).filter(Boolean) : [];
    this.attributes = { ...attrs };
    this.children = [];
    this.parentElement = null;
    this.textContent = '';
  }

  public get nodeType() {
    return 1;
  }

  public getAttribute(name: string): string | null {
    return this.attributes[name] ?? (name === 'id' ? this.id : null);
  }

  public setAttribute(name: string, value: string): void {
    this.attributes[name] = value;
    if (name === 'id') this.id = value;
  }

  public appendChild(child: MockDOMElement): MockDOMElement {
    child.parentElement = this;
    this.children.push(child);
    return child;
  }

  public closest(selector: string): MockDOMElement | null {
    let curr: MockDOMElement | null = this;
    while (curr) {
      if (curr.matchesSelector(selector)) return curr;
      curr = curr.parentElement;
    }
    return null;
  }

  public querySelectorAll(selector: string): MockDOMElement[] {
    const results: MockDOMElement[] = [];
    const checkNode = (node: MockDOMElement) => {
      for (const child of node.children) {
        if (child.matchesSelector(selector)) {
          results.push(child);
        }
        checkNode(child);
      }
    };
    checkNode(this);
    return results;
  }

  public matchesSelector(selector: string): boolean {
    const s = selector.trim();
    if (!s) return false;

    // 1. Comma list
    if (s.includes(',')) {
      return s.split(',').some((sub) => this.matchesSelector(sub.trim()));
    }

    // 2. Direct Child combinator 'A > B'
    if (s.includes(' > ')) {
      const parts = s.split(' > ');
      const targetPart = parts[parts.length - 1] || '';
      const parentPart = parts.slice(0, -1).join(' > ');
      if (!this.matchesSingleSimpleSelector(targetPart)) return false;
      return this.parentElement ? this.parentElement.matchesSelector(parentPart) : false;
    }

    // 3. Descendant combinator 'A B'
    if (s.includes(' ')) {
      const parts = s.split(/\s+/);
      const targetPart = parts[parts.length - 1] || '';
      const ancestorPart = parts.slice(0, -1).join(' ');
      if (!this.matchesSingleSimpleSelector(targetPart)) return false;
      let curr = this.parentElement;
      while (curr) {
        if (curr.matchesSelector(ancestorPart)) return true;
        curr = curr.parentElement;
      }
      return false;
    }

    return this.matchesSingleSimpleSelector(s);
  }

  private matchesSingleSimpleSelector(s: string): boolean {
    let clean = s.trim();
    if (!clean) return false;

    // Check :nth-of-type(N)
    const nthMatch = clean.match(/:nth-of-type\((\d+)\)$/);
    if (nthMatch) {
      const expectedIdx = parseInt(nthMatch[1] || '1', 10);
      clean = clean.replace(/:nth-of-type\(\d+\)$/, '');
      if (this.parentElement) {
        const siblings = this.parentElement.children.filter((c) => c.tagName.toLowerCase() === this.tagName.toLowerCase());
        const actualIdx = siblings.indexOf(this) + 1;
        if (actualIdx !== expectedIdx) return false;
      }
      if (!clean) return true;
    }

    // Class selector .foo
    if (clean.startsWith('.')) {
      const cls = clean.slice(1);
      return this.classList.includes(cls);
    }

    // ID selector #foo
    if (clean.startsWith('#')) {
      const id = clean.slice(1);
      return this.id === id;
    }

    // Tag with attribute (e.g. section[id^="shopify-section-"] or div[data-product-id="101"])
    if (/^[a-zA-Z0-9_-]+\[.+\]$/.test(clean)) {
      const tag = clean.split('[')[0] || '';
      const attrPart = '[' + clean.split('[').slice(1).join('[');
      return this.tagName.toLowerCase() === tag.toLowerCase() && this.matchesSingleSimpleSelector(attrPart);
    }

    // Tag with class (e.g. span.product-price--sale)
    if (/^[a-zA-Z0-9_-]+\.[a-zA-Z0-9_-]+$/.test(clean)) {
      const [tag, cls] = clean.split('.');
      return this.tagName.toLowerCase() === (tag || '').toLowerCase() && this.classList.includes(cls || '');
    }

    // Attribute selectors
    if (clean.startsWith('[') && clean.endsWith(']')) {
      const inside = clean.slice(1, -1);
      if (inside.includes('^=')) {
        const eqIdx = inside.indexOf('^=');
        const attrName = inside.slice(0, eqIdx).trim();
        let rawVal = inside.slice(eqIdx + 2).trim();
        if (rawVal.startsWith('"') && rawVal.endsWith('"')) {
          rawVal = rawVal.slice(1, -1).replace(/\\"/g, '"').replace(/\\\\/g, '\\').replace(/\\n/g, '\n').replace(/\\r/g, '\r');
        }
        const actualVal = this.getAttribute(attrName) || '';
        return actualVal.startsWith(rawVal);
      }
      if (inside.includes('=')) {
        const eqIdx = inside.indexOf('=');
        const attrName = inside.slice(0, eqIdx).trim();
        let rawVal = inside.slice(eqIdx + 1).trim();
        if (rawVal.startsWith('"') && rawVal.endsWith('"')) {
          rawVal = rawVal.slice(1, -1).replace(/\\"/g, '"').replace(/\\\\/g, '\\').replace(/\\n/g, '\n').replace(/\\r/g, '\r');
        } else if (rawVal.startsWith("'") && rawVal.endsWith("'")) {
          rawVal = rawVal.slice(1, -1).replace(/\\'/g, "'").replace(/\\\\/g, '\\');
        }
        return this.getAttribute(attrName) === rawVal;
      }
      return this.getAttribute(inside) !== null;
    }

    return this.tagName.toLowerCase() === clean.toLowerCase();
  }
}

class MockDocument {
  public body: MockDOMElement;
  constructor() {
    this.body = new MockDOMElement('body');
  }
  public querySelectorAll(selector: string): MockDOMElement[] {
    const res: MockDOMElement[] = [];
    if (this.body.matchesSelector(selector)) res.push(this.body);
    return res.concat(this.body.querySelectorAll(selector));
  }
}

describe('Element Picker Resolution & Artifact Upgrades', () => {
  it('validates syntax and key functions of ELEMENT_PICKER_SCRIPT', () => {
    assert.doesNotThrow(() => {
      new vm.Script(ELEMENT_PICKER_SCRIPT);
    });
    assert.ok(ELEMENT_PICKER_SCRIPT.includes('resolveRobustElementIdentity'));
    assert.ok(ELEMENT_PICKER_SCRIPT.includes('computeRelativeSubselector'));
    assert.ok(ELEMENT_PICKER_SCRIPT.includes('extractSourceHints'));
    assert.ok(ELEMENT_PICKER_SCRIPT.includes('extractBoxModel'));
    assert.ok(ELEMENT_PICKER_SCRIPT.includes('extractParentLayout'));
    assert.ok(ELEMENT_PICKER_SCRIPT.includes('extractSiblingSemantics'));
  });

  it('Case 1: Slick/Swiper Carousel Cloned Node correctly resolves canonical non-clone target', () => {
    const doc = new MockDocument();
    const section = new MockDOMElement('section', { id: 'shopify-section-featured-collection' });
    doc.body.appendChild(section);

    const track = new MockDOMElement('div', {}, 'slick-track');
    section.appendChild(track);

    // Slide 1: Original non-cloned slide
    const slideOriginal = new MockDOMElement('div', { 'data-product-id': '101' }, 'slick-slide');
    const priceOriginal = new MockDOMElement('span', {}, 'product-price--sale');
    priceOriginal.textContent = '100.000₫';
    slideOriginal.appendChild(priceOriginal);
    track.appendChild(slideOriginal);

    // Slide 2: Cloned slide (infinite loop duplicate)
    const slideCloned = new MockDOMElement('div', { 'data-product-id': '101' }, 'slick-slide slick-cloned');
    const priceCloned = new MockDOMElement('span', {}, 'product-price--sale');
    priceCloned.textContent = '100.000₫';
    slideCloned.appendChild(priceCloned);
    track.appendChild(slideCloned);

    // User clicks on priceCloned in cloned slide
    const result = resolveRobustElementIdentityTS(priceCloned, doc);

    assert.strictEqual(result.isClone, true, 'Must detect ancestor is a cloned slide');
    assert.strictEqual(result.canonicalEvidence.isClone, true);
    assert.strictEqual(result.canonicalEvidence.ownerKey, 'data-product-id');
    assert.strictEqual(result.canonicalEvidence.ownerValue, '101');
    assert.strictEqual(result.canonicalEvidence.relativeSubSelector, '.product-price--sale');
    assert.strictEqual(result.canonicalEvidence.canonicalMatchCount, 1, 'Exactly 1 non-clone owner in section');
    assert.strictEqual(result.canonicalEvidence.canonicalFound, true, 'Must find canonical non-clone');
    assert.strictEqual(result.canonicalEvidence.isUniqueCanonicalTarget, true);

    // Strict Serialization & No DOM Node Reference Invariant Check
    assert.doesNotThrow(() => {
      const serialized = JSON.stringify(result);
      const parsed = JSON.parse(serialized);
      assert.strictEqual(parsed.canonicalEvidence.isClone, true);
      assert.strictEqual(parsed.canonicalEvidence.ownerKey, 'data-product-id');
      assert.strictEqual(parsed.canonicalEvidence.nodeType, undefined);
      assert.strictEqual(parsed.canonicalEvidence.parentElement, undefined);
      assert.strictEqual(parsed.canonicalEvidence.children, undefined);
      assert.strictEqual(parsed.nodeType, undefined);
      assert.strictEqual(parsed.parentElement, undefined);
    }, 'Result must be 100% JSON-serializable with no DOM node references');
  });
  it('Case 2: Multi-section duplicate business keys are strictly scoped to enclosing section', () => {
    const doc = new MockDocument();

    // Section A: Featured
    const sectionA = new MockDOMElement('section', { id: 'shopify-section-featured' });
    const cardA = new MockDOMElement('div', { 'data-product-id': '101' }, 'product-card');
    const priceA = new MockDOMElement('span', {}, 'price');
    cardA.appendChild(priceA);
    sectionA.appendChild(cardA);
    doc.body.appendChild(sectionA);

    // Section B: Recently Viewed with SAME data-product-id
    const sectionB = new MockDOMElement('section', { id: 'shopify-section-recent' });
    const cardB = new MockDOMElement('div', { 'data-product-id': '101' }, 'product-card');
    const priceB = new MockDOMElement('span', {}, 'price');
    cardB.appendChild(priceB);
    sectionB.appendChild(cardB);
    doc.body.appendChild(sectionB);

    const resultA = resolveRobustElementIdentityTS(priceA, doc);
    assert.ok(resultA.primarySelector.includes('#shopify-section-featured'), 'Must scope to section A');
    assert.strictEqual(resultA.sectionId, 'shopify-section-featured');

    const resultB = resolveRobustElementIdentityTS(priceB, doc);
    assert.ok(resultB.primarySelector.includes('#shopify-section-recent'), 'Must scope to section B');
    assert.strictEqual(resultB.sectionId, 'shopify-section-recent');
  });

  it('Case 3: Unstable structural fallback flags indexStability as unstable-on-rerender', () => {
    const owner = new MockDOMElement('div', { 'data-block-id': 'block-99' });
    const child1 = new MockDOMElement('p');
    const child2 = new MockDOMElement('p'); // Target with no unique class
    owner.appendChild(child1);
    owner.appendChild(child2);

    const sub = computeRelativeSubselectorTS(owner, child2);
    assert.strictEqual(sub.stability, 'unstable-structural-fallback');
    assert.strictEqual(sub.isStructuralFallback, true);
    assert.strictEqual(sub.subselector, 'p:nth-of-type(2)');

    // Verify that the faithful querySelectorAll matches child2 using 'p:nth-of-type(2)'
    const matched = owner.querySelectorAll(sub.subselector);
    assert.strictEqual(matched.length, 1);
    assert.strictEqual(matched[0], child2, 'Selector must faithfully match child2 in real hierarchy');

    // Serialization check
    assert.doesNotThrow(() => {
      JSON.stringify(sub);
    });
  });
  it('extractSourceHintsTS correctly extracts Liquid section and Astro source signals', () => {
    const sec = new MockDOMElement('section', {
      id: 'shopify-section-header',
      'data-section-id': 'header',
      'data-section-type': 'header-section',
    });
    const el = new MockDOMElement('div', {
      'data-source-line': '42',
      'data-astro-source-file': 'src/components/Header.astro',
    });
    sec.appendChild(el);

    const hints = extractSourceHintsTS(el);
    assert.strictEqual(hints.framework, 'astro');
    assert.strictEqual(hints.confidence, 'high');
    assert.strictEqual(hints.suggestedFile, 'src/components/Header.astro');
    assert.strictEqual(hints.suggestedLine, 42);
    assert.ok(hints.signals.length >= 3);
  });

  it('extractSourceHintsTS accurately detects React Fiber debug source, Vue scoped CSS, and Svelte signals', () => {
    // React Fiber mock
    const reactEl = new MockDOMElement('button', {});
    (reactEl as any).__reactFiber$test = {
      _debugSource: { fileName: 'src/components/CheckoutButton.tsx', lineNumber: 88 },
      _debugOwner: { type: { name: 'CheckoutButton' } },
    };
    const reactHints = extractSourceHintsTS(reactEl);
    assert.strictEqual(reactHints.framework, 'react');
    assert.strictEqual(reactHints.suggestedFile, 'src/components/CheckoutButton.tsx');
    assert.strictEqual(reactHints.suggestedLine, 88);
    assert.strictEqual(reactHints.suggestedComponent, 'CheckoutButton');

    // Vue Scoped CSS mock
    const vueEl = new MockDOMElement('div', { 'data-v-7ba5bd90': '' });
    const vueHints = extractSourceHintsTS(vueEl);
    assert.strictEqual(vueHints.framework, 'vue');
    assert.strictEqual(vueHints.confidence, 'high');

    // Svelte mock
    const svelteEl = new MockDOMElement('div', {}, 'svelte-1t7g34s card-container');
    const svelteHints = extractSourceHintsTS(svelteEl);
    assert.strictEqual(svelteHints.framework, 'svelte');
    assert.strictEqual(svelteHints.confidence, 'high');
  });

  it('escapeCSS and resolveRobustElementIdentity correctly escape quotes and special characters in attributes', () => {
    const doc = new MockDocument();
    const sec = new MockDOMElement('section', { id: 'section-test' });
    const item = new MockDOMElement('div', { 'data-variant-id': '101"special\\val' }, 'target-item');
    sec.appendChild(item);
    doc.body.appendChild(sec);

    const result = resolveRobustElementIdentityTS(item, doc);
    assert.ok(result.primarySelector.includes('[data-variant-id="101\\"special\\\\val"]'));
    assert.strictEqual(result.isUnique, true);

    const matches = doc.querySelectorAll(result.primarySelector);
    assert.strictEqual(matches.length, 1);
    assert.strictEqual(matches[0], item, 'querySelectorAll with escaped attribute selector must faithfully match the target item');

    assert.doesNotThrow(() => {
      JSON.stringify(result);
    });
  });

  it('AnnotationManager generates enriched markdown artifact with relative snapshot paths, identity details, and sibling semantics', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'antifan-test-'));
    const manager = AnnotationManager.getInstance();

    const payload = {
      workspaceDir: tempDir,
      url: 'https://myshop.com/products/t-shirt',
      title: 'T-Shirt Demo',
      selector: '#shopify-section-featured-collection [data-product-id="101"] .product-price--sale',
      tagName: 'span',
      dimensions: '108 x 24 px',
      userComment: 'Change price color to red-500 and font-weight to bold',
      isUnique: true,
      isClone: false,
      boxModel: {
        margin: '0px 0px 8px 0px',
        border: '0px none rgb(34, 34, 34)',
        padding: '2px 6px 2px 6px',
        boxSizing: 'border-box',
        contentWidth: 96,
        contentHeight: 20,
      },
      parentLayout: {
        parentTag: 'div',
        parentClasses: ['product-card__price-wrapper'],
        display: 'flex',
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'flex-start',
        gap: '8px',
      },
      siblingSemantics: [
        { tag: 'span', role: 'text', textSnippet: 'Original Price: $20', isTarget: false },
        { tag: 'span', role: 'text', textSnippet: 'Sale Price: $15', isTarget: true },
      ],
      sourceHints: {
        framework: 'liquid',
        confidence: 'high',
        signals: [
          { type: 'liquid-section', name: 'sectionId', value: 'featured-collection', confidence: 'high' },
        ],
      },
      targetImageBase64: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
    };

    const res = await manager.processAnnotationPayload(payload);
    assert.strictEqual(res.ok, true);
    assert.ok(fs.existsSync(res.markdownPath));

    const content = fs.readFileSync(res.markdownPath, 'utf8');
    // Verify critical sections
    // Bumped with AGENT_CONTRACT_VERSION 3.3.0-lean -> 3.4.0-lean
    assert.ok(content.includes('contract_version: "3.4.0-lean"'));
    assert.ok(content.length < 7500, `Markdown content size (${content.length} chars) should be lean (< 7.5KB / ~1,500 tokens)`);
    assert.ok(content.includes('## Fable-Thinking Invariant Ledger & Safety Boundaries'));
    assert.ok(content.includes('PRESERVES'));
    assert.ok(content.includes('DELIBERATELY CHANGES'));
    assert.ok(content.includes('## 🎯 Element Identity & Target Resolution'));
    assert.ok(content.includes('## 📐 Layout & Box Model Metrics'));
    assert.ok(content.includes('## 🧱 Parent Layout Context'));
    assert.ok(content.includes('## 👯 Sibling & Context Semantics'));
    assert.ok(content.includes('Sale Price: $15'));
    assert.ok(content.includes('[TARGET]'));
    assert.ok(content.includes('## 📍 Source Ownership & AST Code Locators'));
    assert.ok(content.includes('![Target element](../snapshots/'));
    assert.ok(content.includes('Change price color to red-500'));
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch {}
  });
  it('AnnotationManager filters computedStyles to ACTIVE_CSS_PROPERTIES whitelist and includes diagnostics when present', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'antifan-test-diag-'));
    const manager = AnnotationManager.getInstance();

    const payload = {
      workspaceDir: tempDir,
      url: 'https://myshop.com/products/t-shirt',
      selector: 'button.btn-checkout',
      tagName: 'button',
      dimensions: '200 x 44 px',
      userComment: 'Fix broken checkout button',
      computedStyles: {
        'display': 'flex',
        'background-color': 'rgb(255, 0, 0)',
        'color': 'rgb(255, 255, 255)',
        'ruby-align': 'auto',
        'mask-type': 'luminance',
      },
      runtimeErrors: [
        { message: 'Uncaught TypeError: Cannot read properties of undefined', source: 'checkout.js:55' },
      ],
      resourceFailures: [
        { url: 'https://myshop.com/assets/checkout.js', error: 'net::ERR_FILE_NOT_FOUND', code: -6 },
      ],
    };

    const res = await manager.processAnnotationPayload(payload);
    assert.strictEqual(res.ok, true);
    const content = fs.readFileSync(res.markdownPath, 'utf8');

    assert.ok(content.includes('display: flex;'));
    assert.ok(content.includes('background-color: rgb(255, 0, 0);'));
    assert.ok(!content.includes('ruby-align'));
    assert.ok(!content.includes('mask-type'));
    assert.ok(content.includes('## ⚠️ Correlated Runtime Diagnostics'));
    assert.ok(content.includes('Cannot read properties of undefined'));
    assert.ok(content.includes('net::ERR_FILE_NOT_FOUND'));

    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch {}
  });
  it('AnnotationManager cleanly formats structured boxModel and parentLayout objects without [object Object]', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'antifan-test-boxmodel-'));
    const manager = AnnotationManager.getInstance();

    const payload = {
      workspaceDir: tempDir,
      url: 'https://myshop.com/products/t-shirt',
      selector: '.product-summary',
      tagName: 'div',
      dimensions: '300 x 200 px',
      userComment: 'Check summary box model',
      boxModel: {
        boxSizing: 'border-box',
        margin: { top: 10, right: 20, bottom: 10, left: 20 },
        border: { top: 1, right: 1, bottom: 1, left: 1 },
        padding: { top: 15, right: 15, bottom: 15, left: 15 },
        content: { width: 268, height: 168 },
      },
      parentLayout: {
        tag: 'section',
        classes: ['product-layout'],
        display: 'flex',
        flexDirection: 'column',
        gap: '12px',
      },
      targetImageBase64: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
    };

    const res = await manager.processAnnotationPayload(payload as any);
    assert.strictEqual(res.ok, true);
    const content = fs.readFileSync(res.markdownPath, 'utf8');

    assert.ok(!content.includes('[object Object]'), 'Markdown must NEVER contain [object Object]');
    assert.ok(!content.includes('undefined x undefined'), 'Markdown must not contain undefined dimensions');
    assert.ok(content.includes('Margin: `10px 20px`'));
    assert.ok(content.includes('Border: `1px`'));
    assert.ok(content.includes('Padding: `15px`'));
    assert.ok(content.includes('Content Size: `268 x 168 px`'));
    assert.ok(content.includes('Parent Tag: `section`'));
    assert.ok(!content.includes('Parent Tag: `unknown`'));

    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch {}
  });



  it('ELEMENT_PICKER_SCRIPT executes cleanly without reference errors', () => {
    assert.doesNotThrow(() => {
      new Function(ELEMENT_PICKER_SCRIPT);
    });
    assert.ok(ELEMENT_PICKER_SCRIPT.includes('antifan-comment-modal'));
    assert.ok(ELEMENT_PICKER_SCRIPT.includes('selectorName'));
    assert.ok(ELEMENT_PICKER_SCRIPT.includes('repositionModal'));
    assert.ok(ELEMENT_PICKER_SCRIPT.includes('max-height:calc(100vh - 20px)'));
  });

  it('an oversized class-matched wrapper cannot swallow picking of its children', async (t) => {
    const { JSDOM, error } = loadJsdom();
    if (!JSDOM) {
      t.skip(`jsdom unavailable: ${error}`);
      return;
    }
    const dom = new JSDOM('<!doctype html><html><body></body></html>', {
      runScripts: 'outside-only',
      url: 'https://m-n-bakery.myharavan.com/collections/original-collection',
    });
    const win = dom.window;
    const doc = win.document;

    // jsdom has no layout engine: every element needs an explicit client rect and
    // the z-order stack returned by point hit-testing is configured per case.
    const stubRect = (el: Element, left: number, top: number, width: number, height: number): void => {
      el.getBoundingClientRect = () => ({ x: left, y: top, width, height, top, right: left + width, bottom: top + height, left, toJSON: () => ({}) });
    };

    // Live m-n-bakery shape: div.mn-home__nav-area spans the page and its class
    // merely contains the `nav-` token, which used to classify it as a micro target.
    const wrapper = doc.createElement('div');
    wrapper.className = 'mn-home__nav-area';
    doc.body.appendChild(wrapper);
    stubRect(wrapper, 0, 0, 1588, 3140);

    const child = doc.createElement('a');
    child.className = 'product-card__title';
    child.textContent = 'Bánh mì';
    wrapper.appendChild(child);
    stubRect(child, 40, 80, 120, 36);

    const overlayShell = doc.createElement('div');
    overlayShell.className = 'mn-grid-overlay';
    const dot = doc.createElement('span');
    dot.className = 'swiper-pagination-bullet';
    overlayShell.appendChild(dot);
    stubRect(overlayShell, 0, 0, 1440, 900);
    stubRect(dot, 190, 190, 10, 10);

    let stack: Element[] = [];
    doc.elementsFromPoint = () => stack;
    doc.elementFromPoint = () => stack[0] ?? null;

    // Resolution is scheduled on requestAnimationFrame; capture frames so the test
    // drives them deterministically instead of waiting on wall-clock time.
    const pendingFrames: FrameRequestCallback[] = [];
    win.requestAnimationFrame = (cb: FrameRequestCallback): number => {
      pendingFrames.push(cb);
      return pendingFrames.length;
    };
    win.cancelAnimationFrame = () => {};

    win.eval(ELEMENT_PICKER_SCRIPT);

    const hover = (x: number, y: number): string => {
      const ev = new win.Event('pointermove', { bubbles: true, cancelable: true });
      Object.defineProperty(ev, 'clientX', { value: x });
      Object.defineProperty(ev, 'clientY', { value: y });
      win.dispatchEvent(ev);
      const frame = pendingFrames.shift();
      if (frame) frame(0);
      const badge = doc.getElementById('antifan-inspect-badge');
      return badge ? badge.textContent ?? '' : '';
    };

    // 1. Hovering a child: the giant wrapper sits in the hit stack, but only physical
    //    size may classify a micro target, so the child must win.
    stack = [child, wrapper];
    assert.strictEqual(hover(100, 100), 'a.product-card__title (120×36)');

    // 2. The dilation ring must still find a genuinely micro control under a large overlay.
    stack = [overlayShell, dot];
    assert.strictEqual(hover(200, 200), 'span.swiper-pagination-bullet (10×10)');

    // 3. The wrapper itself stays pickable when nothing smaller is under the cursor.
    stack = [wrapper];
    assert.strictEqual(hover(300, 300), 'div.mn-home__nav-area (1588×3140)');

    win.__antifanPickerCleanup?.();
    win.close();
  });
});
