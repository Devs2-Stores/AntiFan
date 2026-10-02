/**
 * Theme checklist store tests (real fs, no Electron).
 *
 * The store backs two writers that can interleave — the toolbar's whole-array
 * CAS save and agent per-item ops — so every case here defends a real
 * durability boundary on an actual temporary tree: seeded defaults, CAS
 * conflict/no-lost-update semantics, the validation caps an untrusted caller
 * cannot exceed, provisional-scope gating, corrupt-file leniency, and tmp
 * debris sweeping.
 *
 * Determinism note: seeded records use fixed past `updatedAt` values, which
 * are always `!== Date.now()` — CAS conflicts and "no write happened" proofs
 * never depend on millisecond resolution.
 */
import { describe, it, after } from 'node:test';
import * as assert from 'node:assert';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  MAX_CHECKLIST_FIELD_CHARS,
  MAX_CHECKLIST_ITEMS_PER_SCOPE,
  THEME_CHECKLIST_DIRNAME,
  THEME_CHECKLIST_FILENAME,
  checklistFilePath,
  defaultChecklistItems,
  getScope,
  isProvisionalChecklistScope,
  mutateScope,
  readChecklistFile,
  setScopeCas,
  sweepTmpFiles,
  validateChecklistItem,
  validateChecklistItems,
  writeChecklistFileAtomic,
  type ChecklistFileData,
} from '../../src/main/qa/theme-checklist-store';
import {
  DEFAULT_THEME_CHECKLIST,
  UNKNOWN_WORKSPACE_TAG,
  type ThemeChecklistItem,
} from '../../src/shared/theme-checklist';
import { CapabilityError } from '../../src/shared/control-plane-contracts';

const SCOPE = 'https://shop-a.local@shop-a-a1b2c3';
/** Fixed past timestamps: never equal to a real `Date.now()` write stamp. */
const T0 = 1111;
const T_STALE = 999;

const tempRoots: string[] = [];

/** Fresh root per test — sweepTmpFiles sweeps each directory only once per process. */
function makeRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'af-theme-checklist-'));
  tempRoots.push(root);
  return root;
}

after(() => {
  for (const root of tempRoots) fs.rmSync(root, { recursive: true, force: true });
});

function minimalItem(id: string, page = 'pages'): ThemeChecklistItem {
  return { id, code: id.toUpperCase(), name: `item ${id}`, desc: 'd', qaPoint: 'q', page, done: false };
}

/** Persist one scope record with a pinned timestamp. */
function seedScope(root: string, scope: string, items: ThemeChecklistItem[], updatedAt: number): void {
  const data: ChecklistFileData = { version: 1, scopes: { [scope]: { items, updatedAt } } };
  writeChecklistFileAtomic(root, data);
}

function isInvalidArgument(err: unknown): boolean {
  return err instanceof CapabilityError && err.code === 'INVALID_ARGUMENT';
}

describe('scope round-trip', () => {
  it('seeds the 44-item default checklist on an empty root, then persists a mark', () => {
    const root = makeRoot();
    const file = checklistFilePath(root);
    assert.strictEqual(file, path.join(root, THEME_CHECKLIST_DIRNAME, THEME_CHECKLIST_FILENAME));

    const snap = getScope(root, SCOPE);
    assert.strictEqual(snap.existed, false);
    assert.strictEqual(snap.migrated, false);
    assert.strictEqual(snap.updatedAt, 0);
    assert.strictEqual(snap.items.length, 44);
    assert.strictEqual(snap.items.length, DEFAULT_THEME_CHECKLIST.length);
    assert.deepStrictEqual(snap.items, defaultChecklistItems());
    // Reading a scope must not persist anything.
    assert.strictEqual(fs.existsSync(file), false);

    // Seeded items are copies: scribbling on the snapshot cannot leak into the
    // next read or into the shared DEFAULT_THEME_CHECKLIST.
    const seeded = snap.items[0];
    assert.ok(seeded);
    const seededName = seeded.name;
    seeded.done = true;
    seeded.name = 'MUTATED';
    const reread = getScope(root, SCOPE);
    const rereadFirst = reread.items[0];
    assert.ok(rereadFirst);
    assert.strictEqual(rereadFirst.done, false);
    assert.strictEqual(rereadFirst.name, seededName);

    const marked = mutateScope(root, SCOPE, { op: 'mark', itemId: 'hom-01', done: true, note: 'checked' });
    assert.ok(marked.item);
    assert.strictEqual(marked.item.id, 'hom-01');
    assert.strictEqual(marked.item.done, true);
    assert.strictEqual(marked.item.note, 'checked');
    assert.ok(marked.updatedAt > 0);
    assert.strictEqual(fs.existsSync(file), true);

    const persisted = readChecklistFile(root);
    assert.strictEqual(persisted.existed, true);
    assert.strictEqual(persisted.data.version, 1);
    const rec = persisted.data.scopes[SCOPE];
    assert.ok(rec);
    assert.strictEqual(rec.updatedAt, marked.updatedAt);

    const afterMark = getScope(root, SCOPE);
    assert.strictEqual(afterMark.existed, true);
    const hom01 = afterMark.items.find((entry) => entry.id === 'hom-01');
    assert.ok(hom01);
    assert.strictEqual(hom01.done, true);
    assert.strictEqual(hom01.note, 'checked');
    // Untouched rows still reflect the default checklist.
    const hom02 = afterMark.items.find((entry) => entry.id === 'hom-02');
    assert.ok(hom02);
    assert.strictEqual(hom02.done, false);
  });
});

describe('compare-and-set saves', () => {
  it('conflicts on a stale baseUpdatedAt, returns fresh items, and leaves the file untouched', () => {
    const root = makeRoot();
    const seededItems = defaultChecklistItems();
    const hom01 = seededItems.find((entry) => entry.id === 'hom-01');
    assert.ok(hom01);
    hom01.done = true;
    seedScope(root, SCOPE, seededItems, T0);

    const before = fs.readFileSync(checklistFilePath(root), 'utf8');
    const stale = setScopeCas(root, SCOPE, defaultChecklistItems(), T_STALE);
    assert.strictEqual(stale.conflict, true);
    assert.strictEqual(stale.updatedAt, T0);
    // Conflict payload is the live record, not the caller's stale array.
    const liveHom01 = stale.items.find((entry) => entry.id === 'hom-01');
    assert.ok(liveHom01);
    assert.strictEqual(liveHom01.done, true);
    assert.strictEqual(fs.readFileSync(checklistFilePath(root), 'utf8'), before);
  });

  it('lands on the correct base, marks the scope migrated, then conflicts a replayed base', () => {
    const root = makeRoot();
    seedScope(root, SCOPE, defaultChecklistItems(), T0);

    const payload = defaultChecklistItems();
    const target = payload.find((entry) => entry.id === 'qag-01');
    assert.ok(target);
    target.done = true;

    const saved = setScopeCas(root, SCOPE, payload, T0);
    assert.strictEqual(saved.conflict, false);
    assert.ok(saved.updatedAt > T0);

    const snap = getScope(root, SCOPE);
    assert.strictEqual(snap.existed, true);
    assert.strictEqual(snap.migrated, true);
    const persisted = snap.items.find((entry) => entry.id === 'qag-01');
    assert.ok(persisted);
    assert.strictEqual(persisted.done, true);

    // The consumed base is stale on the very next save.
    const replay = setScopeCas(root, SCOPE, payload, T0);
    assert.strictEqual(replay.conflict, true);
    assert.strictEqual(replay.updatedAt, saved.updatedAt);

    // An absent base on an EXISTING record conflicts (fail-closed): skipping the
    // LOAD that priced the write would clobber any interleaved agent mutation.
    const unbased = setScopeCas(root, SCOPE, defaultChecklistItems());
    assert.strictEqual(unbased.conflict, true);
    assert.strictEqual(unbased.updatedAt, saved.updatedAt);
    assert.strictEqual(unbased.items.find((entry) => entry.id === 'qag-01')?.done, true);
  });

  it('conflicts a NaN base on an existing record — non-finite never means "skip the CAS"', () => {
    const root = makeRoot();
    const seeded = defaultChecklistItems();
    seeded.find((entry) => entry.id === 'hom-01')!.done = true;
    seedScope(root, SCOPE, seeded, T0);

    const nan = setScopeCas(root, SCOPE, defaultChecklistItems(), Number.NaN);
    assert.strictEqual(nan.conflict, true);
    assert.strictEqual(nan.updatedAt, T0);
    assert.strictEqual(nan.items.find((entry) => entry.id === 'hom-01')?.done, true);
    // Nothing was written: the file still carries the seeded record verbatim.
    const snap = getScope(root, SCOPE);
    assert.strictEqual(snap.updatedAt, T0);
    assert.strictEqual(snap.migrated, false);
  });

  it('lets a baseless save land on a scope that does not exist yet (first write)', () => {
    const root = makeRoot();
    const payload = defaultChecklistItems();
    payload.find((entry) => entry.id === 'hom-01')!.done = true;

    const first = setScopeCas(root, SCOPE, payload);
    assert.strictEqual(first.conflict, false, 'no record means no CAS base is owed');
    assert.ok(first.updatedAt > 0);

    const snap = getScope(root, SCOPE);
    assert.strictEqual(snap.existed, true);
    assert.strictEqual(snap.migrated, true);
    assert.strictEqual(snap.items.find((entry) => entry.id === 'hom-01')?.done, true);
  });
});

describe('interleaved same-scope mutation (F6)', () => {
  it('rejects a stale re-write after an interleaved per-item op, then re-bases without losing either update', () => {
    const root = makeRoot();
    seedScope(root, SCOPE, defaultChecklistItems(), T0);

    // Toolbar loads the scope at T0.
    const toolbarView = getScope(root, SCOPE);
    assert.strictEqual(toolbarView.updatedAt, T0);

    // An agent per-item op lands while the toolbar is holding the stale view.
    const interleaved = mutateScope(root, SCOPE, { op: 'mark', itemId: 'hom-01', done: true });
    assert.ok(interleaved.updatedAt > T0);

    // The toolbar's stale whole-array save conflicts; the agent's mark survives.
    const toolbarDraft = toolbarView.items.map((entry) =>
      entry.id === 'hom-02' ? { ...entry, done: true } : entry,
    );
    const staleSave = setScopeCas(root, SCOPE, toolbarDraft, toolbarView.updatedAt);
    assert.strictEqual(staleSave.conflict, true);
    const conflictHom01 = staleSave.items.find((entry) => entry.id === 'hom-01');
    const conflictHom02 = staleSave.items.find((entry) => entry.id === 'hom-02');
    assert.ok(conflictHom01 && conflictHom02);
    assert.strictEqual(conflictHom01.done, true);
    // The stale payload's hom-02 tick did NOT get written.
    assert.strictEqual(conflictHom02.done, false);

    // Re-based on the conflict's fresh items, the same save lands both updates.
    const rebased = setScopeCas(
      root,
      SCOPE,
      staleSave.items.map((entry) => (entry.id === 'hom-02' ? { ...entry, done: true } : entry)),
      staleSave.updatedAt,
    );
    assert.strictEqual(rebased.conflict, false);

    const final = getScope(root, SCOPE);
    const finalHom01 = final.items.find((entry) => entry.id === 'hom-01');
    const finalHom02 = final.items.find((entry) => entry.id === 'hom-02');
    assert.ok(finalHom01 && finalHom02);
    assert.strictEqual(finalHom01.done, true);
    assert.strictEqual(finalHom02.done, true);
  });
});

describe('validation caps', () => {
  it('truncates over-long fields, coerces done, and strips unknown keys', () => {
    const item = validateChecklistItem({
      id: 'cap-1',
      code: 'C',
      name: 'a'.repeat(MAX_CHECKLIST_FIELD_CHARS + 500),
      desc: 'd',
      qaPoint: 'q',
      page: 'home',
      done: 1,
      note: 'n'.repeat(MAX_CHECKLIST_FIELD_CHARS + 1),
      evil: 'drop me',
      nested: { x: 1 },
    });
    assert.strictEqual(item.name.length, MAX_CHECKLIST_FIELD_CHARS);
    assert.strictEqual(item.note && item.note.length, MAX_CHECKLIST_FIELD_CHARS);
    assert.strictEqual(item.done, false); // only literal `true` counts
    assert.strictEqual('evil' in item, false);
    assert.strictEqual('nested' in item, false);
    assert.strictEqual(item.page, 'home');
  });

  it('rejects page keys outside the pattern and non-object items', () => {
    assert.throws(() => validateChecklistItem({ id: 'x', page: 'INVALID PAGE!!' }), isInvalidArgument);
    assert.throws(() => validateChecklistItem({ id: 'x', page: 'x'.repeat(33) }), isInvalidArgument);
    assert.throws(() => validateChecklistItem({ id: 'x', page: 'under_score' }), isInvalidArgument);
    assert.throws(() => validateChecklistItem(null), isInvalidArgument);
    assert.throws(() => validateChecklistItem([]), isInvalidArgument);
    assert.throws(() => validateChecklistItem({ id: '  ' }), isInvalidArgument);
    // An empty page falls back to 'home' rather than failing.
    assert.strictEqual(validateChecklistItem({ id: 'x', page: '' }).page, 'home');
  });

  it('rejects arrays over the per-scope cap and duplicate ids', () => {
    const atCap = Array.from({ length: MAX_CHECKLIST_ITEMS_PER_SCOPE }, (_, i) => minimalItem(`bulk-${i}`));
    assert.strictEqual(validateChecklistItems(atCap).length, MAX_CHECKLIST_ITEMS_PER_SCOPE);

    const overCap = [...atCap, minimalItem('bulk-over')];
    assert.throws(() => validateChecklistItems(overCap), isInvalidArgument);
    assert.throws(
      () => validateChecklistItems([minimalItem('dup'), minimalItem('dup')]),
      isInvalidArgument,
    );
    assert.throws(() => validateChecklistItems('not-an-array'), isInvalidArgument);
  });

  it('rejects the 201st added item without writing', () => {
    const root = makeRoot();
    const full = Array.from({ length: MAX_CHECKLIST_ITEMS_PER_SCOPE }, (_, i) => minimalItem(`bulk-${i}`));
    seedScope(root, SCOPE, full, T0);

    assert.throws(
      () => mutateScope(root, SCOPE, { op: 'add', item: minimalItem('bulk-overflow') }),
      isInvalidArgument,
    );
    const rec = readChecklistFile(root).data.scopes[SCOPE];
    assert.ok(rec);
    assert.strictEqual(rec.updatedAt, T0); // unchanged: the rejected add never wrote
    assert.strictEqual(rec.items.length, MAX_CHECKLIST_ITEMS_PER_SCOPE);
  });
});

describe('per-item ops through the file', () => {
  it('markPage flips the whole page group and validates the page key', () => {
    const root = makeRoot();
    const expected = defaultChecklistItems().filter((entry) => entry.page === 'home').length;
    assert.ok(expected > 0);

    const flipped = mutateScope(root, SCOPE, { op: 'markPage', page: 'home', done: true });
    assert.strictEqual(flipped.toggled, expected);
    const snap = getScope(root, SCOPE);
    for (const entry of snap.items) {
      if (entry.page === 'home') assert.strictEqual(entry.done, true);
      else assert.strictEqual(entry.done, false);
    }

    assert.throws(
      () => mutateScope(root, SCOPE, { op: 'markPage', page: 'NOPE!!', done: true }),
      isInvalidArgument,
    );
  });

  it('mark caps notes, add dedupes by id, and remove reports what it dropped', () => {
    const root = makeRoot();

    const noted = mutateScope(root, SCOPE, {
      op: 'mark',
      itemId: 'hom-01',
      done: true,
      note: 'x'.repeat(MAX_CHECKLIST_FIELD_CHARS + 10),
    });
    assert.ok(noted.item && noted.item.note);
    assert.strictEqual(noted.item.note.length, MAX_CHECKLIST_FIELD_CHARS);

    assert.throws(
      () => mutateScope(root, SCOPE, { op: 'mark', itemId: 'missing-id', done: true }),
      isInvalidArgument,
    );

    const added = mutateScope(root, SCOPE, { op: 'add', item: minimalItem('custom-1', 'home') });
    assert.ok(added.item);
    assert.strictEqual(added.items.length, DEFAULT_THEME_CHECKLIST.length + 1);

    // Re-adding an existing id is a no-op: no duplicate, no write.
    const updatedAtBefore = getScope(root, SCOPE).updatedAt;
    const readded = mutateScope(root, SCOPE, { op: 'add', item: minimalItem('custom-1', 'home') });
    assert.strictEqual(readded.items.length, DEFAULT_THEME_CHECKLIST.length + 1);
    assert.strictEqual(getScope(root, SCOPE).updatedAt, updatedAtBefore);

    const removed = mutateScope(root, SCOPE, { op: 'remove', itemId: 'custom-1' });
    assert.strictEqual(removed.removed, true);
    assert.strictEqual(removed.items.length, DEFAULT_THEME_CHECKLIST.length);
    const missing = mutateScope(root, SCOPE, { op: 'remove', itemId: 'custom-1' });
    assert.strictEqual(missing.removed, false);
  });
});

describe('provisional scope gating', () => {
  it('flags unknown-workspace tags and empty roots as provisional without touching the fs', () => {
    const root = makeRoot();
    assert.strictEqual(isProvisionalChecklistScope(`https://x.local@${UNKNOWN_WORKSPACE_TAG}`, root), true);
    assert.strictEqual(isProvisionalChecklistScope('https://x.local@shop-a-a1b2c3', ''), true);
    assert.strictEqual(isProvisionalChecklistScope('https://x.local@shop-a-a1b2c3', '   '), true);
    assert.strictEqual(isProvisionalChecklistScope(undefined, ''), true);
    assert.strictEqual(isProvisionalChecklistScope('https://x.local@shop-a-a1b2c3', root), false);
    // Tag comparison is exact: a differently-cased tag is a normal scope.
    assert.strictEqual(isProvisionalChecklistScope('https://x.local@Unknown-Workspace', root), false);
    // The predicate is pure — no `.antifan` dir materialized.
    assert.strictEqual(fs.existsSync(path.join(root, THEME_CHECKLIST_DIRNAME)), false);
  });

  it('documents the boundary: the store module itself does not gate provisional scopes', () => {
    // The module docstring assigns provisional handling to the owning host's
    // in-memory map; calling the store directly with a provisional scope still
    // persists. This pins the seam so gating never silently moves here.
    const root = makeRoot();
    const provisionalScope = `https://x.local@${UNKNOWN_WORKSPACE_TAG}`;
    mutateScope(root, provisionalScope, { op: 'mark', itemId: 'hom-01', done: true });
    assert.strictEqual(fs.existsSync(checklistFilePath(root)), true);
    const snap = getScope(root, provisionalScope);
    assert.strictEqual(snap.existed, true);
    assert.strictEqual(snap.items.find((entry) => entry.id === 'hom-01')?.done, true);
  });
});

describe('corrupt file tolerance', () => {
  it('returns empty data for unparseable or non-object JSON', () => {
    for (const garbage of ['not json {', '[]', '42']) {
      const root = makeRoot();
      const file = checklistFilePath(root);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, garbage, 'utf8');

      const { existed, data } = readChecklistFile(root);
      // Known gap (finding K, deferred): corrupt is currently indistinguishable
      // from absent — `existed:false` is asserted here because that is the real
      // contract today, NOT because ambiguity is desirable. The companion case
      // below pins the data loss this ambiguity causes.
      assert.strictEqual(existed, false, `expected existed=false for payload ${garbage}`);

      const snap = getScope(root, SCOPE);
      assert.strictEqual(snap.existed, false);
      assert.strictEqual(snap.items.length, DEFAULT_THEME_CHECKLIST.length);
    }
  });

  it('a write after a corrupt read silently discards whatever the corrupt blob held', () => {
    // known-lossy until K lands: the read path cannot distinguish "corrupt" from
    // "absent" (existed:false for both), so a subsequent write rebuilds the file
    // around the written scope only — every sibling scope the corrupt bytes once
    // carried is dropped without a trace. This test pins the CURRENT observable
    // loss so the suite shows it instead of the ambiguity hiding behind
    // existed:false. If K makes corrupt distinguishable, update this contract.
    const root = makeRoot();
    const file = checklistFilePath(root);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(
      file,
      `{"version":1,"scopes":{"${SCOPE}":{"updatedAt":${T0},"items":[{"id":"keep-me"}]},`,
      'utf8',
    );

    const mutated = mutateScope(root, 'https://other.local@other-tag', { op: 'add', item: minimalItem('x-1') });
    assert.ok(mutated.items.some((entry) => entry.id === 'x-1'));

    const after = readChecklistFile(root);
    assert.strictEqual(after.existed, true, 'the write rebuilt a parseable file');
    assert.ok(after.data.scopes['https://other.local@other-tag'], 'the written scope landed');
    // The corrupt blob's scope is gone — data loss surfaced, not hidden.
    assert.equal(after.data.scopes[SCOPE], undefined, 'corrupt sibling scope data is dropped by the rebuild');
  });

  it('drops malformed rows and bad scope keys instead of failing the read', () => {
    const root = makeRoot();
    const file = checklistFilePath(root);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const longScope = 's'.repeat(MAX_CHECKLIST_FIELD_CHARS + 1);
    fs.writeFileSync(
      file,
      JSON.stringify({
        version: 1,
        scopes: {
          [SCOPE]: {
            updatedAt: 'not-a-number',
            items: [
              null,
              'a string is not an item',
              { id: '' },
              { id: 'ok', done: 'yes', page: 'BAD PAGE', note: 42 },
              { id: 'ok' }, // duplicate id dropped
            ],
          },
          '': { items: [], updatedAt: 1 }, // empty scope key dropped
          [longScope]: { items: [], updatedAt: 1 }, // over-long key dropped
        },
      }),
      'utf8',
    );

    const { existed, data } = readChecklistFile(root);
    assert.strictEqual(existed, true);
    assert.deepStrictEqual(Object.keys(data.scopes), [SCOPE]);

    const rec = data.scopes[SCOPE];
    assert.ok(rec);
    assert.strictEqual(rec.updatedAt, 0); // non-numeric updatedAt coerced
    assert.strictEqual(rec.items.length, 1);
    const survivor = rec.items[0];
    assert.ok(survivor);
    assert.strictEqual(survivor.id, 'ok');
    assert.strictEqual(survivor.done, false); // 'yes' is not literal true
    assert.strictEqual(survivor.page, 'pages'); // bad page coerced to 'pages'
    assert.strictEqual(survivor.note, undefined); // non-string note dropped
  });
});

describe('tmp debris sweeping', () => {
  it('deletes qa-checklist tmp-* leftovers and leaves other files alone', () => {
    const root = makeRoot();
    const dir = path.join(root, THEME_CHECKLIST_DIRNAME);
    fs.mkdirSync(dir, { recursive: true });

    const debris = [`${THEME_CHECKLIST_FILENAME}.tmp-1234-1-99`, `${THEME_CHECKLIST_FILENAME}.tmp-abc`];
    const keepers = [THEME_CHECKLIST_FILENAME, `${THEME_CHECKLIST_FILENAME}.bak`, 'unrelated.tmp-1'];
    for (const name of [...debris, ...keepers]) {
      fs.writeFileSync(path.join(dir, name), 'x', 'utf8');
    }
    // Back-date the debris: a sweep that only deletes zero-age leftovers (the
    // same-write remnant) must not spare old crash debris, and a post-fix sweep
    // that checks staleness still deletes these.
    const old = new Date(Date.now() - 24 * 60 * 60 * 1000);
    for (const name of debris) fs.utimesSync(path.join(dir, name), old, old);

    sweepTmpFiles(dir);
    for (const name of debris) {
      assert.strictEqual(fs.existsSync(path.join(dir, name)), false, `debris ${name} survived`);
    }
    for (const name of keepers) {
      assert.strictEqual(fs.existsSync(path.join(dir, name)), true, `keeper ${name} was deleted`);
    }

    // Idempotent and safe on a missing directory.
    sweepTmpFiles(dir);
    sweepTmpFiles(path.join(root, 'does-not-exist'));
  });

  it('a fresh read sweeps debris in the checklist directory', () => {
    const root = makeRoot();
    const dir = path.join(root, THEME_CHECKLIST_DIRNAME);
    fs.mkdirSync(dir, { recursive: true });
    const tmp = path.join(dir, `${THEME_CHECKLIST_FILENAME}.tmp-9-9-9`);
    fs.writeFileSync(tmp, 'orphan', 'utf8');
    // A day-old leftover, not a zero-age remnant of a concurrent write — the
    // sweep contract is "crash debris is deleted", never "fresh tmp is deleted".
    const stale = new Date(Date.now() - 24 * 60 * 60 * 1000);
    fs.utimesSync(tmp, stale, stale);

    const { existed } = readChecklistFile(root);
    assert.strictEqual(existed, false);
    assert.strictEqual(fs.existsSync(tmp), false);
  });
});

describe('default checklist copies', () => {
  it('returns fresh item objects that never alias DEFAULT_THEME_CHECKLIST', () => {
    const items = defaultChecklistItems();
    assert.strictEqual(items.length, 44);
    assert.notStrictEqual(items, DEFAULT_THEME_CHECKLIST);

    const first = items[0];
    const defaultFirst = DEFAULT_THEME_CHECKLIST[0];
    assert.ok(first && defaultFirst);
    assert.notStrictEqual(first, defaultFirst);
    const originalName = defaultFirst.name;

    first.done = true;
    first.name = 'MUTATED';
    first.note = 'leak check';
    items.push(minimalItem('extra'));

    assert.strictEqual(DEFAULT_THEME_CHECKLIST.length, 44);
    assert.strictEqual(defaultFirst.done, false);
    assert.strictEqual(defaultFirst.name, originalName);
    assert.strictEqual(defaultFirst.note, undefined);

    const second = defaultChecklistItems();
    const secondFirst = second[0];
    assert.ok(secondFirst);
    assert.strictEqual(secondFirst.done, false);
    assert.strictEqual(second.length, 44);
  });
});
