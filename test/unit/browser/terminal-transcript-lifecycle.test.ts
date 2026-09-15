import { describe, it, beforeEach } from 'node:test';
import * as assert from 'node:assert/strict';
import { CLEAR_SCREEN_COMMAND_RE, SessionDeliveryJournal, safeSliceTailJsonBounded } from '../../../src/main/browser/terminal-manager';

describe('Phase 2: Terminal Transcript Lifecycle & Eviction Invariants', () => {
  describe('SessionDeliveryJournal O(1) head-index eviction', () => {
    let journal: SessionDeliveryJournal;

    beforeEach(() => {
      journal = new SessionDeliveryJournal();
    });

    it('appends and retrieves chunks accurately with monotonic seq', () => {
      journal.append(1, 1, 'chunk-1');
      journal.append(1, 2, 'chunk-2');
      journal.append(1, 3, 'chunk-3');

      const delta = journal.getDelta(1, 1);
      assert.strictEqual(delta.status, 'OK');
      if (delta.status === 'OK') {
        assert.strictEqual(delta.chunks.length, 3);
        assert.strictEqual(delta.fromSeq, 1);
        assert.strictEqual(delta.throughSeq, 3);
        assert.deepStrictEqual(delta.chunks.map(c => c.seq), [1, 2, 3]);
      }
    });

    it('returns empty chunk list when requested seq is higher than retained range', () => {
      journal.append(1, 1, 'chunk-1');
      journal.append(1, 2, 'chunk-2');

      const delta = journal.getDelta(1, 5);
      assert.strictEqual(delta.status, 'OK');
      if (delta.status === 'OK') {
        assert.strictEqual(delta.chunks.length, 0);
        assert.strictEqual(delta.throughSeq, 2);
      }
    });

    it('reports DELTA_EXPIRED when fromSeq is behind retained window', () => {
      // Exceed MAX_CHUNKS (4096) to force eviction
      for (let i = 1; i <= 4100; i++) {
        journal.append(1, i, `x`);
      }

      const range = journal.getRetainedRange();
      assert.ok(range.fromSeq > 1, `retainedFromSeq should be > 1 after eviction, was ${range.fromSeq}`);

      const expiredDelta = journal.getDelta(1, 1);
      assert.strictEqual(expiredDelta.status, 'DELTA_EXPIRED');
      if (expiredDelta.status === 'DELTA_EXPIRED') {
        assert.strictEqual(expiredDelta.retainedFromSeq, range.fromSeq);
        assert.strictEqual(expiredDelta.retainedThroughSeq, 4100);
      }
    });

    it('clears all retained chunks cleanly without breaking subsequent appends', () => {
      journal.append(1, 1, 'first');
      journal.clear();

      const emptyRange = journal.getRetainedRange();
      assert.strictEqual(emptyRange.chunks, 0);
      assert.strictEqual(emptyRange.bytes, 0);

      journal.append(1, 2, 'after-clear');
      const delta = journal.getDelta(1, 2);
      assert.strictEqual(delta.status, 'OK');
      if (delta.status === 'OK') {
        assert.strictEqual(delta.chunks.length, 1);
        assert.strictEqual(delta.chunks[0]?.data, 'after-clear');
      }
    });
  });

  describe('Rolling Clear Screen Detection Pattern', () => {
    // Asserted against the shipped constant, never a local copy: the duplicated
    // pattern this block used to hold is exactly how a case-sensitivity defect
    // stayed hidden behind a green spec.
    const clearPattern = CLEAR_SCREEN_COMMAND_RE;

    it('recognizes standard cls command on enter', () => {
      assert.strictEqual(clearPattern.test('cls'), true);
      assert.strictEqual(clearPattern.test('  cls  '), true);
    });

    it('recognizes unix clear alias', () => {
      assert.strictEqual(clearPattern.test('clear'), true);
      assert.strictEqual(clearPattern.test('\tclear '), true);
    });

    it('recognizes PowerShell Clear-Host', () => {
      assert.strictEqual(clearPattern.test('Clear-Host'), true);
      assert.strictEqual(clearPattern.test('clear-host'), true);
      assert.strictEqual(clearPattern.test('CLEAR-HOST'), true);
    });

    it('recognizes any casing of cls/clear, because PowerShell and cmd.exe are case-insensitive', () => {
      assert.strictEqual(clearPattern.test('CLS'), true);
      assert.strictEqual(clearPattern.test('Cls'), true);
      assert.strictEqual(clearPattern.test('CLEAR'), true);
      assert.strictEqual(clearPattern.test('  Clear  '), true);
    });

    it('rejects commands that merely contain cls or clear as substring', () => {
      assert.strictEqual(clearPattern.test('cls && npm start'), false);
      assert.strictEqual(clearPattern.test('echo clear'), false);
      assert.strictEqual(clearPattern.test('clear_cache.py'), false);
      assert.strictEqual(clearPattern.test('vim cls.txt'), false);
      assert.strictEqual(clearPattern.test('CLS && npm start'), false);
      assert.strictEqual(clearPattern.test('Clear-Host -Force'), false);
    });
  });

  describe('Alt-Screen Detection Guard', () => {
    const isAltScreenEnter = (data: string) => /\x1b\[\?1049h/.test(data);
    const isAltScreenExit = (data: string) => /\x1b\[\?1049l/.test(data);

    it('detects xterm alt-screen buffer switch (vim, htop, less)', () => {
      assert.strictEqual(isAltScreenEnter('some text\x1b[?1049hmore text'), true);
      assert.strictEqual(isAltScreenEnter('regular output'), false);
      assert.strictEqual(isAltScreenExit('exit\x1b[?1049l'), true);
      assert.strictEqual(isAltScreenExit('regular output'), false);
    });
  });

  describe('safeSliceTailJsonBounded UTF-8 multi-byte integrity', () => {
    it('preserves valid UTF-8 strings within budget without trailing split characters', () => {
      const sample = 'Xin chào thế giới terminal AntiFan\nĐang kiểm tra scrollback\n';
      const bounded = safeSliceTailJsonBounded(sample, 1024);
      assert.ok(bounded.length > 0);
      assert.ok(!bounded.includes('\ufffd'), 'Should not contain replacement characters');
    });
  });
});
