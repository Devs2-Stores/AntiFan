import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
// @ts-ignore jsdom ships no type declarations (same as theme-qa-automation-stack.test.ts)
import { JSDOM } from 'jsdom';
import { runMenuDepth } from '../../src/main/qa/probes/menu-depth';
import type { ProbeDeps } from '../../src/main/qa/probes/probe-deps';

const FIXTURES = path.resolve(process.cwd(), 'test/fixtures/probes');

function load(html: string) {
  const dom = new JSDOM(html, { url: 'https://shop.example.com/', runScripts: 'outside-only', pretendToBeVisual: true });
  // jsdom lays nothing out: every element gets a painted box, visibility comes from computed display.
  dom.window.Element.prototype.getBoundingClientRect = function () {
    return { x: 10, y: 10, left: 10, top: 10, right: 110, bottom: 40, width: 100, height: 30, toJSON() { return this; } };
  };
  return dom;
}

function loadFixture(name: string) {
  return load(fs.readFileSync(path.join(FIXTURES, name), 'utf8'));
}

interface DepsOptions {
  /** Which items reveal their submenu when hovered; receives the data-af-menu path. */
  hoverReveals?: (menuPath: string) => boolean;
  hoverFails?: boolean;
}

function revealChildLists(el: Element): void {
  for (const child of Array.from(el.children)) {
    if (child.tagName === 'UL') (child as HTMLElement).style.display = 'block';
  }
}

function makeDeps(dom: { window: { document: Document; eval(code: string): unknown } }, options: DepsOptions = {}): ProbeDeps {
  const doc = dom.window.document;
  return {
    async evalJs(expression) {
      return dom.window.eval(expression);
    },
    async hover(selector) {
      const el = doc.querySelector(selector);
      if (!el || options.hoverFails) return { ok: false, error: 'no :hover' };
      const menuPath = el.getAttribute('data-af-menu') ?? '';
      if (!options.hoverReveals || options.hoverReveals(menuPath)) revealChildLists(el);
      return { ok: true };
    },
    async click(selector) {
      const el = doc.querySelector(selector);
      if (!el) return { ok: false, error: 'not found' };
      if (el.hasAttribute('data-af-menu-opener')) {
        (doc.querySelector('.mobile-menu') as HTMLElement).style.display = 'block';
      } else if (el.hasAttribute('data-af-menu-toggle')) {
        revealChildLists(el.parentElement as Element);
      } else {
        revealChildLists(el);
      }
      return { ok: true };
    },
    async wait() {},
  };
}

describe('menu depth probe', () => {
  it('reports three rendered and visible levels for a hover mega menu', async () => {
    const dom = loadFixture('menu-3level.html');
    const res = await runMenuDepth(makeDeps(dom));
    assert.equal(res.measured, true);
    assert.equal(res.passed, true);
    assert.equal(res.data.maxDepth, 3);
    assert.deepStrictEqual([...res.data.perLevelCounts], [4, 4, 8]);
    assert.equal(res.data.level3Visible, true);
    assert.deepStrictEqual(res.findings, []);
    assert.equal(dom.window.document.querySelector('[data-af-menu]'), null, 'probe markers are removed afterwards');
  });

  it('reports two levels for a two-level menu and flags the missing level when three are expected', async () => {
    const dom = loadFixture('menu-2level.html');
    const plain = await runMenuDepth(makeDeps(dom));
    assert.equal(plain.data.maxDepth, 2);
    assert.equal(plain.data.level3Visible, false);
    assert.equal(plain.passed, true);

    const expected = await runMenuDepth(makeDeps(loadFixture('menu-2level.html')), { expectedMaxDepth: 3 });
    assert.equal(expected.passed, false);
    const finding = expected.findings.find((f) => f.ruleId === 'menu-level-not-rendered');
    assert.ok(finding, JSON.stringify(expected.findings));
    assert.equal(finding.severity, 'critical');
    assert.equal(finding.measured?.rendered, 2);
    assert.equal(finding.measured?.expected, 3);
  });

  it('separates a level that is in the markup from one that can actually be reached', async () => {
    const reveal = (menuPath: string) => !menuPath.includes('.');
    const warn = await runMenuDepth(makeDeps(loadFixture('menu-3level.html'), { hoverReveals: reveal }));
    assert.equal(warn.data.maxDepth, 3);
    assert.equal(warn.data.level3Visible, false);
    const warning = warn.findings.find((f) => f.ruleId === 'menu-level-not-visible');
    assert.equal(warning?.severity, 'warning');
    assert.equal(warn.passed, true);

    const fail = await runMenuDepth(makeDeps(loadFixture('menu-3level.html'), { hoverReveals: reveal }), { expectedMaxDepth: 3 });
    assert.equal(fail.findings.find((f) => f.ruleId === 'menu-level-not-visible')?.severity, 'critical');
    assert.equal(fail.passed, false);
  });

  it('falls back to a click when hover cannot activate the menu', async () => {
    const res = await runMenuDepth(makeDeps(loadFixture('menu-3level.html'), { hoverFails: true }));
    assert.equal(res.data.level3Visible, true);
    assert.equal(res.passed, true);
  });

  it('opens the mobile drawer and clicks level arrows to reach the third level', async () => {
    const dom = loadFixture('menu-mobile-3level.html');
    const drawer = dom.window.document.querySelector('.mobile-menu') as HTMLElement;
    assert.equal(drawer.style.display, 'none');
    const res = await runMenuDepth(makeDeps(dom), { mobile: true, expectedMaxDepth: 3 });
    assert.equal(drawer.style.display, 'block', 'the opener was clicked');
    assert.equal(res.measured, true);
    assert.equal(res.data.maxDepth, 3);
    assert.equal(res.data.mobileMaxDepth, 3);
    assert.equal(res.data.level3Visible, true);
    assert.equal(res.passed, true);
  });

  it('is unmeasured, not failed, when the page has no navigation list', async () => {
    const res = await runMenuDepth(makeDeps(load('<!doctype html><body><p>Không có menu</p></body>')));
    assert.equal(res.measured, false);
    assert.equal(res.passed, null);
    assert.equal(res.findings[0]?.ruleId, 'menu-not-found');
  });
});
