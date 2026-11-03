/**
 * Memory holders: the commit warning names the terminals whose whole process trees hold the most
 * private memory, so the ranking must credit every descendant once, never follow a pid-reuse cycle
 * forever, and read both process-table formats Windows can answer with.
 */
import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import {
  parseMemoryProcessLines,
  parseMemoryWmicCsv,
  rankTerminalHolders,
  type MemoryProcessRow,
} from '../../src/main/diagnostics/memory-holders';

const MB = 1024 ** 2;
const row = (pid: number, ppid: number, name: string, mb: number): MemoryProcessRow => ({ pid, ppid, name, privateBytes: mb * MB });

describe('rankTerminalHolders', () => {
  const rows = [
    row(10, 1, 'powershell.exe', 50),
    row(11, 10, 'omp.exe', 900),
    row(12, 11, 'omp.exe', 300),
    row(13, 12, 'python.exe', 2000),
    row(20, 1, 'powershell.exe', 60),
    row(21, 20, 'omp.exe', 1200),
    row(30, 1, 'powershell.exe', 40),
  ];
  const terminals = [
    { id: 't-a', name: 'A', shellPid: 10 },
    { id: 't-b', name: 'B', shellPid: 20 },
    { id: 't-c', name: 'C', shellPid: 30 },
  ];

  it('sums each shell tree, counts its agents and ranks largest first', () => {
    const ranked = rankTerminalHolders(rows, terminals, 5);
    assert.deepEqual(ranked.map((h) => [h.id, h.privateBytes / MB, h.agents, h.processes]), [
      ['t-a', 3250, 2, 4],
      ['t-b', 1260, 1, 2],
      ['t-c', 40, 0, 1],
    ]);
  });

  it('keeps only the requested number of terminals', () => {
    assert.deepEqual(rankTerminalHolders(rows, terminals, 1).map((h) => h.id), ['t-a']);
  });

  it('skips a terminal whose shell is gone and never credits a process twice', () => {
    const ranked = rankTerminalHolders(rows, [
      { id: 't-gone', name: 'gone', shellPid: 99 },
      { id: 't-a', name: 'A', shellPid: 10 },
      // A stale summary naming a pid inside another terminal's tree adds nothing new.
      { id: 't-inner', name: 'inner', shellPid: 11 },
    ], 5);
    assert.deepEqual(ranked.map((h) => h.id), ['t-a']);
  });

  it('terminates on a parent cycle left by pid reuse', () => {
    const cyclic = [row(10, 12, 'powershell.exe', 1), row(11, 10, 'omp.exe', 1), row(12, 11, 'node.exe', 1)];
    const [holder] = rankTerminalHolders(cyclic, [{ id: 't', name: 't', shellPid: 10 }], 5);
    assert.equal(holder?.processes, 3);
  });
});

describe('process table parsers', () => {
  it('reads wmic csv from the right so a comma in a name cannot shift the numbers', () => {
    const csv = '\r\r\nNode,Name,ParentProcessId,PrivatePageCount,ProcessId\r\r\nPC,omp.exe,4692,524288000,17304\r\r\nPC,odd,name.exe,4,8192,77\r\r\n';
    assert.deepEqual(parseMemoryWmicCsv(csv), [
      { name: 'omp.exe', ppid: 4692, privateBytes: 524288000, pid: 17304 },
      { name: 'odd,name.exe', ppid: 4, privateBytes: 8192, pid: 77 },
    ]);
  });

  it('reads the PowerShell fallback lines and drops anything else', () => {
    assert.deepEqual(parseMemoryProcessLines('17304|4692|524288000|omp.exe\r\nWARNING: noise\r\n4|0|0|System\r\n'), [
      { pid: 17304, ppid: 4692, privateBytes: 524288000, name: 'omp.exe' },
      { pid: 4, ppid: 0, privateBytes: 0, name: 'System' },
    ]);
  });
});
