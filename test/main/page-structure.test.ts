import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
// @ts-ignore jsdom ships no type declarations (same as theme-qa-automation-stack.test.ts)
import { JSDOM } from 'jsdom';
import { runPageStructure } from '../../src/main/qa/probes/page-structure';
import {
  HOME_STRUCTURE_RULES,
  classifyHomeSection,
  evaluateHomeStructure,
  type ClassifiedHomeSection,
  type RawHomeSection,
  type SectionRole,
} from '../../src/main/qa/probes/home-structure-rules';
import type { ProbeDeps } from '../../src/main/qa/probes/probe-deps';

const FIXTURES = path.resolve(process.cwd(), 'test/fixtures/probes');
const VIEWPORT_HEIGHT = 667;

// jsdom lays nothing out: elements marked data-h stack vertically in document order, nested ones share the top.
function loadFixture(name: string, edit?: (html: string) => string) {
  const raw = fs.readFileSync(path.join(FIXTURES, name), 'utf8');
  const html = edit ? edit(raw) : raw;
  const dom = new JSDOM(html, { url: 'https://shop.example.com/', runScripts: 'outside-only', pretendToBeVisual: true });
  const win = dom.window;
  const doc = win.document as Document;
  const tops = new Map<Element, number>();
  let y = 0;
  for (const el of Array.from(doc.querySelectorAll('[data-h]'))) {
    if (el.parentElement?.closest('[data-h]')) continue;
    tops.set(el, y);
    y += Number(el.getAttribute('data-h'));
  }
  win.Element.prototype.getBoundingClientRect = function (this: Element) {
    const host = this.closest('[data-h]');
    if (!host) return { x: 0, y: 0, left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0 };
    let outer: Element = host;
    while (outer.parentElement?.closest('[data-h]')) outer = outer.parentElement.closest('[data-h]') as Element;
    const top = tops.get(outer) ?? 0;
    const height = Number(this.getAttribute('data-h') ?? 0);
    return { x: 0, y: top, left: 0, top, right: 375, bottom: top + height, width: 375, height };
  };
  Object.defineProperty(win, 'innerHeight', { value: VIEWPORT_HEIGHT });
  Object.defineProperty(doc.documentElement, 'scrollHeight', { value: y });
  return dom;
}

function depsFor(dom: { window: { eval(code: string): unknown } }): ProbeDeps {
  return {
    async evalJs(expression) {
      return dom.window.eval(expression);
    },
    async click() {
      return { ok: true };
    },
    async hover() {
      return { ok: true };
    },
    async wait() {},
  };
}

function section(role: SectionRole, over: Partial<ClassifiedHomeSection> = {}): ClassifiedHomeSection {
  return {
    role,
    tag: 'section',
    id: '',
    cls: role,
    type: '',
    heading: '',
    productLinks: 0,
    collectionLinks: 0,
    blogLinks: 0,
    hasEmailInput: false,
    imgCount: 0,
    top: 0,
    height: 400,
    selector: `section.${role}`,
    ...over,
  };
}

const ctx = { viewportHeight: VIEWPORT_HEIGHT, pageHeight: 3000 };

describe('page structure probe', () => {
  it('passes a healthy eight-section home page without findings', async () => {
    const res = await runPageStructure(depsFor(loadFixture('home-good.html')));
    assert.equal(res.measured, true);
    assert.deepStrictEqual(res.findings, []);
    assert.equal(res.passed, true);
    assert.equal(res.data.count, 8);
    assert.deepStrictEqual(
      [...res.data.order],
      ['hero', 'category-rail', 'product-rail', 'banner', 'product-rail', 'usp', 'blog', 'newsletter', 'footer']
    );
    assert.deepStrictEqual([...res.data.duplicateRoles], []);
    assert.equal(res.data.heightShare.length, 9);
    const shareTotal = res.data.heightShare.reduce((a, b) => a + b, 0);
    assert.ok(Math.abs(shareTotal - 1) < 0.01, `shares sum to ${shareTotal}`);
  });

  it('fails a fourteen-section home page against the 6-10 budget', async () => {
    const res = await runPageStructure(depsFor(loadFixture('home-14-sections.html')));
    assert.equal(res.data.count, 14);
    assert.equal(res.passed, false);
    const finding = res.findings.find((f) => f.ruleId === 'home-section-count');
    assert.ok(finding, JSON.stringify(res.findings));
    assert.equal(finding.severity, 'critical');
    assert.equal(finding.measured?.count, 14);
  });

  it('fails when the hero is not the first section', async () => {
    const res = await runPageStructure(depsFor(loadFixture('home-hero-not-first.html')));
    assert.equal(res.data.order[0], 'product-rail');
    assert.equal(res.passed, false);
    const finding = res.findings.find((f) => f.ruleId === 'home-hero-first');
    assert.ok(finding, JSON.stringify(res.findings));
    assert.equal(finding.measured?.heroIndex, 1);
  });

  it('finds the page footer when a hidden cart drawer footer comes after it', async () => {
    const res = await runPageStructure(
      depsFor(
        loadFixture('home-good.html', (html) =>
          html.replace('</body>', '<aside class="cart-modal"><footer class="cart-modal__footer">Thanh toán</footer></aside>\n</body>')
        )
      )
    );
    assert.equal(res.data.order.at(-1), 'footer');
    assert.ok(!res.findings.some((f) => f.ruleId === 'home-footer-last'), JSON.stringify(res.findings));
    assert.equal(res.passed, true);
  });

  it('applies rule overrides and an explicit viewport height', async () => {
    const res = await runPageStructure(depsFor(loadFixture('home-good.html')), {
      rules: { minSections: 9 },
      viewportHeight: 300,
    });
    const ids = res.findings.map((f) => f.ruleId).sort();
    assert.deepStrictEqual(ids, ['home-first-product-rail', 'home-page-height', 'home-section-count']);
    assert.equal(res.passed, false);
  });

  it('is unmeasured when the page script finds no sections', async () => {
    const res = await runPageStructure({
      async evalJs() {
        return { ok: false, reason: 'no visible page sections found', viewportHeight: 667, pageHeight: 0, sections: [] };
      },
      async click() {
        return { ok: true };
      },
      async hover() {
        return { ok: true };
      },
      async wait() {},
    });
    assert.equal(res.measured, false);
    assert.equal(res.passed, null);
  });
});

describe('home structure rules', () => {
  it('keeps the defaults the kit registry mirrors', () => {
    assert.equal(HOME_STRUCTURE_RULES.minSections, 6);
    assert.equal(HOME_STRUCTURE_RULES.maxSections, 10);
    assert.equal(HOME_STRUCTURE_RULES.maxConsecutiveBanners, 2);
    assert.equal(HOME_STRUCTURE_RULES.firstProductRailWithinViewports, 2);
    assert.equal(HOME_STRUCTURE_RULES.maxPageHeightViewports, 12);
  });

  it('flags three banners in a row but allows two', () => {
    const base: SectionRole[] = ['hero', 'category-rail', 'product-rail'];
    const tail: SectionRole[] = ['usp', 'blog', 'newsletter', 'footer'];
    const three = [...base, 'banner' as const, 'banner' as const, 'banner' as const, ...tail].map((r) => section(r));
    const two = [...base, 'banner' as const, 'banner' as const, ...tail].map((r) => section(r));
    assert.ok(evaluateHomeStructure(three, ctx, HOME_STRUCTURE_RULES).some((f) => f.ruleId === 'home-banner-run'));
    const twoFindings = evaluateHomeStructure(two, ctx, HOME_STRUCTURE_RULES).map((f) => f.ruleId);
    assert.ok(!twoFindings.includes('home-banner-run'));
    assert.ok(!twoFindings.includes('home-consecutive-role'));
  });

  it('flags newsletter or brands before the first product rail', () => {
    const early = (['hero', 'newsletter', 'product-rail', 'category-rail', 'banner', 'usp', 'footer'] as SectionRole[]).map((r) => section(r));
    const finding = evaluateHomeStructure(early, ctx, HOME_STRUCTURE_RULES).find((f) => f.ruleId === 'home-late-role');
    assert.equal(finding?.severity, 'critical');
    assert.equal(finding?.measured?.role, 'newsletter');
  });

  it('flags two adjacent sections of the same role and a footer that is not last', () => {
    const order = (['hero', 'product-rail', 'product-rail', 'usp', 'footer', 'newsletter'] as SectionRole[]).map((r) => section(r));
    const ids = evaluateHomeStructure(order, ctx, HOME_STRUCTURE_RULES).map((f) => f.ruleId);
    assert.ok(ids.includes('home-consecutive-role'));
    assert.ok(ids.includes('home-footer-last'));
  });

  it('warns when the first product rail starts beyond two viewports', () => {
    const order = (['hero', 'category-rail', 'banner', 'product-rail', 'usp', 'blog', 'footer'] as SectionRole[]).map((r, i) =>
      section(r, { top: i * 800 })
    );
    const finding = evaluateHomeStructure(order, ctx, HOME_STRUCTURE_RULES).find((f) => f.ruleId === 'home-first-product-rail');
    assert.equal(finding?.severity, 'warning');
  });

  it('classifies Vietnamese headings and keeps product sliders out of the hero role', () => {
    const raw = (over: Partial<RawHomeSection>): RawHomeSection => ({ ...section('other'), ...over });
    assert.equal(classifyHomeSection(raw({ cls: 'section', heading: 'Thương hiệu đối tác' })), 'brands');
    assert.equal(classifyHomeSection(raw({ cls: 'section', heading: 'Sản phẩm mới' })), 'product-rail');
    assert.equal(classifyHomeSection(raw({ cls: 'product-slider', productLinks: 4 })), 'product-rail');
    assert.equal(classifyHomeSection(raw({ cls: 'image-slider', imgCount: 3 })), 'hero');
    assert.equal(classifyHomeSection(raw({ cls: 'section', heading: 'Đăng ký nhận tin', hasEmailInput: true })), 'newsletter');
  });
});
