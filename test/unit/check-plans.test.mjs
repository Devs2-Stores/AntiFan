import { describe, it } from 'node:test';
import * as assert from 'node:assert';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const scriptPath = path.resolve('scripts/check-plans.mjs');

function writePlan(root, name, statusLine) {
  const dir = path.join(root, name);
  fs.mkdirSync(dir, { recursive: true });
  const frontmatter = statusLine === null ? '' : `---\nname: ${name}\n${statusLine}\n---\n`;
  fs.writeFileSync(path.join(dir, 'plan.md'), `${frontmatter}# ${name}\n`, 'utf8');
}

function runGate(root) {
  return spawnSync(process.execPath, [scriptPath, '--root', root, '--json'], { encoding: 'utf8' });
}

describe('plan status gate', () => {
  it('classifies recognized spellings into buckets and accepts a plan without frontmatter', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'antifan-plans-'));
    try {
      writePlan(root, 'plan-a', 'status: completed');
      writePlan(root, 'plan-b', 'status: in-progress');
      writePlan(root, 'plan-c', null);

      const result = runGate(root);
      assert.strictEqual(result.status, 0, result.stderr || result.stdout);
      const summary = JSON.parse(result.stdout);
      assert.strictEqual(summary.plans, 3);
      assert.strictEqual(summary.withoutFrontmatter, 1);
      assert.strictEqual(summary.buckets.done.count, 1);
      assert.strictEqual(summary.buckets.active.count, 1);
      assert.deepStrictEqual(summary.unknown, []);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('fails the gate on an unrecognized spelling instead of silently ignoring the field', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'antifan-plans-bad-'));
    try {
      writePlan(root, 'plan-d', 'status: half-done');

      const result = runGate(root);
      assert.strictEqual(result.status, 1, 'an unknown status must fail the gate');
      const summary = JSON.parse(result.stdout);
      assert.strictEqual(summary.unknown.length, 1);
      assert.strictEqual(summary.unknown[0].status, 'half-done');
      assert.strictEqual(summary.classified, 0);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('gates the repository plan tree itself', () => {
    const result = runGate(path.resolve('plans'));
    assert.strictEqual(result.status, 0, result.stderr || result.stdout);
    const summary = JSON.parse(result.stdout);
    assert.ok(summary.classified > 0, 'the repository must contain classified plans');
    assert.strictEqual(summary.unknown.length, 0);
  });
});
