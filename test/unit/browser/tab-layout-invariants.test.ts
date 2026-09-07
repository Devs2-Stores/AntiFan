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
