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
  it('classifies recognized spellings into buckets', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'antifan-plans-'));
    try {
      writePlan(root, 'plan-a', 'status: completed');
      writePlan(root, 'plan-b', 'status: in-progress');

      const result = runGate(root);
      assert.strictEqual(result.status, 0, result.stderr || result.stdout);
      const summary = JSON.parse(result.stdout);
      assert.strictEqual(summary.plans, 2);
      assert.strictEqual(summary.withoutFrontmatter, 0);
      assert.strictEqual(summary.buckets.done.count, 1);
      assert.strictEqual(summary.buckets.active.count, 1);
      assert.deepStrictEqual(summary.unknown, []);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('fails a plan without frontmatter rather than dropping it from the summary', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'antifan-plans-nofm-'));
    try {
      writePlan(root, 'plan-a', 'status: completed');
      writePlan(root, 'plan-b', 'status: in-progress');
      writePlan(root, 'plan-c', null);

      const result = runGate(root);
      assert.strictEqual(result.status, 1, 'a plan with no status must fail the gate');
      const summary = JSON.parse(result.stdout);
      assert.strictEqual(summary.plans, 3);
      assert.strictEqual(summary.withoutFrontmatter, 1, 'the unannotated plan must still be counted');
      assert.strictEqual(summary.classified, 2);
      assert.deepStrictEqual(summary.unknown, [], 'a missing status is not an unrecognized spelling');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('names the unannotated plan in the human-readable report', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'antifan-plans-msg-'));
    try {
      writePlan(root, 'plan-c', null);

      const result = spawnSync(process.execPath, [scriptPath, '--root', root], { encoding: 'utf8' });
      assert.strictEqual(result.status, 1);
      assert.match(result.stdout, /missing status frontmatter in .*plan-c/);
      assert.match(result.stdout, /no-frontmatter=1/);
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

  it('fails a plan whose frontmatter omits the status field', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'antifan-plans-bare-'));
    try {
      writePlan(root, 'plan-e', 'name: plan-e');

      const result = runGate(root);
      assert.strictEqual(result.status, 1);
      const summary = JSON.parse(result.stdout);
      assert.strictEqual(summary.unknown.length, 1);
      assert.strictEqual(summary.unknown[0].status, '');
      assert.strictEqual(summary.withoutFrontmatter, 0);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('gates the repository plan tree itself', () => {
    const result = runGate(path.resolve('plans'));
    assert.strictEqual(result.status, 0, result.stderr || result.stdout);
    const summary = JSON.parse(result.stdout);
    assert.ok(summary.classified > 0, 'the repository must contain classified plans');
    assert.strictEqual(summary.withoutFrontmatter, 0, 'every repository plan must carry a status');
    assert.strictEqual(summary.unknown.length, 0);
  });
});
