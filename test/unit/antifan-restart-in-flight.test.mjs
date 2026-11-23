/**
 * The in-flight MCP call count `scripts/antifan-restart.ps1` reports before it asks the app to quit.
 *
 * The count is read from the invocation journal the control plane persists, so this file drives the
 * script itself (`-ReportInFlightOnly`, which prints the line and exits before the app is touched)
 * against fixture journals. What is asserted is the rule the ledger's own replay relies on: the last
 * frame recorded for one invocation decides its state, a frame that cannot be read makes the answer
 * `unknown` instead of a smaller number, and a journal that does not exist is `unknown` too.
 */

import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const script = path.join(repo, 'scripts', 'antifan-restart.ps1');

let tmp = '';

before(() => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'antifan-in-flight-')));
});

after(() => {
  if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
});

/** A data root whose journal holds the given partitions (`{ name: [frame, ...] }`), one JSON line each. */
function journalRoot(name, partitions) {
  const root = path.join(tmp, name);
  const dir = path.join(root, 'control-plane-v2', 'invocations');
  fs.mkdirSync(dir, { recursive: true });
  for (const [file, frames] of Object.entries(partitions)) {
    const lines = frames.map((frame) => (typeof frame === 'string' ? frame : JSON.stringify(frame))).join('\n');
    fs.writeFileSync(path.join(dir, file), `${lines}\n`, 'utf8');
  }
  return root;
}

/** The frame shape the ledger writes; only the fields the count reads are spelled out. */
const frame = (idempotencyKey, state) => ({ formatVersion: 1, idempotencyKey, state });

function report(dataRoot) {
  return execFileSync(
    'powershell',
    ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script, '-ReportInFlightOnly', '-DataRoot', dataRoot],
    { cwd: repo, encoding: 'utf8', timeout: 120_000 }
  );
}

describe('in-flight MCP call count', () => {
  it('counts the last frame of each invocation, per partition, and ignores terminal states', () => {
    const root = journalRoot('mixed', {
      'a.jsonl': [
        frame('k1', 'in_progress'),
        frame('k2', 'in_progress'),
        frame('k2', 'completed'),
        frame('k3', 'claiming'),
      ],
      'b.jsonl': [
        frame('k1', 'in_progress'),
        frame('k4', 'unknown'),
        frame('k5', 'interrupted'),
        frame('k6', 'failed'),
      ],
    });

    assert.equal(report(root).trim(), 'in-flight MCP calls: 3');
  });

  it('answers 0 for a journal that exists and holds only settled frames', () => {
    const root = journalRoot('settled', {
      'a.jsonl': [frame('k1', 'completed'), frame('k2', 'failed'), frame('k3', 'interrupted')],
    });

    assert.equal(report(root).trim(), 'in-flight MCP calls: 0');
  });

  it('answers unknown, never a partial count, when a frame cannot be read', () => {
    const root = journalRoot('corrupt', {
      'a.jsonl': [frame('k1', 'in_progress'), '{"formatVersion":1,"idempotencyKey":"k2"'],
      'b.jsonl': [frame('k3', 'in_progress')],
    });

    const line = report(root).trim();
    assert.match(line, /^in-flight MCP calls: unknown \(unreadable invocation frame in a\.jsonl\)$/);
  });

  it('answers unknown when the app has no journal under the data root', () => {
    const root = path.join(tmp, 'empty');
    fs.mkdirSync(root, { recursive: true });

    const line = report(root).trim();
    assert.match(line, /^in-flight MCP calls: unknown \(no invocation journal at .*control-plane-v2\\invocations\)$/);
  });
});
