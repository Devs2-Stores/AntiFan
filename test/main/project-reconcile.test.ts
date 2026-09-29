import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  reconcileProjectRecords,
  type ReconcileProjectRecordsInput,
} from '../../src/main/project/project-reconcile';

const P1 = 'project-00000000-0000-4000-8000-000000000001';
const P2 = 'project-00000000-0000-4000-8000-000000000002';
const P3 = 'project-00000000-0000-4000-8000-000000000003';
const P4 = 'project-00000000-0000-4000-8000-000000000004';

function input(overrides: Partial<ReconcileProjectRecordsInput>): ReconcileProjectRecordsInput {
  return {
    stored: [],
    liveSessionProjectIds: new Set(),
    liveWindowProjectIds: new Set(),
    pathExists: () => true,
    ...overrides,
  };
}

describe('reconcileProjectRecords', () => {
  it('empty input is an empty answer, never an error', () => {
    assert.deepEqual(reconcileProjectRecords(input({})), []);
  });

  it('a live session marks the record LIVE', () => {
    const [row] = reconcileProjectRecords(input({
      stored: [{ id: P1, workspacePath: '/gone' }],
      liveSessionProjectIds: new Set([P1]),
      pathExists: () => false,
    }));
    assert.equal(row?.status, 'LIVE');
    assert.equal(row?.reason, 'live-session');
  });

  it('a live window marks the record LIVE', () => {
    const [row] = reconcileProjectRecords(input({
      stored: [{ id: P1, workspacePath: '/exists' }],
      liveWindowProjectIds: new Set([P1]),
    }));
    assert.equal(row?.status, 'LIVE');
    assert.equal(row?.reason, 'live-window');
  });

  it('a dead record whose folder is gone is STALE', () => {
    const [row] = reconcileProjectRecords(input({
      stored: [{ id: P1, workspacePath: '/gone' }],
      pathExists: () => false,
    }));
    assert.equal(row?.status, 'STALE');
    assert.equal(row?.reason, 'workspace-path-missing');
  });

  it('a dead record whose folder still exists is DEAD', () => {
    const [row] = reconcileProjectRecords(input({
      stored: [{ id: P1, workspacePath: '/still-here', capsuleId: 'c1' }],
    }));
    assert.equal(row?.status, 'DEAD');
    assert.equal(row?.reason, 'closed-resumable');
  });

  it('precedence: LIVE beats STALE — a live record with a gone folder is LIVE and the path is never probed', () => {
    let probed = false;
    const [row] = reconcileProjectRecords(input({
      stored: [{ id: P1, workspacePath: '/gone' }],
      liveSessionProjectIds: new Set([P1]),
      pathExists: () => { probed = true; return false; },
    }));
    assert.equal(row?.status, 'LIVE');
    assert.equal(probed, false);
  });

  it('precedence: STALE beats DEAD among dead records', () => {
    const rows = reconcileProjectRecords(input({
      stored: [
        { id: P1, workspacePath: '/gone' },
        { id: P2, workspacePath: '/here' },
      ],
      pathExists: (p) => p === '/here',
    }));
    assert.equal(rows[0]?.status, 'STALE');
    assert.equal(rows[1]?.status, 'DEAD');
  });

  it('an absent or blank workspacePath is never STALE — nothing is missing, it is just DEAD', () => {
    let probed = false;
    const rows = reconcileProjectRecords(input({
      stored: [
        { id: P1 },
        { id: P2, workspacePath: '' },
        { id: P3, workspacePath: '   ' },
      ],
      pathExists: () => { probed = true; return false; },
    }));
    assert.deepEqual(rows.map((r) => r.status), ['DEAD', 'DEAD', 'DEAD']);
    assert.equal(probed, false);
  });

  it('classifies each record independently in one pass', () => {
    const rows = reconcileProjectRecords(input({
      stored: [
        { id: P1, workspacePath: '/gone' },
        { id: P2, workspacePath: '/gone-too' },
        { id: P3, workspacePath: '/here' },
        { id: P4 },
      ],
      liveSessionProjectIds: new Set([P1]),
      liveWindowProjectIds: new Set([P2]),
      pathExists: (p) => p === '/here',
    }));
    assert.deepEqual(
      rows.map((r) => [r.id, r.status]),
      [[P1, 'LIVE'], [P2, 'LIVE'], [P3, 'DEAD'], [P4, 'DEAD']],
    );
  });
});
