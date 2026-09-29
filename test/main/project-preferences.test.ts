import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { ProjectPreferences, PROJECT_PREFERENCES_MAX } from '../../src/main/project/project-preferences';

const P1 = 'project-00000000-0000-4000-8000-000000000001';
const P2 = 'project-00000000-0000-4000-8000-000000000002';

describe('ProjectPreferences', () => {
  let dir: string;
  let file: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'antifan-projprefs-'));
    file = path.join(dir, 'project-preferences.json');
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('persists colour and star, and a new instance reads them back', () => {
    const a = new ProjectPreferences(file);
    assert.deepEqual(a.set(P1, { color: '#AABBCC', starred: true }), { color: '#aabbcc', starred: true });
    const b = new ProjectPreferences(file);
    assert.deepEqual(b.get(P1), { color: '#aabbcc', starred: true });
    assert.deepEqual(b.get(P2), {});
  });

  it('clears a colour with null and a star with false; an empty entry is dropped from disk', () => {
    const a = new ProjectPreferences(file);
    a.set(P1, { color: '#112233', starred: true });
    a.set(P1, { color: null });
    assert.deepEqual(a.get(P1), { starred: true });
    a.set(P1, { starred: false });
    assert.deepEqual(a.get(P1), {});
    assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')).projects, {});
  });

  it('refuses an invalid id, colour or star and changes nothing', () => {
    const a = new ProjectPreferences(file);
    a.set(P1, { starred: true });
    assert.equal(a.set('not-a-project', { starred: true }), undefined);
    assert.equal(a.set(P1, { color: 'red' }), undefined);
    assert.equal(a.set(P1, { color: '#12345' }), undefined);
    assert.equal(a.set(P1, { starred: 'yes' as unknown as boolean }), undefined);
    assert.deepEqual(a.get(P1), { starred: true });
  });

  it('drops corrupt entries on load instead of painting them', () => {
    fs.writeFileSync(file, JSON.stringify({
      version: 1,
      projects: {
        [P1]: { color: 'javascript:alert(1)', starred: 'true' },
        [P2]: { color: '#ABCDEF', starred: true },
        'bogus-key': { color: '#000000' },
      },
    }));
    const a = new ProjectPreferences(file);
    assert.deepEqual(a.get(P1), {});
    assert.deepEqual(a.get(P2), { color: '#abcdef', starred: true });
    assert.deepEqual(Object.keys(a.list()), [P2]);
  });

  it('starts empty on unreadable or non-JSON files', () => {
    fs.writeFileSync(file, '{not json');
    assert.deepEqual(new ProjectPreferences(file).list(), {});
  });

  it('remove forgets a project durably and is idempotent', () => {
    const a = new ProjectPreferences(file);
    a.set(P1, { starred: true });
    a.remove(P1);
    a.remove(P1);
    assert.deepEqual(new ProjectPreferences(file).get(P1), {});
  });

  it('refuses a new project past the cap but still edits an existing one', () => {
    const a = new ProjectPreferences(file);
    const id = (n: number) => `project-00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
    for (let i = 0; i < PROJECT_PREFERENCES_MAX; i++) {
      assert.ok(a.set(id(i), { starred: true }), `entry ${i}`);
    }
    assert.equal(a.set(id(PROJECT_PREFERENCES_MAX), { starred: true }), undefined);
    assert.deepEqual(a.set(id(0), { color: '#010203' }), { starred: true, color: '#010203' });
  });

  it('rolls memory back when the file cannot be written', () => {
    const blocked = path.join(dir, 'a-file');
    fs.writeFileSync(blocked, 'x');
    const a = new ProjectPreferences(path.join(blocked, 'sub', 'p.json'));
    assert.equal(a.set(P1, { starred: true }), undefined);
    assert.deepEqual(a.get(P1), {});
  });

  it('remove reports a failed deletion and rolls memory back so it agrees with disk', () => {
    const a = new ProjectPreferences(file);
    a.set(P1, { color: '#0a0b0c', starred: true });
    fs.rmSync(file, { force: true });
    fs.mkdirSync(file);
    assert.equal(a.remove(P1), false);
    assert.deepEqual(a.get(P1), { color: '#0a0b0c', starred: true });
    fs.rmSync(file, { recursive: true, force: true });
    assert.equal(a.remove(P1), true);
    assert.deepEqual(new ProjectPreferences(file).get(P1), {});
  });
});
