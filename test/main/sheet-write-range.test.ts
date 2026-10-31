// anti.sheet.write_range runs the single-cell write pipeline once per cell and stops at the first cell that
// is not confirmed. These tests use the shared sheet fixture, so every gate of a single write is the real one.
import { describe, it } from 'node:test';
import * as assert from 'node:assert';
import { makeSheet, refusal, withFakeTime } from './sheet-fixture';

interface CellRow {
  cell: string;
  status: string;
  verified: boolean;
}

describe('anti.sheet.write_range', () => {
  it('writes the block row by row, verifies every cell and reports each one', async () => {
    const sheet = makeSheet({ grid: { B2: 'old' } });
    const res = await sheet.writeRange({ cell: 'b2', values: [['a', 'b', 'c'], ['d', 'e', 'f']] });
    assert.strictEqual(res.success, true);
    assert.strictEqual(res.complete, true);
    assert.strictEqual(res.total, 6);
    assert.strictEqual(res.written, 6);
    const cells = res.cells as CellRow[];
    assert.deepStrictEqual(
      cells.map((c) => c.cell),
      ['B2', 'C2', 'D2', 'B3', 'C3', 'D3'],
      'row-major order starting at the anchor'
    );
    assert.ok(cells.every((c) => c.status === 'VERIFIED' && c.verified), 'every cell went through the independent read-back');
    assert.deepStrictEqual(
      { B2: sheet.grid.B2, C2: sheet.grid.C2, D2: sheet.grid.D2, B3: sheet.grid.B3, C3: sheet.grid.C3, D3: sheet.grid.D3 },
      { B2: 'a', C2: 'b', D2: 'c', B3: 'd', C3: 'e', D3: 'f' }
    );
    assert.strictEqual(sheet.typedIntoFormulaBar().length, 6, 'one editor write per cell, never a bulk paste');
    assert.strictEqual((cells[0] as CellRow & { previous?: string }).previous, 'old');
  });

  it('stops at the first cell that is not confirmed and leaves the rest untouched', async () => {
    const sheet = makeSheet({ draftSticksCells: ['C2'] });
    const res = await sheet.writeRange({ cell: 'B2', values: [['a', 'b'], ['c', 'd']], confirmTimeoutMs: 0 });
    assert.strictEqual(res.success, false);
    assert.strictEqual(res.complete, false);
    assert.strictEqual(res.stopped, 'unverified');
    assert.strictEqual(res.written, 1);
    assert.strictEqual(res.notAttempted, 2);
    const failedAt = res.failedAt as { index: number; cell: string; status: string };
    assert.deepStrictEqual({ index: failedAt.index, cell: failedAt.cell, status: failedAt.status }, { index: 1, cell: 'C2', status: 'SAVED_UNCONFIRMED' });
    assert.strictEqual((res.cells as CellRow[]).length, 2, 'the failing cell is listed, later cells are not');
    assert.strictEqual(sheet.grid.B2, 'a');
    assert.strictEqual(sheet.grid.B3, undefined);
    assert.strictEqual(sheet.grid.C3, undefined);
    assert.strictEqual(sheet.typedIntoFormulaBar().length, 2);
  });

  it('turns a refused cell into failedAt with its code and stops (protected range)', async () => {
    const sheet = makeSheet({ protectedCells: ['C2'] });
    const res = await sheet.writeRange({ cell: 'B2', values: [['a', 'b', 'c']] });
    assert.strictEqual(res.success, false);
    assert.strictEqual(res.stopped, 'error');
    const failedAt = res.failedAt as { cell: string; code: string; details?: Record<string, unknown> };
    assert.strictEqual(failedAt.cell, 'C2');
    assert.strictEqual(failedAt.code, 'SHEET_PROTECTED_RANGE');
    assert.match(String(failedAt.details?.dialogText), /protected/);
    assert.strictEqual(sheet.grid.B2, 'a');
    assert.strictEqual(sheet.grid.D2, undefined);
  });

  it('checks expectedPrevious per cell and stops where a cell differs', async () => {
    const sheet = makeSheet({ grid: { B2: 'one', C2: 'drifted' } });
    const res = await sheet.writeRange({ cell: 'B2', values: [['x', 'y']], expectedPrevious: [['one', 'two']] });
    assert.strictEqual(res.success, false);
    assert.strictEqual((res.failedAt as { code: string }).code, 'SHEET_PRECONDITION_FAILED');
    assert.strictEqual(sheet.grid.B2, 'x');
    assert.strictEqual(sheet.grid.C2, 'drifted');
  });

  it('keeps going past a formula cell: the editor confirmed it, so success stays true', async () => {
    const sheet = makeSheet();
    const res = await sheet.writeRange({ cell: 'B2', values: [['1', '=SUM(B2:B3)', '3']] });
    assert.strictEqual(res.success, true);
    assert.strictEqual(res.formulaEditorConfirmed, 1);
    assert.deepStrictEqual((res.cells as CellRow[]).map((c) => c.status), ['VERIFIED', 'FORMULA_EDITOR_CONFIRMED', 'VERIFIED']);
    assert.strictEqual(sheet.grid.D2, '3');
  });

  it('applies mode append to every cell', async () => {
    const sheet = makeSheet({ grid: { B2: 'a', C2: 'b' } });
    const res = await sheet.writeRange({ cell: 'B2', values: [['1', '2']], mode: 'append' });
    assert.strictEqual(res.success, true);
    assert.strictEqual(sheet.grid.B2, 'a1');
    assert.strictEqual(sheet.grid.C2, 'b2');
  });

  it('refuses a range that starts in the header row unless allowHeader is set, before touching the page', async () => {
    const sheet = makeSheet();
    const err = await refusal(sheet.writeRange({ cell: 'A1', values: [['x']] }));
    assert.strictEqual(err.code, 'SHEET_HEADER_PROTECTED');
    assert.deepStrictEqual(sheet.calls, []);
    const allowed = await sheet.writeRange({ cell: 'A1', values: [['x', 'y']], allowHeader: true });
    assert.strictEqual(allowed.success, true);
    assert.strictEqual(sheet.grid.B1, 'y');
  });

  it('rejects malformed arguments before touching the page', async () => {
    const sheet = makeSheet();
    const bad: Array<Record<string, unknown>> = [
      { cell: 'A2:B3', values: [['x']] },
      { cell: 'A2' },
      { cell: 'A2', values: [] },
      { cell: 'A2', values: ['x'] },
      { cell: 'A2', values: [[]] },
      { cell: 'A2', values: [[{ nested: true }]] },
      { cell: 'A2', values: [[1, null]] },
      { cell: 'A2', values: [['x', 'y']], expectedPrevious: [['x']] },
      { cell: 'A2', values: [['x']], mode: 'prepend' },
      { cell: 'A2', values: [['x']], gid: 5 },
      { cell: 'ZZZ2', values: [['x', 'y']] },
      { cell: 'A2', values: Array.from({ length: 11 }, () => Array.from({ length: 10 }, () => 'x')) },
    ];
    for (const params of bad) {
      const err = await refusal(sheet.writeRange(params));
      assert.strictEqual(err.code, 'INVALID_ARGUMENT', JSON.stringify(params).slice(0, 80));
    }
    assert.deepStrictEqual(sheet.calls, []);
  });

  it('stops starting new cells when the range budget runs out and names the cell to continue from', async () => {
    // Every cell waits for 8 lagging GViz reads (about 18 s), so about ten cells fit in the 200 s budget.
    const sheet = makeSheet({ gvizLagReads: 8 });
    const values = Array.from({ length: 14 }, (_, i) => [`v${i}`]);
    const res = await withFakeTime(() => sheet.writeRange({ cell: 'A2', values }));
    assert.strictEqual(res.success, false);
    assert.strictEqual(res.complete, false);
    assert.strictEqual(res.stopped, 'budget');
    const written = res.written as number;
    assert.ok(written >= 6 && written < 14, `written ${written}`);
    assert.strictEqual(res.nextCell, `A${2 + written}`);
    assert.strictEqual(res.notAttempted, 14 - written);
    assert.ok((res.cells as CellRow[]).every((c) => c.verified), 'every listed cell is confirmed');
    assert.strictEqual(sheet.grid[`A${2 + written}`], undefined, 'the next cell was not started');
  });

  it('is a mutating capability with a budget that fits the proxy ceiling', () => {
    const sheet = makeSheet();
    const cap = sheet.catalogue.get('anti.sheet.write_range');
    assert.strictEqual(cap?.risk, 'write');
    assert.notStrictEqual(sheet.catalogue.getPolicy('anti.sheet.write_range')?.effect, 'read');
    const policy = sheet.catalogue.getPolicy('anti.sheet.write_range');
    assert.strictEqual(policy?.timeoutMs, 210_000);
    assert.ok((policy?.timeoutMs ?? Infinity) < 240_000);
    assert.deepStrictEqual((cap?.inputSchema as { required: string[] }).required, ['cell', 'values']);
  });
});
