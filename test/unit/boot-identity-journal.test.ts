import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
  appendBootIdentity,
  BOOT_IDENTITY_JOURNAL_KEEP_LINES,
  BOOT_IDENTITY_JOURNAL_MAX_BYTES,
} from '../../src/main/config/boot-identity-journal';

describe('boot identity journal', () => {
  let dir = '';

  before(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'antifan-boot-identity-'));
  });

  after(() => {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
  });

  function readLines(file: string): Array<Record<string, unknown>> {
    return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line));
  }

  it('appends one JSON line per call, creating the directory, with the identity fields', () => {
    const file = path.join(dir, 'nested', 'runtime', 'instance-boots.jsonl');
    assert.equal(appendBootIdentity(file, {
      pid: 101, ppid: 100, userData: 'U:/profile', dataRoot: 'U:/data', bridgePort: null, argv: ['.', '--allow-eval'], gotLock: null,
    }), true);
    assert.equal(appendBootIdentity(file, { pid: 101, gotLock: false }), true);

    const lines = readLines(file);
    assert.equal(lines.length, 2);
    assert.equal(lines[0]!.pid, 101);
    assert.equal(lines[0]!.ppid, 100);
    assert.equal(lines[0]!.dataRoot, 'U:/data');
    assert.equal(lines[0]!.userData, 'U:/profile');
    assert.equal(lines[0]!.gotLock, null);
    assert.deepEqual(lines[0]!.argv, ['.', '--allow-eval']);
    assert.equal(typeof lines[0]!.iso, 'string');
    assert.equal(Number.isNaN(Date.parse(lines[0]!.iso as string)), false);
    assert.equal(lines[1]!.gotLock, false);
  });

  it('cuts an oversized journal down to its newest lines before appending', () => {
    const file = path.join(dir, 'trim.jsonl');
    const filler = 'x'.repeat(1024);
    const seeded: string[] = [];
    for (let i = 0; i < 400; i += 1) seeded.push(JSON.stringify({ pid: i, filler }));
    fs.writeFileSync(file, `${seeded.join('\n')}\n`, 'utf8');
    assert.ok(fs.statSync(file).size > BOOT_IDENTITY_JOURNAL_MAX_BYTES, 'precondition: journal is over the cap');

    assert.equal(appendBootIdentity(file, { pid: 9999 }), true);

    const lines = readLines(file);
    assert.equal(lines.length, BOOT_IDENTITY_JOURNAL_KEEP_LINES + 1);
    assert.equal(lines[0]!.pid, 400 - BOOT_IDENTITY_JOURNAL_KEEP_LINES, 'the oldest lines went first');
    assert.equal(lines.at(-1)!.pid, 9999, 'the new line is last');
  });

  it('never throws when the file cannot be written', () => {
    const blocker = path.join(dir, 'blocker');
    fs.writeFileSync(blocker, 'a file where a directory is needed', 'utf8');
    assert.equal(appendBootIdentity(path.join(blocker, 'instance-boots.jsonl'), { pid: 1 }), false);
  });
});
