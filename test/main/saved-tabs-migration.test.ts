/**
 * The one-time move of saved-tabs.json from the hub era to one record per project window.
 * The transform is pure, so cases build documents in memory; only the backup helper touches
 * a throwaway directory.
 */
import { describe, it, after } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { SavedTabsDocument, SavedTabsOwnerRecord } from '../../src/main/browser/native-tab-host';
import {
  PROJECT_WINDOWS_SAVED_TABS_VERSION,
  backupSavedTabsBeforeMigration,
  migrateSavedTabsToProjectWindows,
} from '../../src/main/browser/saved-tabs-migration';

const BOOT = 'project-00000000-0000-4000-8000-000000000001';
const A = 'project-aaaa';
const B = 'project-bbbb';
const C = 'project-cccc';
const known = new Set([A, B, C]);

function tab(id: string, projectId?: string): Record<string, unknown> {
  return { id, url: `https://example.test/${id}`, title: id, ...(projectId === undefined ? {} : { projectId }) };
}

function doc(owners: Record<string, Record<string, unknown>>, extra: Record<string, unknown> = {}): SavedTabsDocument {
  return { version: 2, owners, bookmarks: [{ id: 'bm' }], updatedAt: 100, ...extra } as unknown as SavedTabsDocument;
}

function owner(d: SavedTabsDocument, key: string): SavedTabsOwnerRecord {
  const record = d.owners[key];
  assert.ok(record, `missing owner record ${key}`);
  return record;
}

function allTabIds(d: SavedTabsDocument): string[] {
  return Object.values(d.owners).flatMap((r) => r.tabs.map((t) => String(t.id)));
}

function tabIdsOf(d: SavedTabsDocument, key: string): string[] {
  return (d.owners[key]?.tabs ?? []).map((t) => String(t.id));
}

const base = { knownProjectIds: known, unassignedHostsTabs: true } as const;

describe('migrateSavedTabsToProjectWindows: placement', () => {
  it('moves hub tabs into the record of the project each row is stamped with', () => {
    const input = doc({
      web: { tabs: [tab('w1', A), tab('w2', B), tab('w3', A)], updatedAt: 5, activeProjectId: A },
    });
    const result = migrateSavedTabsToProjectWindows(input, base);
    assert.equal(result.migrated, true);
    assert.deepEqual(tabIdsOf(result.doc, `project:${A}`), ['w1', 'w3']);
    assert.deepEqual(tabIdsOf(result.doc, `project:${B}`), ['w2']);
    assert.equal(result.doc.owners.web, undefined);
    assert.deepEqual(result.unplacedTabIds, []);
    assert.deepEqual(
      result.movedTabs.map((m) => [m.tabId, m.from, m.to]),
      [['w1', 'web', `project:${A}`], ['w2', 'web', `project:${B}`], ['w3', 'web', `project:${A}`]],
    );
    assert.equal(result.doc.version, PROJECT_WINDOWS_SAVED_TABS_VERSION);
  });

  it('routes boot-project rows by their own stamp, else to the presented project', () => {
    const input = doc({
      web: { tabs: [], updatedAt: 1, activeProjectId: C },
      [`project:${BOOT}`]: { tabs: [tab('b1', B), tab('b2', BOOT), tab('b3')], updatedAt: 2, detached: true },
    });
    const result = migrateSavedTabsToProjectWindows(input, base);
    assert.deepEqual(tabIdsOf(result.doc, `project:${B}`), ['b1']);
    assert.deepEqual(tabIdsOf(result.doc, `project:${C}`), ['b2', 'b3']);
    assert.equal(result.doc.owners[`project:${BOOT}`], undefined);
    assert.equal(owner(result.doc, `project:${C}`).tabs.every((t) => t.projectId === C), true);
  });

  it('sends a row stamped with an unknown or boot project to the presented project, restamps it and drops its capsule', () => {
    const withCapsule = (id: string, projectId: string): Record<string, unknown> => ({ ...tab(id, projectId), capsuleId: `capsule-of-${projectId}` });
    const input = doc({ web: { tabs: [withCapsule('x1', 'project-gone'), withCapsule('x2', BOOT)], updatedAt: 1, activeProjectId: A } });
    const result = migrateSavedTabsToProjectWindows(input, base);
    assert.deepEqual(tabIdsOf(result.doc, `project:${A}`), ['x1', 'x2']);
    assert.deepEqual(owner(result.doc, `project:${A}`).tabs.map((t) => t.projectId), [A, A]);
    assert.equal(owner(result.doc, `project:${A}`).tabs.some((t) => 'capsuleId' in t), false);
  });

  it('keeps the capsule of a row that is stamped with its own project', () => {
    const input = doc({ web: { tabs: [{ ...tab('k1', B), capsuleId: 'capsule-b' }], updatedAt: 1, activeProjectId: A } });
    const result = migrateSavedTabsToProjectWindows(input, base);
    assert.equal(owner(result.doc, `project:${B}`).tabs[0]?.capsuleId, 'capsule-b');
  });

  it('sends a row stamped with a registered but closed project to that project unchanged', () => {
    const closed = 'project-closed';
    const input = doc({
      web: { tabs: [{ ...tab('c1', closed), capsuleId: 'capsule-closed' }, tab('g1', 'project-gone')], updatedAt: 1, activeProjectId: A },
    });
    const result = migrateSavedTabsToProjectWindows(input, { ...base, registeredProjectIds: new Set([...known, closed]) });
    assert.deepEqual(tabIdsOf(result.doc, `project:${closed}`), ['c1']);
    assert.deepEqual(owner(result.doc, `project:${closed}`).tabs[0], { ...tab('c1', closed), capsuleId: 'capsule-closed' });
    assert.deepEqual(tabIdsOf(result.doc, `project:${A}`), ['g1']);
    assert.deepEqual(result.openProjectIds, [A], 'a closed project stays closed');
  });

  it('re-homes a stamp unknown to the registry even when other registered projects exist', () => {
    const input = doc({ web: { tabs: [tab('g1', 'project-gone')], updatedAt: 1, activeProjectId: A } });
    const result = migrateSavedTabsToProjectWindows(input, { ...base, registeredProjectIds: new Set(['project-closed']) });
    assert.deepEqual(tabIdsOf(result.doc, `project:${A}`), ['g1']);
  });

  it('re-homes an unstamped row: presented project first', () => {
    const input = doc({
      web: { tabs: [tab('x1')], updatedAt: 1, activeProjectId: B },
      [`project:${C}`]: { tabs: [tab('c1', C)], updatedAt: 999 },
    });
    const result = migrateSavedTabsToProjectWindows(input, { ...base, openWindowKeys: new Set([`project:${A}`]) });
    assert.deepEqual(tabIdsOf(result.doc, `project:${B}`), ['x1']);
  });

  for (const activeProjectId of [undefined, BOOT, 'project-gone']) {
    it(`re-homes an unstamped row to the first ledger project when the presented project is ${String(activeProjectId)}`, () => {
      const input = doc({
        web: { tabs: [tab('x1')], updatedAt: 1, ...(activeProjectId === undefined ? {} : { activeProjectId }) },
        [`project:${C}`]: { tabs: [tab('c1', C)], updatedAt: 999 },
      });
      const result = migrateSavedTabsToProjectWindows(input, {
        ...base,
        openWindowKeys: new Set(['unassigned', `project:${BOOT}`, `project:${B}`, `project:${A}`]),
      });
      assert.deepEqual(result.unplacedTabIds, []);
      assert.deepEqual(tabIdsOf(result.doc, `project:${B}`), ['x1']);
      assert.deepEqual(result.openProjectIds, [B, A]);
      assert.equal(result.doc.version, PROJECT_WINDOWS_SAVED_TABS_VERSION);
    });
  }

  it('re-homes to the open project whose record is newest when neither the hub nor the ledger names one, and reopens it', () => {
    const input = doc({
      web: { tabs: [tab('x1', BOOT), tab('x2')], updatedAt: 1 },
      [`project:${A}`]: { tabs: [tab('a1', A)], updatedAt: 10 },
      [`project:${C}`]: { tabs: [tab('c1', C)], updatedAt: 30 },
      [`project:${B}`]: { tabs: [tab('b1', B)], updatedAt: 20 },
      'project:project-gone': { tabs: [tab('z1', 'project-gone')], updatedAt: 500 },
    });
    const result = migrateSavedTabsToProjectWindows(input, { ...base, openWindowKeys: new Set(['unassigned']) });
    assert.deepEqual(tabIdsOf(result.doc, `project:${C}`), ['c1', 'x1', 'x2']);
    assert.deepEqual(result.openProjectIds, [C]);
    assert.equal(result.doc.version, PROJECT_WINDOWS_SAVED_TABS_VERSION);
  });

  it('uses an open project with no record yet when no open project has a record', () => {
    const input = doc({ web: { tabs: [tab('x1')], updatedAt: 1 } });
    const result = migrateSavedTabsToProjectWindows(input, { knownProjectIds: new Set([B, A]), unassignedHostsTabs: false });
    assert.deepEqual(tabIdsOf(result.doc, `project:${B}`), ['x1']);
    assert.deepEqual(result.unplacedTabIds, []);
  });

  it('falls back to the unassigned record only when no project is open and that window hosts tabs, dropping stale stamps', () => {
    const input = doc({
      web: { tabs: [tab('x1', 'project-gone'), tab('x2')], updatedAt: 1 },
      unassigned: { tabs: [tab('u1')], updatedAt: 9 },
    });
    const result = migrateSavedTabsToProjectWindows(input, { knownProjectIds: new Set(), unassignedHostsTabs: true });
    assert.deepEqual(tabIdsOf(result.doc, 'unassigned'), ['u1', 'x1', 'x2']);
    assert.equal(owner(result.doc, 'unassigned').tabs.some((t) => t.id === 'x1' && 'projectId' in t), false);
    assert.equal(owner(result.doc, 'unassigned').updatedAt, 9);
  });

  it('reports unplaced tabs only when no project is open, keeps them in their source record and does not mark the document migrated', () => {
    const input = doc({
      web: { tabs: [tab('ok', A), tab('lost1'), tab('lost2', 'project-gone')], updatedAt: 1, activeProjectId: 'project-gone' },
    });
    const result = migrateSavedTabsToProjectWindows(input, {
      knownProjectIds: new Set(),
      registeredProjectIds: new Set([A]),
      unassignedHostsTabs: false,
    });
    assert.deepEqual(result.unplacedTabIds, ['lost1', 'lost2']);
    assert.deepEqual(tabIdsOf(result.doc, 'web'), ['lost1', 'lost2']);
    assert.deepEqual(tabIdsOf(result.doc, `project:${A}`), ['ok']);
    assert.equal(result.doc.version, 2);
    assert.equal(owner(result.doc, 'web').activeProjectId, 'project-gone');
    assert.deepEqual([...allTabIds(result.doc)].sort(), ['lost1', 'lost2', 'ok']);
  });

  it('names id-less unplaced rows by their source position', () => {
    const input = doc({ web: { tabs: [{ url: 'https://example.test/' }], updatedAt: 1 } });
    const result = migrateSavedTabsToProjectWindows(input, { knownProjectIds: new Set(), unassignedHostsTabs: false });
    assert.deepEqual(result.unplacedTabIds, ['web#0']);
  });
});

describe('migrateSavedTabsToProjectWindows: the Terminal Manager record', () => {
  const managerDoc = (): SavedTabsDocument => doc({
    unassigned: {
      tabs: [tab('u1', B), tab('u2'), tab('u3', 'project-gone')],
      updatedAt: 7,
      activeTabId: 'u1',
      terminalTabLayout: 'sidebar',
      terminalSidebarWidth: 232,
      terminalAffinities: [
        { terminalId: 'term-1', primaryTabId: 'u1', managedTabIds: ['u1'] },
        { terminalId: 'term-2', primaryTabId: 'elsewhere', managedTabIds: [] },
      ],
    },
    web: { tabs: [], updatedAt: 1, activeProjectId: A },
  });

  it('moves its rows like hub rows and keeps the record with the window fields it still owns', () => {
    const result = migrateSavedTabsToProjectWindows(managerDoc(), { ...base, unassignedHostsTabs: false });
    assert.deepEqual(tabIdsOf(result.doc, `project:${B}`), ['u1']);
    assert.deepEqual(tabIdsOf(result.doc, `project:${A}`), ['u2', 'u3']);
    assert.deepEqual(result.unplacedTabIds, []);
    const manager = owner(result.doc, 'unassigned');
    assert.deepEqual(manager.tabs, []);
    assert.equal(manager.terminalTabLayout, 'sidebar');
    assert.equal(manager.activeTabId, undefined);
    assert.deepEqual(manager.terminalAffinities?.map((a) => a.terminalId), ['term-2']);
    assert.deepEqual(owner(result.doc, `project:${B}`).terminalAffinities?.map((a) => a.terminalId), ['term-1']);
    assert.equal(owner(result.doc, `project:${B}`).activeTabId, 'u1');
    // The manager's look is its own; it is not handed to a project window.
    assert.equal(owner(result.doc, `project:${B}`).terminalTabLayout, undefined);
    assert.equal(result.movedTabs.every((m) => m.from === 'unassigned'), true);
  });

  it('leaves its rows alone when that window hosts browser tabs', () => {
    const result = migrateSavedTabsToProjectWindows(managerDoc(), { ...base, unassignedHostsTabs: true });
    assert.deepEqual(tabIdsOf(result.doc, 'unassigned'), ['u1', 'u2', 'u3']);
    assert.deepEqual(result.movedTabs, []);
  });
});

describe('migrateSavedTabsToProjectWindows: merging and record fields', () => {
  it('merges into an existing project record without duplicating tab ids and keeps its own pointers', () => {
    const input = doc({
      web: { tabs: [tab('t1', A), tab('t2', A)], updatedAt: 50, activeTabId: 't2' },
      [`project:${A}`]: {
        tabs: [tab('t1', A), tab('t0', A)],
        activeTabId: 't0',
        updatedAt: 10,
        detached: true,
        terminalTabLayout: 'horizontal',
        terminalSidebarWidth: 300,
      },
    });
    const result = migrateSavedTabsToProjectWindows(input, base);
    const record = owner(result.doc, `project:${A}`);
    assert.deepEqual(record.tabs.map((t) => t.id), ['t1', 't0', 't2']);
    assert.equal(record.activeTabId, 't0');
    assert.equal(record.terminalTabLayout, 'horizontal');
    assert.equal(record.terminalSidebarWidth, 300);
    assert.equal(record.updatedAt, 50);
    assert.equal('detached' in record, false);
    assert.deepEqual(result.movedTabs.map((m) => m.tabId), ['t2']);
  });

  it('adopts the hub active tab when the destination has no valid pointer', () => {
    const input = doc({
      web: { tabs: [tab('t1', A), tab('t2', A)], updatedAt: 1, activeTabId: 't2' },
      [`project:${A}`]: { tabs: [tab('t0', A)], activeTabId: 'stale-id', updatedAt: 1, detached: true },
    });
    const result = migrateSavedTabsToProjectWindows(input, base);
    assert.equal(owner(result.doc, `project:${A}`).activeTabId, 't2');
  });

  it('gives a new project record the hub window look and carries affinities with their primary tab', () => {
    const input = doc({
      web: {
        tabs: [tab('t1', A), tab('t2', B)],
        updatedAt: 1,
        activeTabId: 't1',
        activeProjectId: A,
        terminalTabLayout: 'sidebar',
        terminalSidebarWidth: 232,
        terminalAffinities: [
          { terminalId: 'term-1', primaryTabId: 't1', managedTabIds: ['t1'] },
          { terminalId: 'term-2', primaryTabId: 't2', managedTabIds: ['t2'] },
          { terminalId: 'term-3', primaryTabId: 'no-such-tab', managedTabIds: [] },
        ],
      },
    });
    const result = migrateSavedTabsToProjectWindows(input, base);
    const a = owner(result.doc, `project:${A}`);
    const b = owner(result.doc, `project:${B}`);
    assert.equal(a.activeTabId, 't1');
    assert.equal(b.activeTabId, undefined);
    assert.equal(a.terminalTabLayout, 'sidebar');
    assert.equal(b.terminalSidebarWidth, 232);
    assert.deepEqual(a.terminalAffinities?.map((x) => x.terminalId), ['term-1']);
    assert.deepEqual(b.terminalAffinities?.map((x) => x.terminalId), ['term-2']);
  });

  it('hands the hub terminal pop-out to the presented project only when it has none', () => {
    const popout = { terminalWindows: [{ sessionId: 's1' }], isTerminalPopoutOpen: true, popoutSessionId: 's1' };
    const fresh = migrateSavedTabsToProjectWindows(
      doc({ web: { tabs: [tab('t1', A)], updatedAt: 1, activeProjectId: A, ...popout } }),
      base,
    );
    assert.equal(owner(fresh.doc, `project:${A}`).popoutSessionId, 's1');
    const own = migrateSavedTabsToProjectWindows(
      doc({
        web: { tabs: [tab('t1', A)], updatedAt: 1, activeProjectId: A, ...popout },
        [`project:${A}`]: { tabs: [], updatedAt: 1, popoutSessionId: 'mine' },
      }),
      base,
    );
    assert.equal(owner(own.doc, `project:${A}`).popoutSessionId, 'mine');
    assert.equal(owner(own.doc, `project:${A}`).isTerminalPopoutOpen, undefined);
  });

  it('drops detach markers everywhere and keeps unrelated records and top-level preferences', () => {
    const input = doc(
      {
        web: { tabs: [], updatedAt: 1, activeProjectId: A },
        [`project:${B}`]: { tabs: [tab('b1', B)], updatedAt: 1, detached: true, activeTabId: 'b1' },
        unassigned: { tabs: [], updatedAt: 1, terminalTabLayout: 'sidebar' },
        'project:project-orphan': { tabs: [tab('o1', 'project-orphan')], updatedAt: 1, detached: true },
      },
      { sidebarWidth: 280, terminalProjectOrder: ['x'] },
    );
    const result = migrateSavedTabsToProjectWindows(input, base);
    for (const record of Object.values(result.doc.owners)) {
      assert.equal('detached' in record, false);
      assert.equal('activeProjectId' in record, false);
    }
    assert.deepEqual(tabIdsOf(result.doc, 'project:project-orphan'), ['o1']);
    assert.equal(result.doc.owners.web, undefined);
    assert.equal(owner(result.doc, 'unassigned').terminalTabLayout, 'sidebar');
    assert.deepEqual(result.doc.bookmarks, [{ id: 'bm' }]);
    assert.equal(result.doc.sidebarWidth, 280);
    assert.deepEqual(result.doc.terminalProjectOrder, ['x']);
    assert.equal(result.doc.updatedAt, 100);
  });

  it('keeps every row of the input exactly once, whatever the mix', () => {
    const input = doc({
      web: {
        tabs: [tab('w1', A), tab('w2'), tab('w3', 'project-gone'), tab('w4', B), tab('w5', BOOT)],
        updatedAt: 1,
        activeProjectId: C,
      },
      [`project:${BOOT}`]: { tabs: [tab('b1'), tab('b2', A)], updatedAt: 1 },
      [`project:${A}`]: { tabs: [tab('a1', A), tab('w1', A)], updatedAt: 1, detached: true },
      unassigned: { tabs: [tab('u1')], updatedAt: 1 },
    });
    const before = allTabIds(input);
    const result = migrateSavedTabsToProjectWindows(input, base);
    const after = allTabIds(result.doc);
    assert.equal(new Set(after).size, after.length);
    assert.deepEqual([...new Set(before)].sort(), [...after].sort());
  });
});

describe('migrateSavedTabsToProjectWindows: purity and idempotency', () => {
  it('never mutates the input document', () => {
    const input = doc({
      web: { tabs: [tab('t1', 'project-gone'), tab('t2', B)], updatedAt: 1, activeProjectId: A, activeTabId: 't1' },
      [`project:${B}`]: { tabs: [tab('b1', B)], updatedAt: 1, detached: true },
    });
    const snapshot = JSON.stringify(input);
    const result = migrateSavedTabsToProjectWindows(input, base);
    assert.equal(JSON.stringify(input), snapshot);
    assert.notEqual(result.doc, input);
    // Rows in the result are copies: editing one cannot reach the input.
    const copied = owner(result.doc, `project:${A}`).tabs[0];
    assert.ok(copied);
    copied.title = 'edited';
    assert.equal(JSON.stringify(input), snapshot);
  });

  it('returns an already-migrated document untouched', () => {
    const migrated = doc({ [`project:${A}`]: { tabs: [tab('a1', A)], updatedAt: 1 } });
    migrated.version = PROJECT_WINDOWS_SAVED_TABS_VERSION;
    const result = migrateSavedTabsToProjectWindows(migrated, base);
    assert.equal(result.migrated, false);
    assert.equal(result.doc, migrated);
    assert.deepEqual(result.movedTabs, []);
    assert.deepEqual(result.unplacedTabIds, []);
  });

  it('is idempotent: migrating the output again changes nothing', () => {
    const input = doc({
      web: { tabs: [tab('w1', A), tab('w2')], updatedAt: 1, activeProjectId: A, activeTabId: 'w1' },
      [`project:${B}`]: { tabs: [tab('b1', B)], updatedAt: 1, detached: true, activeTabId: 'b1' },
    });
    const first = migrateSavedTabsToProjectWindows(input, base);
    const second = migrateSavedTabsToProjectWindows(first.doc, base);
    assert.equal(second.migrated, false);
    assert.equal(second.doc, first.doc);
    // Even if a stale writer put the old version back, re-running moves nothing.
    const regressed = { ...first.doc, version: 2 } as SavedTabsDocument;
    const third = migrateSavedTabsToProjectWindows(regressed, base);
    assert.deepEqual(third.movedTabs, []);
    assert.deepEqual(third.doc, first.doc);
  });

  it('treats a document with no version as unmigrated', () => {
    const input = { owners: { web: { tabs: [tab('w1', A)], updatedAt: 1 } } } as unknown as SavedTabsDocument;
    const result = migrateSavedTabsToProjectWindows(input, base);
    assert.equal(result.migrated, true);
    assert.deepEqual(tabIdsOf(result.doc, `project:${A}`), ['w1']);
    assert.equal(result.doc.version, PROJECT_WINDOWS_SAVED_TABS_VERSION);
  });
});

describe('migrateSavedTabsToProjectWindows: windows to reopen', () => {
  const input = (): SavedTabsDocument => doc({
    web: { tabs: [tab('w1', A)], updatedAt: 1, activeProjectId: A },
    [`project:${B}`]: { tabs: [tab('b1', B)], updatedAt: 1, detached: true },
    [`project:${C}`]: { tabs: [tab('c1', C)], updatedAt: 1, detached: true },
  });

  it('lists the presented project first, then the projects the ledger says were open', () => {
    const result = migrateSavedTabsToProjectWindows(input(), {
      ...base,
      openWindowKeys: new Set(['unassigned', `project:${C}`, `project:${A}`, `project:${BOOT}`, 'project:project-gone']),
    });
    assert.deepEqual(result.openProjectIds, [A, C]);
  });

  it('does not treat detached markers as open windows', () => {
    const result = migrateSavedTabsToProjectWindows(input(), { ...base, openWindowKeys: new Set(['unassigned']) });
    assert.deepEqual(result.openProjectIds, [A]);
    const noEvidence = migrateSavedTabsToProjectWindows(input(), { ...base, openWindowKeys: null });
    assert.deepEqual(noEvidence.openProjectIds, [A]);
  });

  it('reopens nothing when there is no presented project and no ledger', () => {
    const result = migrateSavedTabsToProjectWindows(doc({ web: { tabs: [], updatedAt: 1 } }), base);
    assert.deepEqual(result.openProjectIds, []);
  });

  it('still answers from the ledger once the document is already migrated', () => {
    const migrated = doc({ [`project:${B}`]: { tabs: [tab('b1', B)], updatedAt: 1 } });
    migrated.version = PROJECT_WINDOWS_SAVED_TABS_VERSION;
    const result = migrateSavedTabsToProjectWindows(migrated, { ...base, openWindowKeys: new Set([`project:${B}`]) });
    assert.equal(result.migrated, false);
    assert.deepEqual(result.openProjectIds, [B]);
  });
});

describe('migrateSavedTabsToProjectWindows: a hub-era document shaped like a real one', () => {
  it('places every row with no unplaced tab', () => {
    const detached = (id: string, n: number): Record<string, unknown> => ({
      tabs: Array.from({ length: n }, (_, i) => tab(`${id}-${i}`, id)),
      activeTabId: `${id}-0`,
      updatedAt: 1,
      detached: true,
      terminalAffinities: [],
      terminalTabLayout: 'sidebar',
      terminalSidebarWidth: 232,
    });
    const input = doc({
      unassigned: { tabs: [], updatedAt: 1, activeTabId: '', terminalAffinities: [] },
      web: {
        tabs: [tab('g', 'project-stray'), tab('s1', A), tab('s2', A), tab('s3', A)],
        activeTabId: 's2',
        activeProjectId: A,
        updatedAt: 1,
        terminalAffinities: [],
      },
      [`project:${B}`]: detached(B, 4),
      [`project:${C}`]: detached(C, 2),
    });
    const result = migrateSavedTabsToProjectWindows(input, {
      knownProjectIds: known,
      unassignedHostsTabs: true,
      openWindowKeys: new Set([`project:${C}`, 'unassigned']),
    });
    assert.deepEqual(result.unplacedTabIds, []);
    assert.equal(result.movedTabs.length, 4);
    assert.deepEqual(result.openProjectIds, [A, C]);
    assert.deepEqual(tabIdsOf(result.doc, `project:${A}`), ['g', 's1', 's2', 's3']);
    assert.equal(owner(result.doc, `project:${A}`).activeTabId, 's2');
    assert.equal(Object.keys(result.doc.owners).sort().join(','), ['unassigned', `project:${A}`, `project:${B}`, `project:${C}`].sort().join(','));
  });
});

describe('backupSavedTabsBeforeMigration', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'antifan-saved-tabs-backup-'));
  after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const now = new Date(2026, 9, 23, 7, 5, 9);

  it('returns null and writes nothing when the file is absent', () => {
    const missing = path.join(dir, 'absent', 'saved-tabs.json');
    assert.equal(backupSavedTabsBeforeMigration(missing, now), null);
    assert.equal(fs.existsSync(path.dirname(missing)), false);
  });

  it('copies the file next to itself and leaves the source in place', () => {
    const file = path.join(dir, 'copy', 'saved-tabs.json');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, '{"version":2}');
    const backup = backupSavedTabsBeforeMigration(file, now);
    assert.equal(backup, `${file}.pre-project-windows-20261023070509.bak`);
    assert.equal(fs.readFileSync(backup as string, 'utf8'), '{"version":2}');
    assert.equal(fs.readFileSync(file, 'utf8'), '{"version":2}');
  });

  it('never overwrites an existing backup: a taken name gets a numeric suffix', () => {
    const file = path.join(dir, 'collide', 'saved-tabs.json');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, 'second');
    const taken = `${file}.pre-project-windows-20261023070509.bak`;
    fs.writeFileSync(taken, 'first');
    const next = backupSavedTabsBeforeMigration(file, now) as string;
    const third = backupSavedTabsBeforeMigration(file, now) as string;
    assert.equal(next, `${file}.pre-project-windows-20261023070509-1.bak`);
    assert.equal(third, `${file}.pre-project-windows-20261023070509-2.bak`);
    assert.equal(fs.readFileSync(taken, 'utf8'), 'first');
    assert.equal(fs.readFileSync(next, 'utf8'), 'second');
  });
});
