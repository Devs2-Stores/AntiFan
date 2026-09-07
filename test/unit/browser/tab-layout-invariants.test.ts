import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';

describe('Toolbar Tab Layout Invariants (Anti-Jitter Contract)', () => {
  const cssPath = path.resolve(__dirname, '../../../../src/renderer/toolbar.css');
  const cssContent = fs.readFileSync(cssPath, 'utf8');

  it('declares explicit width: 240px on .tab to prevent content-length width fluctuation', () => {
    // Extract .tab selector block
    const tabMatch = cssContent.match(/\.tab\s*\{([^}]+)\}/);
    assert.ok(tabMatch, '.tab rule must exist in toolbar.css');
    const tabBody = tabMatch[1] ?? '';

    // Must have explicit width matching flex-basis
    assert.match(tabBody, /\bwidth:\s*240px;/, '.tab must declare explicit width: 240px');
    assert.match(tabBody, /\bmax-width:\s*240px;/, '.tab must declare max-width: 240px');
    assert.match(tabBody, /\bmin-width:\s*60px;/, '.tab must declare min-width: 60px');
    assert.match(tabBody, /\bflex:\s*0\s+1\s+240px;/, '.tab must declare flex: 0 1 240px');
  });

  it('does not transition max-width on .tab to avoid animation reflow during updates', () => {
    const tabMatch = cssContent.match(/\.tab\s*\{([^}]+)\}/);
    assert.ok(tabMatch);
    const tabBody = tabMatch[1] ?? '';
    assert.doesNotMatch(tabBody, /transition:[^;]*max-width/, '.tab must not transition max-width');
  });
});

describe('Terminal Tab Layout Invariants (Full-Name & Anti-Jitter Contract)', () => {
  const cssPath = path.resolve(__dirname, '../../../../src/renderer/standalone.css');
  const cssContent = fs.readFileSync(cssPath, 'utf8');

  it('declares a non-shrinkable, uncapped wrapper so tab names always show fully', () => {
    const wrapMatch = cssContent.match(/\.terminal-tab-wrap\s*\{([^}]+)\}/);
    assert.ok(wrapMatch, '.terminal-tab-wrap rule must exist in standalone.css');
    const wrapBody = wrapMatch[1] ?? '';

    assert.match(wrapBody, /\bflex:\s*0\s+0\s+auto;/, '.terminal-tab-wrap must be non-shrinkable (flex: 0 0 auto)');
    assert.doesNotMatch(wrapBody, /\bmax-width\s*:/, '.terminal-tab-wrap must NOT declare any max-width cap');
  });

  it('declares non-shrinking, non-truncating title that renders the full tab name', () => {
    const titleMatch = cssContent.match(/\.terminal-tab-title\s*\{([^}]+)\}/);
    assert.ok(titleMatch, '.terminal-tab-title rule must exist in standalone.css');
    const titleBody = titleMatch[1] ?? '';

    assert.match(titleBody, /\bwhite-space:\s*nowrap;/, '.terminal-tab-title must declare white-space: nowrap');
    assert.match(titleBody, /\bflex:\s*0\s+0\s+auto;/, '.terminal-tab-title must be non-shrinkable (flex: 0 0 auto)');
    assert.doesNotMatch(titleBody, /\bmax-width\s*:/, '.terminal-tab-title must NOT declare any max-width');
    assert.doesNotMatch(titleBody, /\btext-overflow\s*:/, '.terminal-tab-title must NOT declare text-overflow ellipsis');
  });

  it('declares compact fixed width: 78px on .terminal-tab-affinity-badge for jitter-free stability', () => {
    const badgeMatch = cssContent.match(/\.terminal-tab-affinity-badge\s*\{([^}]+)\}/);
    assert.ok(badgeMatch, '.terminal-tab-affinity-badge rule must exist in standalone.css');
    const badgeBody = badgeMatch[1] ?? '';

    assert.match(badgeBody, /\bwidth:\s*78px;/, '.terminal-tab-affinity-badge must declare fixed width: 78px');
    assert.match(badgeBody, /\boverflow:\s*hidden;/, '.terminal-tab-affinity-badge must declare overflow: hidden');
    assert.match(badgeBody, /\btext-overflow:\s*ellipsis;/, '.terminal-tab-affinity-badge must declare text-overflow: ellipsis');
  });
});
