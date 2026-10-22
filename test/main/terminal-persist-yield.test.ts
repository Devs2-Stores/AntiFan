import { describe, it, before, after, beforeEach } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { TerminalManager } from '../../src/main/browser/terminal-manager';

/**
 * The terminal host persists every session's transcript tail on its only JS thread — the same
 * thread that forwards keystrokes to the PTYs. These tests pin the two properties that keep that
 * write from stalling typing: clean sessions reuse an already-encoded fragment, and the background
 * write yields between freshly serialized fragments.
 */
describe('TerminalManager background persist stays off the keystroke path', () => {
  const tm = TerminalManager.getInstance();
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'antifan-persist-yield-'));
  const testStateFile = path.join(tempDir, 'terminal-sessions.json');

  type FakeSession = {
    id: string;
    name: string;
    cwd: string;
    buffer: string;
    bufferBytes: number;
    lastSeq: number;
    state: 'running';
    pty: { cols: number; rows: number };
  };
  type Internals = {
    statePath: () => string;
    sessions: Map<string, FakeSession>;
    dirtySessionIds: Set<string>;
    persistedFragments: Map<string, { fragment: Buffer }>;
    serializeSessionFragment: (s: FakeSession) => Buffer;
    persistAsync: () => Promise<void>;
  };
  const internals = tm as unknown as Internals;
  const originalStatePath = internals.statePath.bind(tm);
  const originalSerialize = internals.serializeSessionFragment;

  const fakeSession = (id: string, buffer: string): FakeSession => ({
    id,
    name: `Terminal ${id}`,
    cwd: 'E:/Work/project',
    buffer,
    bufferBytes: Buffer.byteLength(buffer, 'utf8'),
    lastSeq: 1,
    state: 'running',
    pty: { cols: 120, rows: 30 },
  });

  const readDisk = (): { sessions: Array<{ id: string; buffer: string }> } =>
    JSON.parse(fs.readFileSync(testStateFile, 'utf8'));

  before(() => {
    internals.statePath = () => testStateFile;
  });

  beforeEach(() => {
    internals.serializeSessionFragment = originalSerialize;
    internals.sessions.clear();
    internals.dirtySessionIds.clear();
    internals.persistedFragments.clear();
    for (const id of ['a', 'b', 'c']) {
      internals.sessions.set(id, fakeSession(id, `── ${id}: Tôi phải sửa lại báo cáo \u001b[38;5;48m ✓\r\n`));
      internals.dirtySessionIds.add(id);
    }
  });

  after(async () => {
    internals.serializeSessionFragment = originalSerialize;
    internals.sessions.clear();
    await tm.dispose();
    internals.statePath = originalStatePath;
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('writes valid UTF-8 JSON and reuses the encoded fragment of a clean session', async () => {
    await internals.persistAsync();
    const disk = readDisk();
    assert.deepEqual(disk.sessions.map((s) => s.id), ['a', 'b', 'c']);
    assert.equal(disk.sessions[0]!.buffer, internals.sessions.get('a')!.buffer, 'non-ASCII transcript must round-trip byte-exact');
    assert.equal(internals.dirtySessionIds.size, 0, 'a confirmed write clears the dirty set');

    const cachedA = internals.persistedFragments.get('a')!.fragment;
    assert.ok(Buffer.isBuffer(cachedA), 'fragments are cached already encoded');

    const b = internals.sessions.get('b')!;
    b.buffer += 'mới\r\n';
    b.bufferBytes = Buffer.byteLength(b.buffer, 'utf8');
    b.lastSeq += 1;
    internals.dirtySessionIds.add('b');
    await internals.persistAsync();

    assert.equal(internals.persistedFragments.get('a')!.fragment, cachedA, 'a clean session must not be re-encoded');
    assert.equal(readDisk().sessions[1]!.buffer, b.buffer);
  });

  it('yields to the event loop after each freshly serialized fragment', async () => {
    const order: string[] = [];
    let scheduled = false;
    internals.serializeSessionFragment = function (this: unknown, s: FakeSession): Buffer {
      order.push(`fragment:${s.id}`);
      if (!scheduled) {
        scheduled = true;
        setImmediate(() => order.push('keystroke'));
      }
      return originalSerialize.call(this, s);
    };
    await internals.persistAsync();
    assert.deepEqual(order, ['fragment:a', 'keystroke', 'fragment:b', 'fragment:c']);
  });

  it('leaves out a session closed while the write was yielding', async () => {
    let closed = false;
    internals.serializeSessionFragment = function (this: unknown, s: FakeSession): Buffer {
      if (!closed) {
        closed = true;
        setImmediate(() => internals.sessions.delete('a'));
      }
      return originalSerialize.call(this, s);
    };
    await internals.persistAsync();
    assert.deepEqual(readDisk().sessions.map((s) => s.id), ['b', 'c']);
    assert.equal(internals.persistedFragments.has('a'), false, 'the closed session fragment must not stay cached');
  });
});
