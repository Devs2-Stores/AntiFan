import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { LayoutIntegrityEngine } from '../../src/main/qa/scanners/layout-integrity-engine';

function findRoot(): string {
  for (let dir = __dirname; ; dir = path.dirname(dir)) {
    if (fs.existsSync(path.join(dir, 'scripts', 'run-electron.cjs'))) return dir;
    if (path.dirname(dir) === dir) throw new Error('repository root not found');
  }
}

const root = findRoot();

interface ProbeFinding {
  kind: string;
  ruleId: string | null;
  severity: string;
  selector: string;
  relatedSelector: string | null;
  details: string;
}

interface ProbeResult {
  skipped: string | null;
  output: string;
  findings: ProbeFinding[];
}

/** One fixture through the real scan in a throwaway Electron window. */
function probe(id: string): ProbeResult {
  const run = spawnSync(process.execPath, ['scripts/run-electron.cjs', 'test/main/layout-integrity-sibling-content-probe.cjs', `--only=${id}`], {
    cwd: root, encoding: 'utf8', timeout: 120_000, windowsHide: true, env: { ...process.env, ELECTRON_ENABLE_LOGGING: '' },
  });
  const output = `${run.stdout || ''}${run.stderr || ''}`;
  const line = output.split(/\r?\n/).find((l) => l.startsWith('RESULT '));
  if (run.error || !line) {
    return { skipped: `Electron could not start here: ${run.error ? run.error.message : output.slice(-300)}`, output, findings: [] };
  }
  const parsed = JSON.parse(line.slice('RESULT '.length)) as { measured: boolean; truncated: boolean; findings: ProbeFinding[] };
  assert.equal(parsed.measured, true, output.slice(-800));
  assert.equal(parsed.truncated, false, 'the fixture scan must not be truncated');
  return { skipped: null, output, findings: parsed.findings };
}

const siblingFindings = (r: ProbeResult) => r.findings.filter((f) => f.ruleId === 'sibling-content-overlap');

test('the scan script carries the sibling-content-overlap rule in the same scan', () => {
  const script = LayoutIntegrityEngine.getBrowserScanScript('active');
  assert.ok(script.includes("'sibling-content-overlap'"));
  assert.ok(script.includes('siblingPairSeen(kids[a].k, kids[b].k)'), 'the in-flow rule must not list a pair the content rule reported');
});

test('two text siblings in a grid that overlap by 30% yield one warning naming both (Electron probe)', (t) => {
  const r = probe('grid-text-siblings-overlap');
  if (r.skipped) return t.skip(r.skipped);
  const found = siblingFindings(r);
  assert.equal(found.length, 1, r.output.slice(-1200));
  const finding = found[0];
  assert.ok(finding);
  assert.equal(finding.kind, 'overlap');
  assert.equal(finding.severity, 'warning');
  assert.match(finding.selector, /#bravo/);
  assert.match(finding.relatedSelector ?? '', /#alpha/);
  assert.match(finding.details, /#alpha/);
  assert.match(finding.details, /#bravo/);
  assert.equal(r.findings.filter((f) => f.severity === 'critical').length, 0, 'a warning never reads as a failure');
});

test('a button overlapping a text block in a flex row yields exactly one finding (Electron probe)', (t) => {
  const r = probe('flex-button-over-text-block');
  if (r.skipped) return t.skip(r.skipped);
  assert.equal(siblingFindings(r).length, 1, r.output.slice(-1200));
  assert.equal(r.findings.filter((f) => f.kind === 'overlap').length, 1, 'the in-flow rule does not repeat the same pair');
});

test('designed or out-of-scope overlap raises no sibling-content finding (Electron probe)', (t) => {
  for (const id of ['absolute-badge-inside-card', 'parent-child-pair', 'carousel-slides', 'sticky-header-over-content', 'different-z-index-layers', 'four-pixel-overlap']) {
    const r = probe(id);
    if (r.skipped) return t.skip(r.skipped);
    assert.deepEqual(siblingFindings(r), [], `${id}: ${r.output.slice(-1200)}`);
  }
});

test('a container with five overlapping pairs reports at most three (Electron probe)', (t) => {
  const r = probe('five-overlapping-pairs');
  if (r.skipped) return t.skip(r.skipped);
  assert.equal(siblingFindings(r).length, 3, r.output.slice(-1200));
});

test('a pair reported as text over text is not reported again (Electron probe)', (t) => {
  const r = probe('text-over-text-pair');
  if (r.skipped) return t.skip(r.skipped);
  assert.ok(r.findings.some((f) => f.kind === 'overlap' && f.severity === 'critical'), 'the stricter rule still fires');
  assert.deepEqual(siblingFindings(r), [], r.output.slice(-1200));
});
