/**
 * A capture hides AntiFan's own overlays, the platform's preview chrome (one shared list) and,
 * since a screenshot is evidence that leaves the machine, every password field.
 */
import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  ANTIFAN_OVERLAY_SELECTORS,
  SCREENSHOT_GUARD_STYLE_ID,
  SECRET_FIELD_ATTRIBUTE,
  buildScreenshotGuardCss,
  buildScreenshotGuardInstallSnippet,
  buildSecretFieldMarkScript,
} from '../../../src/main/browser/screenshot-guard-css';
import { PLATFORM_PREVIEW_CHROME_SELECTORS } from '../../../src/main/qa/platform-preview-chrome';
import { buildIsolatedCollectorScript } from '../../../src/main/browser/semantic-ref-executor';

type Rule = { selectors: string[]; body: string };
const rulesOf = (css: string): Rule[] =>
  [...css.matchAll(/([^{}]+)\{([^}]*)\}/g)].map((m) => ({ selectors: (m[1] ?? '').split(',').map((s) => s.trim()), body: m[2] ?? '' }));

describe('screenshot guard stylesheet', () => {
  const css = buildScreenshotGuardCss();
  const [hideRuleMaybe, secretRuleMaybe] = rulesOf(css);
  const hideRule = hideRuleMaybe as Rule;
  const secretRule = secretRuleMaybe as Rule;

  it('hides every AntiFan overlay node and every platform preview chrome node from the shared list', () => {
    for (const selector of [...ANTIFAN_OVERLAY_SELECTORS, ...PLATFORM_PREVIEW_CHROME_SELECTORS]) {
      assert.ok(hideRule.selectors.includes(selector), `${selector} is hidden`);
    }
    assert.match(hideRule.body, /display:\s*none\s*!important/);
  });

  it('keeps the AntiFan overlay ids the capture suppresses', () => {
    for (const id of ['#__antifan_agent_overlay__', '#__antifan_agent_cursor__', '#__antifan_agent_highlight__', '#__antifan_agent_banner__']) {
      assert.ok(hideRule.selectors.includes(id), id);
    }
  });

  it('masks password inputs and agent-typed secrets without hiding their box', () => {
    assert.deepEqual(secretRule.selectors, ['input[type="password"]', `[${SECRET_FIELD_ATTRIBUTE}]`]);
    assert.match(secretRule.body, /color:\s*transparent\s*!important/);
    assert.match(secretRule.body, /-webkit-text-security:\s*disc\s*!important/);
    assert.match(secretRule.body, /text-shadow:\s*none\s*!important/);
    assert.doesNotMatch(secretRule.body, /display:\s*none|visibility:\s*hidden/);
  });
});

describe('screenshot guard install snippet', () => {
  type FakeEl = { id: string; textContent: string };
  const fakeDocument = () => {
    const head: FakeEl[] = [];
    return {
      head: { appendChild: (el: FakeEl) => { head.push(el); } },
      documentElement: { appendChild: (el: FakeEl) => { head.push(el); } },
      createElement: (_tag: string): FakeEl => ({ id: '', textContent: '' }),
      getElementById: (id: string) => head.find((el) => el.id === id) ?? null,
      installed: head,
    };
  };
  const run = (snippet: string, document: ReturnType<typeof fakeDocument>) => new Function('document', snippet)(document);

  it('installs the guard stylesheet once, with the password rule in it', () => {
    const document = fakeDocument();
    const snippet = buildScreenshotGuardInstallSnippet();
    run(snippet, document);
    run(snippet, document);
    assert.equal(document.installed.length, 1);
    const installed = document.installed[0] as FakeEl;
    assert.equal(installed.id, SCREENSHOT_GUARD_STYLE_ID);
    assert.equal(installed.textContent, buildScreenshotGuardCss());
    assert.match(installed.textContent, /input\[type="password"\]/);
  });
});

describe('secret field marking', () => {
  it('marks the focused field, looking through open shadow roots, and never reads its value', () => {
    const marked: Array<[string, string]> = [];
    const inner = { setAttribute: (name: string, value: string) => marked.push([name, value]), value: 'must-not-be-read' };
    const host = { shadowRoot: { activeElement: inner }, setAttribute: () => { throw new Error('the shadow host is not the field'); } };
    const body = {};
    const document = { activeElement: host, body };
    const script = buildSecretFieldMarkScript();
    assert.equal(new Function('document', `return ${script};`)(document), true);
    assert.deepEqual(marked, [[SECRET_FIELD_ATTRIBUTE, '1']]);
    assert.doesNotMatch(script, /\.value\b/);
  });

  it('marks nothing when no field has focus', () => {
    const body = {};
    assert.equal(new Function('document', `return ${buildSecretFieldMarkScript()};`)({ activeElement: body, body }), false);
  });
});

describe('capture sites and snapshots', () => {
  const hostSource = fs.readFileSync(path.resolve(__dirname, '../../../../src/main/browser/tab-devtools-host.ts'), 'utf8');

  it('both capture paths install the shared guard and carry no private preview-chrome selector list', () => {
    const installs = hostSource.match(/buildScreenshotGuardInstallSnippet\(\)/g) ?? [];
    assert.ok(installs.length >= 2, `expected both capture paths to use the shared snippet, found ${installs.length}`);
    assert.doesNotMatch(hostSource, /preview-bar|bizweb-theme-previewer|haravan-notification/);
  });

  it('the semantic snapshot collector never reads a field value, so a password cannot reach a snapshot', () => {
    const script = buildIsolatedCollectorScript('nonce', 'https://shop.example/', undefined, false);
    assert.doesNotMatch(script, /\.value\b/);
    assert.doesNotMatch(script, /\bvalueAsNumber\b|\.defaultValue\b/);
  });
});
