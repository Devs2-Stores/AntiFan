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
import { AnnotationManager, type AnnotationPayload } from '../../src/main/bridge/annotation-manager';
import { SUPER_FAST_TAG_RE } from '../../src/omp-hooks/edit-mode';

interface JsdomLike {
  window: Window & typeof globalThis & { eval: (src: string) => unknown; __antifanPickerCleanup?: () => void };
}

type JsdomCtor = new (html: string, options?: Record<string, unknown>) => JsdomLike;

/**
 * jsdom is a transitive dep; when the shared node_modules copy is broken the
 * test honors ANTIFAN_JSDOM (a dir containing node_modules/jsdom) and skips
 * with the resolution error as the named blocker.
 */
function loadJsdom(): { JSDOM: JsdomCtor } {
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
    throw new Error(`jsdom is a declared devDependency and a hard prerequisite of this suite; resolution failed (searched: ${searchPaths.join(', ')}): ${err instanceof Error ? err.message : String(err)}`);
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

/**
 * A picker instance driven through its own published events: the harness awaits
 * `antifan-pick-event` instead of sleeping, so a failure names the missing signal.
 */
interface PickerHarness {
  win: JsdomLike['window'];
  doc: Document;
  clipboardWrites: string[];
  published: Record<string, unknown>[];
  nextPick: () => Promise<Record<string, unknown>>;
  drainMicrotasks: () => Promise<void>;
  openModal: () => Element | null;
}

function createPickerHarness(JSDOM: JsdomCtor, initialContext?: Record<string, unknown>): PickerHarness {
  const dom = new JSDOM('<!doctype html><html><body></body></html>', {
    runScripts: 'outside-only',
    url: 'https://m-n-bakery.myharavan.com/products/banh-mi',
  });
  const win = dom.window as JsdomLike['window'];
  if (initialContext) {
    (win as unknown as { __antifanTerminalContext: Record<string, unknown> }).__antifanTerminalContext = initialContext;
  }
  const doc: Document = win.document;

  const target = doc.createElement('a');
  target.className = 'product-card__title';
  doc.body.appendChild(target);
  target.getBoundingClientRect = () => ({ x: 10, y: 10, width: 200, height: 40, top: 10, right: 210, bottom: 50, left: 10, toJSON: () => ({}) });

  const clipboardWrites: string[] = [];
  Object.defineProperty(win.navigator, 'clipboard', {
    configurable: true,
    value: {
      writeText: (text: string) => {
        clipboardWrites.push(text);
        return Promise.resolve();
      },
    },
  });

  // A published pick is the page's own completion signal: the test awaits it
  // instead of sleeping, so a failure names the missing signal, not a timeout.
  const published: Record<string, unknown>[] = [];
  const waiters: Array<(pick: Record<string, unknown>) => void> = [];
  win.addEventListener('antifan-pick-event', (ev) => {
    const detail = ev instanceof win.CustomEvent ? (ev.detail as Record<string, unknown>) : {};
    published.push(detail);
    const waiter = waiters.shift();
    if (waiter) waiter(detail);
  });

  win.eval(ELEMENT_PICKER_SCRIPT);

  return {
    win,
    doc,
    clipboardWrites,
    published,
    nextPick: () => {
      const { promise, resolve } = Promise.withResolvers<Record<string, unknown>>();
      waiters.push(resolve);
      return promise;
    },
    // Deterministic quiescence for absence assertions: drains the microtask chain
    // the clipboard promise resolution starts, with no wall-clock dependency.
    drainMicrotasks: async () => {
      for (let i = 0; i < 4; i++) await Promise.resolve();
    },
    openModal: () => {
      target.dispatchEvent(new win.MouseEvent('click', { bubbles: true, cancelable: true }));
      return doc.getElementById('antifan-comment-modal');
    },
  };
}

describe('Element Picker Comment Modal Mode Tags & Copy Prompt', () => {
  const modalTextarea = (h: PickerHarness, modal: Element): HTMLTextAreaElement => {
    const textarea = modal.querySelector('textarea');
    assert.ok(textarea, 'comment modal must carry the prompt textarea');
    return textarea as HTMLTextAreaElement;
  };

  const promptOf = (h: PickerHarness, modal: Element): string => modalTextarea(h, modal).value;

  it('defaults to the Direct Edit tag with the caret after it, and the Core tick flips the tag slot', async (t) => {
    const { JSDOM } = loadJsdom();
    const h = createPickerHarness(JSDOM);
    const modal = h.openModal();
    assert.ok(modal, 'clicking a target must open the annotation modal');

    const textarea = modalTextarea(h, modal);
    assert.strictEqual(textarea.value, '/queue [⚡Direct-Edit] ', 'Direct Edit is the popup default mode tag');
    assert.strictEqual(textarea.selectionStart, textarea.value.length, 'caret must land after the default tag');
    assert.strictEqual(textarea.selectionEnd, textarea.value.length);

    const coreTick = modal.querySelector('#antifanCoreTickInput');
    assert.ok(coreTick instanceof h.win.HTMLInputElement);
    assert.strictEqual(coreTick.checked, false, 'Core retrieval starts unticked');
    assert.ok(modal.querySelector('#btnModalCopy'), 'the modal offers the Copy Prompt action');

    // Clicking through the chip (not calling the handler directly) also proves the
    // picker-level click guard leaves modal-internal clicks alone.
    const directChip = modal.querySelector('#antifanChip-direct');
    assert.ok(directChip instanceof h.win.HTMLElement);
    directChip.click();
    assert.strictEqual(promptOf(h, modal), '/queue [🧠Core-Context] ', 'Direct chip must flip the tag slot to Core');
    assert.strictEqual(coreTick.checked, true);

    directChip.click();
    assert.strictEqual(promptOf(h, modal), '/queue [⚡Direct-Edit] ', 'second click must flip the tag slot back to Direct');

    coreTick.click();
    assert.strictEqual(promptOf(h, modal), '/queue [🧠Core-Context] ', 'the Core tick alone owns the mode tag');
    assert.strictEqual(directChip.textContent, '⚡ Direct Edit', 'the chip label is not the mode carrier');

    h.win.__antifanPickerCleanup?.();
    h.win.close();
  });

  it('resolves the Super-Fast chip over the same single-select mode slot', async (t) => {
    const { JSDOM } = loadJsdom();
    const h = createPickerHarness(JSDOM);
    const modal = h.openModal();
    assert.ok(modal);
    const textarea = modalTextarea(h, modal);
    const chip = (id: string): HTMLElement => {
      const el = modal.querySelector('#antifanChip-' + id);
      assert.ok(el instanceof h.win.HTMLElement, `chip #antifanChip-${id} must exist`);
      return el as HTMLElement;
    };

    assert.strictEqual(textarea.value, '/queue [⚡Direct-Edit] ', 'the popup default stays Direct Edit');
    const coreTick = modal.querySelector('#antifanCoreTickInput');
    assert.ok(coreTick instanceof h.win.HTMLInputElement);

    coreTick.click();
    assert.strictEqual(promptOf(h, modal), '/queue [🧠Core-Context] ');

    chip('fast').click();
    assert.strictEqual(promptOf(h, modal), '/queue [🚀Super-Fast] ', 'the Super-Fast chip resolves to the Super-Fast tag');
    assert.ok(SUPER_FAST_TAG_RE.test(promptOf(h, modal)), 'the enforcement-side matcher reads the emitted tag as Super-Fast');
    assert.strictEqual(coreTick.checked, false, 'Super-Fast clears the Core tick');

    textarea.value = promptOf(h, modal) + 'sửa lề nút cart';
    chip('direct').click();
    assert.strictEqual(
      promptOf(h, modal),
      '/queue [⚡Direct-Edit] sửa lề nút cart',
      'Direct Edit replaces Super-Fast, so exactly one mode tag ships',
    );

    chip('fast').click();
    assert.strictEqual(promptOf(h, modal), '/queue [🚀Super-Fast] sửa lề nút cart', 'Super-Fast clears Direct Edit the same way');
    chip('core').click();
    assert.strictEqual(
      promptOf(h, modal),
      '/queue [🧠Core-Context] sửa lề nút cart',
      'Core chip replaces Super-Fast while keeping typed text',
    );

    h.win.__antifanPickerCleanup?.();
    h.win.close();
  });

  it('keeps the typed request across chip toggles and never duplicates a mode tag', async (t) => {
    const { JSDOM } = loadJsdom();
    const h = createPickerHarness(JSDOM);
    const modal = h.openModal();
    assert.ok(modal);
    const textarea = modalTextarea(h, modal);

    textarea.value = '/queue [⚡Direct-Edit] đổi màu nút cart';
    const fastChip = modal.querySelector('#antifanChip-fast');
    assert.ok(fastChip instanceof h.win.HTMLElement);
    fastChip.click();
    assert.strictEqual(promptOf(h, modal), '/queue [🚀Super-Fast] đổi màu nút cart');

    const coreChip = modal.querySelector('#antifanChip-core');
    assert.ok(coreChip instanceof h.win.HTMLElement);
    coreChip.click();
    assert.strictEqual(
      promptOf(h, modal),
      '/queue [🧠Core-Context] đổi màu nút cart',
      'mode chips are single-select, so the typed request survives while only the active mode tag changes',
    );

    // A hand-pasted duplicate tag or legacy tag must not duplicate in the published prompt.
    textarea.value = '/queue [🚀Super-Fast] [🚀Super-Fast] [🚀PageSpeed] xử lý lazy load ảnh hero';
    const directChip = modal.querySelector('#antifanChip-direct');
    assert.ok(directChip instanceof h.win.HTMLElement);
    directChip.click();
    assert.strictEqual(
      promptOf(h, modal),
      '/queue [⚡Direct-Edit] xử lý lazy load ảnh hero',
      'stale, duplicate, and legacy tags are dropped, never carried',
    );

    h.win.__antifanPickerCleanup?.();
    h.win.close();
  });

  it('Copy Prompt publishes copyOnly artifacts to the clipboard without terminal dispatch', async (t) => {
    const { JSDOM } = loadJsdom();
    const h = createPickerHarness(JSDOM);
    const modal = h.openModal();
    assert.ok(modal);
    modalTextarea(h, modal).value = '/queue [⚡Direct-Edit] sửa khoảng cách supplier';

    const pickPromise = h.nextPick();
    const copyBtn = modal.querySelector('#btnModalCopy');
    assert.ok(copyBtn instanceof h.win.HTMLElement);
    copyBtn.click();

    const pick = await pickPromise;
    assert.strictEqual(pick.copyOnly, true, 'copyOnly must reach the host so it skips terminal dispatch');
    assert.strictEqual(pick.userComment, '/queue [⚡Direct-Edit] sửa khoảng cách supplier');
    assert.deepStrictEqual(h.clipboardWrites, ['/queue [⚡Direct-Edit] sửa khoảng cách supplier']);
    assert.strictEqual(h.doc.getElementById('antifan-comment-modal'), null, 'modal closes after the copy settles');

    h.win.__antifanPickerCleanup?.();
    h.win.close();
  });

  it('Send publishes without copyOnly and leaves the clipboard to the host', async (t) => {
    const { JSDOM } = loadJsdom();
    const h = createPickerHarness(JSDOM, {
      sessions: [{ id: 's-1', name: 'Terminal 1', cwd: 'E:\\Work' }],
      selectedSessionId: 's-1',
    });
    const modal = h.openModal();
    assert.ok(modal);
    modalTextarea(h, modal).value = '/queue [⚡Direct-Edit] sửa khoảng cách supplier';

    const pickPromise = h.nextPick();
    const sendBtn = modal.querySelector('#btnModalSend');
    assert.ok(sendBtn instanceof h.win.HTMLElement);
    sendBtn.click();

    const pick = await pickPromise;
    assert.strictEqual(pick.copyOnly, undefined, 'Send never sets copyOnly');
    assert.strictEqual(pick.userComment, '/queue [⚡Direct-Edit] sửa khoảng cách supplier');
    assert.deepStrictEqual(h.clipboardWrites, [], 'the page must not pre-write the raw prompt on Send');
    assert.strictEqual(h.doc.getElementById('antifan-comment-modal'), null, 'modal closes after Send');

    h.win.__antifanPickerCleanup?.();
    h.win.close();
  });

  it('refuses a body-less prompt: no publish, error surfaced, modal stays open', async (t) => {
    const { JSDOM } = loadJsdom();
    const h = createPickerHarness(JSDOM);
    const modal = h.openModal();
    assert.ok(modal);
    modalTextarea(h, modal).value = '/queue [⚡Direct-Edit] ';

    const sendBtn = modal.querySelector('#btnModalSend');
    assert.ok(sendBtn instanceof h.win.HTMLElement);
    sendBtn.click();
    await h.drainMicrotasks();

    assert.deepStrictEqual(h.published, [], 'a tag-only prompt must never be published');
    const status = modal.querySelector('#statusMsg');
    assert.ok(status instanceof h.win.HTMLElement);
    assert.strictEqual(status.style.display, 'block', 'the user gets an explicit error');
    assert.strictEqual(h.doc.getElementById('antifan-comment-modal'), modal, 'modal stays open for the fix');

    h.win.__antifanPickerCleanup?.();
    h.win.close();
  });

  it('remembers mode selection across modal reopenings', async (t) => {
    const { JSDOM } = loadJsdom();
    const h = createPickerHarness(JSDOM);
    let modal = h.openModal();
    assert.ok(modal);

    // Default starts as Direct Edit
    assert.strictEqual(promptOf(h, modal), '/queue [⚡Direct-Edit] ');

    // Select Super-Fast
    const fastChip = modal.querySelector('#antifanChip-fast') as HTMLElement;
    assert.ok(fastChip);
    fastChip.click();
    assert.strictEqual(promptOf(h, modal), '/queue [🚀Super-Fast] ');
    // Close modal via close button
    const closeBtn = modal.querySelector('#btnModalClose') as HTMLElement;
    assert.ok(closeBtn);
    closeBtn.click();
    await h.drainMicrotasks();
    // Re-run picker (as host does on every startInspect)
    h.win.eval(ELEMENT_PICKER_SCRIPT);
    modal = h.openModal();
    assert.ok(modal);
    assert.strictEqual(promptOf(h, modal), '/queue [🚀Super-Fast] ', 'reopened modal remembers selected mode');
    const coreTick = modal.querySelector('#antifanCoreTickInput') as HTMLInputElement;
    assert.strictEqual(coreTick.checked, false);

    // Toggle Core on via Core chip
    const coreChip = modal.querySelector('#antifanChip-core') as HTMLElement;
    assert.ok(coreChip);
    coreChip.click();
    assert.strictEqual(promptOf(h, modal), '/queue [🧠Core-Context] ');

    // Close and reopen again: must remember Core and Sửa Theme!
    (modal.querySelector('#btnModalClose') as HTMLElement).click();
    await h.drainMicrotasks();
    h.win.eval(ELEMENT_PICKER_SCRIPT);
    modal = h.openModal();
    assert.ok(modal);
    assert.strictEqual(promptOf(h, modal), '/queue [🧠Core-Context] ', 'reopened modal remembers Core mode');
    assert.strictEqual((modal.querySelector('#antifanCoreTickInput') as HTMLInputElement).checked, true);

    h.win.__antifanPickerCleanup?.();
    h.win.close();
  });

  it('restores saved mode from window.__antifanTerminalContext and localStorage', async (t) => {
    const { JSDOM } = loadJsdom();
    const h = createPickerHarness(JSDOM, {
      sessions: [{ id: 'term-1', name: 'Comnieusiba', cwd: '/work/Comnieusiba' }],
      selectedSessionId: 'term-1',
      annotationMode: 'fast',
    });

    const modal = h.openModal();
    assert.ok(modal);

    const textarea = modal.querySelector('textarea') as HTMLTextAreaElement;
    assert.strictEqual(textarea.value, '/queue [🚀Super-Fast] ', 'modal initializes with mode from terminal context');

    h.win.__antifanPickerCleanup?.();
    h.win.close();
  });
});

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
    // Bumped AGENT_CONTRACT_VERSION to 3.5.0-lean
    assert.ok(content.includes('contract_version: "3.5.0-lean"'));
    assert.ok(content.length < 8000, `Markdown content size (${content.length} chars) should be lean (< 8KB / ~1,600 tokens)`);
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



  it('routes a Super-Fast annotation to anti-direct and drops pagespeed when the speed heuristics also match', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'antifan-test-superfast-'));
    const manager = AnnotationManager.getInstance();
    const base = {
      workspaceDir: tempDir,
      url: 'https://m-n-bakery.myharavan.com/products/banh-mi',
      selector: '.product-card__title',
      tagName: 'a',
      dimensions: '200 x 40 px',
    };
    const skillsSection = async (userComment: string, actionChip?: string): Promise<string> => {
      const res = await manager.processAnnotationPayload({ ...base, userComment, actionChip });
      assert.strictEqual(res.ok, true);
      const start = res.markdownContent.indexOf('## 🎯 Recommended Skills & Agent Directives');
      assert.notStrictEqual(start, -1, `the skills section must be present for: ${userComment}`);
      return res.markdownContent.slice(start);
    };

    const fast = await skillsSection('[🚀Super-Fast] sửa lề nút cart\ntối ưu tốc độ');
    assert.ok(fast.includes('skill://anti-direct'), 'Super-Fast edits theme files directly, so anti-direct is the routed skill');
    assert.ok(!fast.includes('skill://pagespeed'), 'Super-Fast must not route pagespeed even when the text matches the speed heuristics');
    assert.ok(
      fast.includes('- **Super-Fast Mode Armed**: edit theme files directly — no shell, no dispatch, no live-browser or QA round-trips (`[🚀Super-Fast]`).'),
      'the Super-Fast directive line ships',
    );
    assert.ok(!fast.includes('**Direct Mode Armed**'), 'Super-Fast is its own mode, not a Direct comment');
    assert.ok(!fast.includes('**Performance Focus**'), 'the suppressed pagespeed route must not leave its directive behind');
    assert.strictEqual(fast.split('skill://anti-direct').length - 1, 1, 'anti-direct is recommended exactly once');

    const direct = await skillsSection('[⚡Direct-Edit] sửa lề nút cart');
    assert.ok(direct.includes('- **Recommended Skill**: `skill://anti-direct`'));
    assert.ok(direct.includes('**Direct Mode Armed**'));
    assert.ok(!direct.includes('**Super-Fast Mode Armed**'));

    const speed = await skillsSection('[🚀PageSpeed] tối ưu tốc độ');
    assert.ok(speed.includes('- **Recommended Skill**: `skill://pagespeed`'));
    assert.ok(speed.includes('**Performance Focus**'));
    assert.ok(!speed.includes('skill://anti-direct'), 'the PageSpeed chip routes the performance skill without arming a mode');

    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch {}
  });

  it('maps Liquid and Sapo .bwt owners into Source Ownership when the browser sends no sourceHints', async () => {
    const manager = AnnotationManager.getInstance();
    const writeTheme = (files: Record<string, string>): string => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), 'antifan-test-owner-'));
      for (const [rel, body] of Object.entries(files)) {
        fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
        fs.writeFileSync(path.join(root, rel), body, 'utf8');
      }
      return root;
    };
    const payloadFor = (workspaceDir: string, url: string) => ({
      workspaceDir,
      url,
      selector: 'span.price-sale',
      tagName: 'span',
      dimensions: '96 x 20 px',
      userComment: 'đổi màu giá sale sang đỏ',
      attributes: { class: 'price-sale' },
    });

    const haravan = writeTheme({
      'config/settings.html': '<table></table>',
      'layout/theme.liquid': '<html><body>{{ content_for_layout }}</body></html>',
      'templates/product.liquid': '<div>\n{% include \'product-price\' %}\n</div>',
      'snippets/product-price.liquid': '<div class="price-box">\n  <span class="price-sale">{{ product.price | money }}</span>\n</div>',
      // Identical markup in a backup copy ties on score and sorts before snippets/.
      'snippets/badge.liquid': '<span class="badge-hot">Hot</span>',
      'backups/snippets/badge.liquid': '<span class="badge-hot">Hot</span>',
      // Two live snippets with identical markup: the mapper cannot pick an owner.
      'snippets/tag-new.liquid': '<span class="tag-new">New</span>',
      'snippets/tag-new-alt.liquid': '<span class="tag-new">New</span>',
    });
    const sapo = writeTheme({
      'templates/product.bwt': '<div>\n{% include \'product-price\' %}\n</div>',
      'snippets/product-price.bwt': '<p>\n<span class="price-sale">{{ product.price | money }}</span>\n</p>',
    });
    // Liquid markup that matches, but in a workspace with no theme dirs: walking it would
    // mean walking the whole root, and the storefront URL alone must not trigger that.
    const plain = writeTheme({
      'src/index.html': '<span class="price-sale"></span>',
      'vendor/price.liquid': '<span class="price-sale">{{ product.price | money }}</span>',
    });
    try {
      const hrv = await manager.processAnnotationPayload(payloadFor(haravan, 'https://shop.myharavan.com/products/a'));
      assert.strictEqual(hrv.ok, true);
      assert.ok(hrv.markdownContent.includes('## 📍 Source Ownership & AST Code Locators'), hrv.markdownContent);
      assert.ok(hrv.markdownContent.includes('Detected Framework: **haravan**'));
      assert.ok(hrv.markdownContent.includes('- Suggested Source File: `snippets/product-price.liquid`'), 'the snippet holding the class owns the element, not its includer');
      assert.ok(hrv.markdownContent.includes('- Suggested Line: `2`'), 'the line is in the owning file, not the include site');

      const badge = await manager.processAnnotationPayload({
        ...payloadFor(haravan, 'https://shop.myharavan.com/products/a'),
        selector: 'span.badge-hot',
        attributes: { class: 'badge-hot' },
      });
      assert.ok(badge.markdownContent.includes('- Suggested Source File: `snippets/badge.liquid`'), 'a backup copy outside the theme dirs never owns the element');

      const tied = await manager.processAnnotationPayload({
        ...payloadFor(haravan, 'https://shop.myharavan.com/products/a'),
        selector: 'span.tag-new',
        attributes: { class: 'tag-new' },
      });
      assert.ok(tied.markdownContent.includes('## 📍 Source Ownership & AST Code Locators'), tied.markdownContent);
      assert.ok(!tied.markdownContent.includes('- Suggested Source File:'), 'a tie never promotes the alphabetically first candidate');
      assert.ok(tied.markdownContent.includes('- No single owner file'), tied.markdownContent);
      assert.ok(tied.markdownContent.includes('snippets/tag-new-alt.liquid') && tied.markdownContent.includes('snippets/tag-new.liquid'), 'both tied candidates are listed');

      const bwt = await manager.processAnnotationPayload(payloadFor(sapo, 'https://shop.mysapo.net/products/a'));
      assert.strictEqual(bwt.ok, true);
      assert.ok(bwt.markdownContent.includes('Detected Framework: **sapo**'), bwt.markdownContent);
      assert.ok(bwt.markdownContent.includes('- Suggested Source File: `snippets/product-price.bwt`'), 'Sapo .bwt templates are mapped too');

      const none = await manager.processAnnotationPayload(payloadFor(plain, 'https://shop.myharavan.com/products/a'));
      assert.strictEqual(none.ok, true);
      assert.ok(!none.markdownContent.includes('## 📍 Source Ownership'), 'a workspace with no theme dirs is never walked');
    } finally {
      for (const dir of [haravan, sapo, plain]) fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('maps real picker payloads inside Liquid sections, captures element attributes, and withholds suggestedFile on tag-only evidence', async () => {
    const { JSDOM } = loadJsdom();
    const dom = new JSDOM(
      '<!doctype html><html><body><section id="shopify-section-hero" data-section-type="hero"><span class="price-sale" data-price-tier="vip">199.000₫</span><aside class="flex">Sidebar</aside></section></body></html>',
      {
        runScripts: 'outside-only',
        url: 'https://shop.myharavan.com/products/a',
      },
    );
    const win = dom.window as JsdomLike['window'];
    const doc: Document = win.document;
    // Send is disabled without a deliverable terminal, so the pick would never publish;
    // jsdom has no CSS.escape, which the picker's selector builder needs to build the full payload.
    Object.assign(win, {
      __antifanTerminalContext: {
        sessions: [{ id: 's-1', name: 'Terminal 1', cwd: 'E:\\Work' }],
        selectedSessionId: 's-1',
      },
      CSS: { escape: (value: string) => String(value).replace(/[^\w-]/g, (ch) => `\\${ch}`) },
    });
    const priceSpan = doc.querySelector('span.price-sale') as HTMLElement;
    const asideEl = doc.querySelector('aside.flex') as HTMLElement;
    assert.ok(priceSpan && asideEl);
    Object.defineProperty(priceSpan, 'getBoundingClientRect', {
      value: function rectPrice() {
        return { x: 10, y: 10, width: 96, height: 20, top: 10, right: 106, bottom: 30, left: 10 };
      },
    });
    Object.defineProperty(asideEl, 'getBoundingClientRect', {
      value: function rectAside() {
        return { x: 10, y: 40, width: 120, height: 40, top: 40, right: 130, bottom: 80, left: 10 };
      },
    });

    const waiters: Array<(pick: AnnotationPayload) => void> = [];
    win.addEventListener('antifan-pick-event', (ev) => {
      const detail = ev instanceof win.CustomEvent ? (ev.detail as AnnotationPayload) : {};
      const waiter = waiters.shift();
      if (waiter) waiter(detail);
    });

    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'antifan-test-section-picker-'));
    try {
      const files: Record<string, string> = {
        'config/settings.html': '<table></table>',
        'layout/theme.liquid': '<html><body>{{ content_for_layout }}</body></html>',
        'templates/product.liquid': "<div>\n{% include 'product-price' %}\n{% include 'sidebar-note' %}\n</div>",
        'snippets/product-price.liquid': '<div class="price-box">\n  <span class="price-sale" data-price-tier="vip">{{ product.price | money }}</span>\n</div>',
        'snippets/sidebar-note.liquid': '<aside class="flex">{{ product.vendor }}</aside>',
      };
      for (const [rel, body] of Object.entries(files)) {
        fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
        fs.writeFileSync(path.join(root, rel), body, 'utf8');
      }

      win.eval(ELEMENT_PICKER_SCRIPT);
      priceSpan.dispatchEvent(new win.MouseEvent('click', { bubbles: true, cancelable: true }));
      const modal = doc.getElementById('antifan-comment-modal');
      assert.ok(modal, 'clicking span inside section must open comment modal');
      const textarea = modal.querySelector('textarea') as HTMLTextAreaElement;
      textarea.value = '/queue [⚡Direct-Edit] đổi màu giá sale';
      const pickSpanDeferred = Promise.withResolvers<AnnotationPayload>();
      waiters.push(pickSpanDeferred.resolve);
      (modal.querySelector('#btnModalSend') as HTMLElement).click();
      const pickedSpan = await pickSpanDeferred.promise;

      const browserHints = pickedSpan.sourceHints as {
        framework?: string;
        suggestedFile?: string;
        signals?: Array<{ type?: string; value?: string }>;
      } | undefined;
      assert.ok(browserHints, 'picker attaches sourceHints for elements inside #shopify-section-hero');
      assert.strictEqual(browserHints.framework, 'liquid');
      assert.strictEqual(browserHints.suggestedFile, undefined);
      assert.ok(
        Array.isArray(browserHints.signals)
        && browserHints.signals.some((s) => s.type === 'liquid-section' && s.value === 'shopify-section-hero'),
      );
      // The pick is built in the jsdom realm; spread it into this realm before deep-equal.
      assert.deepStrictEqual({ ...pickedSpan.attributes }, {
        class: 'price-sale',
        'data-price-tier': 'vip',
      });

      const manager = AnnotationManager.getInstance();
      const mappedSpan = await manager.processAnnotationPayload({
        ...pickedSpan,
        workspaceDir: root,
        url: 'https://shop.myharavan.com/products/a',
      });
      assert.strictEqual(mappedSpan.ok, true);
      assert.ok(mappedSpan.markdownContent.includes('## 📍 Source Ownership & AST Code Locators'), mappedSpan.markdownContent);
      assert.ok(
        mappedSpan.markdownContent.includes('- Suggested Source File: `snippets/product-price.liquid`'),
        'ThemeSourceMapper must run even when browser sourceHints carry liquid-section signals',
      );
      assert.ok(mappedSpan.markdownContent.includes('- Suggested Line: `2`'));
      assert.ok(
        mappedSpan.markdownContent.includes('"value": "shopify-section-hero"'),
        'browser liquid-section signals stay visible in Source Ownership output',
      );

      // Data-attribute-only match (no distinctive class on payload, only data-price-tier from pickedItem.attributes)
      const dataAttrOnly = await manager.processAnnotationPayload({
        ...pickedSpan,
        classes: [],
        attributes: { 'data-price-tier': 'vip' },
        workspaceDir: root,
        url: 'https://shop.myharavan.com/products/a',
      });
      assert.strictEqual(dataAttrOnly.ok, true);
      assert.ok(
        dataAttrOnly.markdownContent.includes('- Suggested Source File: `snippets/product-price.liquid`'),
        'data-* attributes from pickedItem must reach ThemeSourceMapper and qualify as direct evidence',
      );

      // Tag + render_edge + utility-class-only match: candidate stays listed in signals, but no Suggested Source File is promoted
      win.eval(ELEMENT_PICKER_SCRIPT);
      asideEl.dispatchEvent(new win.MouseEvent('click', { bubbles: true, cancelable: true }));
      const modal2 = doc.getElementById('antifan-comment-modal');
      assert.ok(modal2);
      (modal2.querySelector('textarea') as HTMLTextAreaElement).value = '/queue [⚡Direct-Edit] kiểm tra sidebar';
      const pickAsideDeferred = Promise.withResolvers<AnnotationPayload>();
      waiters.push(pickAsideDeferred.resolve);
      (modal2.querySelector('#btnModalSend') as HTMLElement).click();
      const pickedAside = await pickAsideDeferred.promise;

      const tagOnly = await manager.processAnnotationPayload({
        ...pickedAside,
        workspaceDir: root,
        url: 'https://shop.myharavan.com/products/a',
      });
      assert.strictEqual(tagOnly.ok, true);
      assert.ok(tagOnly.markdownContent.includes('## 📍 Source Ownership & AST Code Locators'), tagOnly.markdownContent);
      assert.ok(tagOnly.markdownContent.includes('snippets/sidebar-note.liquid'), 'tag/render_edge candidate stays listed in signals');
      assert.ok(
        !tagOnly.markdownContent.includes('- Suggested Source File:'),
        'candidate scored only by tag name and render_edge must not be promoted to Suggested Source File',
      );

      // Browser hints that explicitly name a file keep winning over the workspace mapper
      const explicitBrowserFile = await manager.processAnnotationPayload({
        ...pickedSpan,
        sourceHints: {
          framework: 'astro',
          confidence: 'high',
          suggestedFile: 'src/components/HeroPrice.astro',
          suggestedLine: 14,
          signals: [{ type: 'build-attribute', name: 'data-astro-source-file', value: 'src/components/HeroPrice.astro', confidence: 'high' }],
        },
        workspaceDir: root,
        url: 'https://shop.myharavan.com/products/a',
      });
      assert.strictEqual(explicitBrowserFile.ok, true);
      assert.ok(explicitBrowserFile.markdownContent.includes('- Suggested Source File: `src/components/HeroPrice.astro`'));
    } finally {
      win.__antifanPickerCleanup?.();
      win.close();
      fs.rmSync(root, { recursive: true, force: true });
    }
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
    const { JSDOM } = loadJsdom();
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

describe('Element Picker Send-To Terminal Groups', () => {
  const groupedSessions = [
    { id: 's-a1', name: 'Terminal 1', cwd: 'E:\\Work\\mn-bakery', folderKey: 'e:\\work\\mn-bakery', folderLabel: 'mn-bakery', displayLabel: 'mn-bakery · 1' },
    { id: 's-b1', name: 'Terminal 2', cwd: 'E:\\Work\\f1genz', folderKey: 'e:\\work\\f1genz', folderLabel: 'f1genz', displayLabel: 'f1genz · 1' },
    { id: 's-a2', name: 'Terminal 3', cwd: 'E:\\Work\\mn-bakery', folderKey: 'e:\\work\\mn-bakery', folderLabel: 'mn-bakery', displayLabel: 'mn-bakery · 2' },
  ];

  const openSelect = (initialContext: Record<string, unknown>) => {
    const { JSDOM } = loadJsdom();
    const h = createPickerHarness(JSDOM, { sessions: groupedSessions, selectedSessionId: 'auto', ...initialContext });
    const modal = h.openModal();
    assert.ok(modal, 'clicking a target must open the annotation modal');
    const select = modal.querySelector('#antifanTerminalSelect') as HTMLSelectElement | null;
    assert.ok(select, 'modal must render the send-to select');
    return { h, select };
  };

  it('renders one optgroup per folder with displayLabel options and auto first', () => {
    const { h, select } = openSelect({});
    const children = Array.from(select.children);
    assert.strictEqual(children.length, 3, 'auto option plus two optgroups');
    const [autoOpt, groupA, groupB] = children as [HTMLOptionElement, HTMLOptGroupElement, HTMLOptGroupElement];
    assert.strictEqual(autoOpt.tagName, 'OPTION');
    assert.strictEqual(autoOpt.value, 'auto');
    assert.strictEqual(autoOpt.textContent, 'Tự động (theo site URL)');
    assert.strictEqual(select.value, 'auto', 'a tab with no own choice resolves to auto');

    for (const [group, label] of [[groupA, 'mn-bakery'], [groupB, 'f1genz']] as const) {
      assert.strictEqual(group.tagName, 'OPTGROUP');
      assert.strictEqual(group.label, label);
    }
    assert.deepStrictEqual(
      Array.from(groupA.querySelectorAll('option')).map((o) => o.textContent),
      ['mn-bakery · 1', 'mn-bakery · 2'],
    );
    h.win.__antifanPickerCleanup?.();
    h.win.close();
  });

  it('preselects the option matching the tab annotationSessionId', () => {
    const { h, select } = openSelect({ annotationSessionId: 's-b1' });
    assert.strictEqual(select.value, 's-b1');
    const chosen = select.querySelector('option:checked') as HTMLOptionElement | null;
    assert.ok(chosen);
    assert.strictEqual(chosen.value, 's-b1');
    assert.strictEqual((chosen.parentElement as HTMLOptGroupElement).tagName, 'OPTGROUP');
    h.win.__antifanPickerCleanup?.();
    h.win.close();
  });

  it('ignores origin-shared storage so sibling tabs keep independent choices', () => {
    const { JSDOM } = loadJsdom();
    const h = createPickerHarness(JSDOM, { sessions: groupedSessions, selectedSessionId: 'auto' });
    h.win.localStorage.setItem('antifan_annotation_session_id', 's-b1');
    const modal = h.openModal();
    assert.ok(modal);
    const select = modal.querySelector('#antifanTerminalSelect') as HTMLSelectElement | null;
    assert.ok(select);
    assert.strictEqual(select.value, 'auto', 'a stored cross-tab choice must not retarget this tab');
    assert.strictEqual(h.win.localStorage.length, 1, 'the picker must not write terminal routing keys');
    h.win.__antifanPickerCleanup?.();
    h.win.close();
  });

  it('falls back to a flat name list when sessions carry no folder projection', () => {
    const { JSDOM } = loadJsdom();
    const h = createPickerHarness(JSDOM, {
      sessions: [
        { id: 's-1', name: 'Terminal 1', cwd: 'E:\\Work\\a' },
        { id: 's-2', name: 'Terminal 2', cwd: 'E:\\Work\\b' },
      ],
      selectedSessionId: 'auto',
    });
    const modal = h.openModal();
    assert.ok(modal);
    const select = modal.querySelector('#antifanTerminalSelect') as HTMLSelectElement | null;
    assert.ok(select);
    assert.strictEqual(select.querySelectorAll('optgroup').length, 0);
    assert.deepStrictEqual(
      Array.from(select.querySelectorAll('option')).map((o) => [o.value, o.textContent]),
      [
        ['auto', 'Tự động (theo site URL)'],
        ['s-1', 'Terminal 1'],
        ['s-2', 'Terminal 2'],
      ],
    );
    h.win.__antifanPickerCleanup?.();
    h.win.close();
  });
});

describe('Element Picker Blocking Surface & Piercing Resolution', () => {
  it('stops dilation and stack piercing at modal/drawer boundary and targets drawer on hover/click', () => {
    const { JSDOM } = loadJsdom();
    const dom = new JSDOM(`<!doctype html>
<html>
<head></head>
<body>
  <div class="collection-page" id="col-page">
    <div class="product-grid">
      <div class="product-card" id="card-1" style="position:relative; width:200px; height:200px;">
        <img class="product-img" id="bg-img" src="item.jpg" style="width:200px; height:200px;" />
      </div>
      <div class="pagination-wrapper" style="position:relative; width:200px; height:50px;">
        <button class="owl-dot" id="bg-dot" style="width:20px; height:20px;"></button>
      </div>
    </div>
  </div>

  <div class="drawer sidebar-filter" id="filter-drawer" style="position:fixed; top:0; left:0; width:300px; height:600px; z-index:1000; background:#fff;">
    <div class="drawer-header" id="drawer-hdr" style="height:50px;">Filter</div>
    <div class="drawer-content" id="drawer-body" style="height:450px; background:#fafafa;">
      <button class="btn-filter" id="drawer-btn-filter" style="width:100px; height:40px;">Apply</button>
    </div>
  </div>
</body>
</html>`, {
      runScripts: 'outside-only',
      url: 'https://m-n-bakery.myharavan.com/collections/all',
    });

    const win = dom.window as unknown as JsdomLike['window'];
    const doc = win.document;

    const setRect = (el: Element | null, x: number, y: number, w: number, h: number) => {
      if (!el) return;
      el.getBoundingClientRect = () => ({
        x, y, width: w, height: h, top: y, right: x + w, bottom: y + h, left: x, toJSON: () => ({})
      });
    };

    setRect(doc.getElementById('filter-drawer'), 0, 0, 300, 600);
    setRect(doc.getElementById('drawer-hdr'), 0, 0, 300, 50);
    setRect(doc.getElementById('drawer-body'), 0, 50, 300, 450);
    setRect(doc.getElementById('drawer-btn-filter'), 20, 70, 100, 40);
    setRect(doc.getElementById('card-1'), 50, 50, 200, 200);
    setRect(doc.getElementById('bg-img'), 50, 50, 200, 200);
    setRect(doc.getElementById('bg-dot'), 50, 300, 20, 20);

    doc.elementFromPoint = (x: number, y: number) => {
      if (x >= 0 && x <= 300 && y >= 0 && y <= 600) {
        if (x >= 20 && x <= 120 && y >= 70 && y <= 110) return doc.getElementById('drawer-btn-filter');
        if (y < 50) return doc.getElementById('drawer-hdr');
        return doc.getElementById('drawer-body');
      }
      if (x >= 50 && x <= 70 && y >= 300 && y <= 320) return doc.getElementById('bg-dot');
      return doc.body;
    };

    doc.elementsFromPoint = (x: number, y: number) => {
      const list: Element[] = [];
      const top = doc.elementFromPoint(x, y);
      if (top && top !== doc.body) list.push(top);
      if (x >= 50 && x <= 250 && y >= 50 && y <= 250) {
        const img = doc.getElementById('bg-img');
        const card = doc.getElementById('card-1');
        if (img && !list.includes(img)) list.push(img);
        if (card && !list.includes(card)) list.push(card);
      }
      if (x >= 50 && x <= 70 && y >= 300 && y <= 320) {
        const dot = doc.getElementById('bg-dot');
        if (dot && !list.includes(dot)) list.push(dot);
      }
      list.push(doc.body);
      return list;
    };

    const pendingFrames: FrameRequestCallback[] = [];
    win.requestAnimationFrame = (cb: FrameRequestCallback): number => {
      pendingFrames.push(cb);
      return pendingFrames.length;
    };
    win.cancelAnimationFrame = () => {};

    win.eval(ELEMENT_PICKER_SCRIPT);

    const overlay = doc.getElementById('antifan-inspect-overlay');
    assert.ok(overlay, 'overlay must exist');

    const sendHover = (x: number, y: number) => {
      const ev = new win.Event('pointermove', { bubbles: true, cancelable: true });
      Object.defineProperty(ev, 'clientX', { value: x });
      Object.defineProperty(ev, 'clientY', { value: y });
      win.dispatchEvent(ev);
      while (pendingFrames.length > 0) {
        const frame = pendingFrames.shift();
        if (frame) frame(0);
      }
    };

    const sendClick = (x: number, y: number) => {
      const pd = new win.Event('pointerdown', { bubbles: true, cancelable: true });
      Object.defineProperty(pd, 'clientX', { value: x });
      Object.defineProperty(pd, 'clientY', { value: y });
      win.dispatchEvent(pd);

      const clk = new win.Event('click', { bubbles: true, cancelable: true });
      Object.defineProperty(clk, 'clientX', { value: x });
      Object.defineProperty(clk, 'clientY', { value: y });
      win.dispatchEvent(clk);
    };

    // 1. Hover on drawer whitespace over background card: blocking surface guard must stop at drawer-body!
    sendHover(150, 150);
    assert.strictEqual(overlay.style.top, '50px');
    assert.strictEqual(overlay.style.left, '0px');
    assert.strictEqual(overlay.style.width, '300px');
    assert.strictEqual(overlay.style.height, '450px');
    const badge = doc.getElementById('antifan-inspect-badge');
    assert.ok(badge && badge.textContent?.includes('div#drawer-body'), 'badge must identify div#drawer-body, not background image');

    // 2. Hover over micro dot behind drawer: dilation ring must NOT pierce through drawer!
    sendHover(60, 310);
    assert.strictEqual(overlay.style.top, '50px');
    assert.strictEqual(overlay.style.left, '0px');
    assert.ok(badge && badge.textContent?.includes('div#drawer-body'), 'badge must stay on div#drawer-body without piercing to dot');

    // 3. Click on drawer whitespace opens comment modal targeting drawer-body
    sendClick(150, 150);
    const modal = doc.getElementById('antifan-comment-modal');
    assert.ok(modal, 'comment modal must open on click');
    assert.ok(modal.textContent?.includes('div#drawer-body'), 'modal header must explicitly identify div#drawer-body as target');
    assert.ok(!modal.textContent?.includes('img#bg-img'), 'modal header must never identify obscured background image');
    const textarea = modal.querySelector('textarea') as HTMLTextAreaElement;
    assert.ok(textarea, 'textarea must exist');

    win.__antifanPickerCleanup?.();
    win.close();
  });

  it('pierces transparent link overlay to child media within same component card when no drawer blocks', () => {
    const { JSDOM } = loadJsdom();
    const dom = new JSDOM(`<!doctype html>
<html>
<head></head>
<body>
  <div class="collection-page" id="col-page">
    <div class="product-grid">
      <div class="product-card" id="card-1" style="position:relative; width:200px; height:200px;">
        <img class="product-img" id="bg-img" src="item.jpg" style="width:200px; height:200px;" />
        <a class="card-link" id="card-link-1" href="/p1" style="position:absolute; inset:0; width:200px; height:200px;"></a>
      </div>
    </div>
  </div>
</body>
</html>`, {
      runScripts: 'outside-only',
      url: 'https://m-n-bakery.myharavan.com/collections/all',
    });

    const win = dom.window as unknown as JsdomLike['window'];
    const doc = win.document;

    const setRect = (el: Element | null, x: number, y: number, w: number, h: number) => {
      if (!el) return;
      el.getBoundingClientRect = () => ({
        x, y, width: w, height: h, top: y, right: x + w, bottom: y + h, left: x, toJSON: () => ({})
      });
    };

    setRect(doc.getElementById('card-1'), 50, 50, 200, 200);
    setRect(doc.getElementById('bg-img'), 50, 50, 200, 200);
    setRect(doc.getElementById('card-link-1'), 50, 50, 200, 200);

    doc.elementFromPoint = (x: number, y: number) => {
      if (x >= 50 && x <= 250 && y >= 50 && y <= 250) return doc.getElementById('card-link-1');
      return doc.body;
    };

    doc.elementsFromPoint = (x: number, y: number) => {
      const list: Element[] = [];
      const top = doc.elementFromPoint(x, y);
      if (top && top !== doc.body) list.push(top);
      if (x >= 50 && x <= 250 && y >= 50 && y <= 250) {
        const link = doc.getElementById('card-link-1');
        const img = doc.getElementById('bg-img');
        const card = doc.getElementById('card-1');
        if (link && !list.includes(link)) list.push(link);
        if (img && !list.includes(img)) list.push(img);
        if (card && !list.includes(card)) list.push(card);
      }
      list.push(doc.body);
      return list;
    };

    const pendingFrames: FrameRequestCallback[] = [];
    win.requestAnimationFrame = (cb: FrameRequestCallback): number => {
      pendingFrames.push(cb);
      return pendingFrames.length;
    };
    win.cancelAnimationFrame = () => {};

    win.eval(ELEMENT_PICKER_SCRIPT);

    const overlay = doc.getElementById('antifan-inspect-overlay');
    assert.ok(overlay, 'overlay must exist');

    const sendHover = (x: number, y: number) => {
      const ev = new win.Event('pointermove', { bubbles: true, cancelable: true });
      Object.defineProperty(ev, 'clientX', { value: x });
      Object.defineProperty(ev, 'clientY', { value: y });
      win.dispatchEvent(ev);
      while (pendingFrames.length > 0) {
        const frame = pendingFrames.shift();
        if (frame) frame(0);
      }
    };

    sendHover(100, 100);
    assert.strictEqual(overlay.style.top, '50px');
    assert.strictEqual(overlay.style.left, '50px');
    assert.strictEqual(overlay.style.width, '200px');
    assert.strictEqual(overlay.style.height, '200px');
    const badge = doc.getElementById('antifan-inspect-badge');
    assert.ok(badge && badge.textContent?.includes('img#bg-img'), 'badge must identify pierced child media img#bg-img');

    win.__antifanPickerCleanup?.();
    win.close();
  });

  it('does not revive stale currentTarget when click lands on unresolvable or excluded surface', () => {
    const { JSDOM } = loadJsdom();
    const dom = new JSDOM(`<!doctype html>
<html>
<head></head>
<body>
  <div class="product-card" id="card-1" style="position:relative; width:200px; height:200px;">
    <img class="product-img" id="bg-img" src="item.jpg" style="width:200px; height:200px;" />
  </div>
  <div id="blank-area" style="position:fixed; top:300px; left:0; width:100px; height:100px;"></div>
</body>
</html>`, {
      runScripts: 'outside-only',
      url: 'https://m-n-bakery.myharavan.com/collections/all',
    });

    const win = dom.window as unknown as JsdomLike['window'];
    const doc = win.document;

    const setRect = (el: Element | null, x: number, y: number, w: number, h: number) => {
      if (!el) return;
      el.getBoundingClientRect = () => ({
        x, y, width: w, height: h, top: y, right: x + w, bottom: y + h, left: x, toJSON: () => ({})
      });
    };

    setRect(doc.getElementById('card-1'), 0, 0, 200, 200);
    setRect(doc.getElementById('bg-img'), 0, 0, 200, 200);
    setRect(doc.getElementById('blank-area'), 0, 300, 100, 100);

    doc.elementFromPoint = (x: number, y: number) => {
      if (x <= 200 && y <= 200) return doc.getElementById('bg-img');
      if (y >= 300 && y <= 400) return doc.getElementById('blank-area');
      return doc.body;
    };

    doc.elementsFromPoint = (x: number, y: number) => {
      const top = doc.elementFromPoint(x, y);
      return top ? [top, doc.body] : [doc.body];
    };

    const pendingFrames: FrameRequestCallback[] = [];
    win.requestAnimationFrame = (cb: FrameRequestCallback): number => {
      pendingFrames.push(cb);
      return pendingFrames.length;
    };
    win.cancelAnimationFrame = () => {};

    win.eval(ELEMENT_PICKER_SCRIPT);

    const sendHover = (x: number, y: number) => {
      const ev = new win.Event('pointermove', { bubbles: true, cancelable: true });
      Object.defineProperty(ev, 'clientX', { value: x });
      Object.defineProperty(ev, 'clientY', { value: y });
      win.dispatchEvent(ev);
      while (pendingFrames.length > 0) {
        const frame = pendingFrames.shift();
        if (frame) frame(0);
      }
    };

    // 1. Initial hover sets currentTarget to bg-img
    sendHover(50, 50);
    const badge = doc.getElementById('antifan-inspect-badge');
    assert.ok(badge && badge.textContent?.includes('img#bg-img'));

    // 2. Now click lands on blank-area
    const clk = new win.Event('click', { bubbles: true, cancelable: true });
    Object.defineProperty(clk, 'clientX', { value: 50 });
    Object.defineProperty(clk, 'clientY', { value: 350 });
    win.dispatchEvent(clk);

    // Modal must target blank-area, NEVER the stale bg-img from prior hover
    const modal = doc.getElementById('antifan-comment-modal');
    assert.ok(modal, 'comment modal must open on click');
    assert.ok(modal.textContent?.includes('div#blank-area'), 'modal must target blank-area, not stale hover target');
    assert.ok(!modal.textContent?.includes('img#bg-img'), 'modal must not revive stale bg-img');

    win.__antifanPickerCleanup?.();
    win.close();
  });
});
