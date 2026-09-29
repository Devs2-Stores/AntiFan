import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { ProjectRegistry } from '../../src/main/project/project-registry';
import { ProjectPreferences } from '../../src/main/project/project-preferences';

describe('ProjectRegistry appearance', () => {
  let dir: string;
  let file: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'antifan-regappear-'));
    file = path.join(dir, 'project-preferences.json');
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('carries colour and star on the ProjectRecord and survives a fresh registry over the same store', () => {
    const first = new ProjectRegistry();
    first.attachAppearanceStore(new ProjectPreferences(file));
    const project = first.createProject('Alpha', dir);
    const updated = first.setProjectAppearance(project.id, { color: '#AA00FF', starred: true });
    assert.equal(updated?.color, '#aa00ff');
    assert.equal(updated?.starred, true);
    assert.equal(first.getProject(project.id).color, '#aa00ff');

    // A new boot re-registers the project from its capsule; the record must read the store back.
    const second = new ProjectRegistry();
    second.attachAppearanceStore(new ProjectPreferences(file));
    const reregistered = second.registerProject({ ...project, color: undefined, starred: undefined });
    assert.equal(reregistered.color, '#aa00ff');
    assert.equal(reregistered.starred, true);
  });

  it('is authoritative: a stale colour on an incoming record is replaced by the store', () => {
    const registry = new ProjectRegistry();
    registry.attachAppearanceStore(new ProjectPreferences(file));
    const project = registry.createProject('Alpha', dir);
    registry.setProjectAppearance(project.id, { color: '#112233' });
    const registered = registry.registerProject({ ...project, color: '#ff0000', starred: true });
    assert.equal(registered.color, '#112233');
    assert.equal(registered.starred, undefined);
  });

  it('refuses an invalid colour and an unknown project, leaving the record unchanged', () => {
    const registry = new ProjectRegistry();
    registry.attachAppearanceStore(new ProjectPreferences(file));
    const project = registry.createProject('Alpha', dir);
    assert.equal(registry.setProjectAppearance(project.id, { color: 'red' }), undefined);
    assert.equal(registry.getProject(project.id).color, undefined);
    assert.equal(registry.setProjectAppearance('project-00000000-0000-4000-8000-0000000000ff', { starred: true }), undefined);
  });

  it('forgetProjectAppearance clears the record and the disk', () => {
    const registry = new ProjectRegistry();
    registry.attachAppearanceStore(new ProjectPreferences(file));
    const project = registry.createProject('Alpha', dir);
    registry.setProjectAppearance(project.id, { color: '#010203', starred: true });
    registry.forgetProjectAppearance(project.id);
    assert.equal(registry.getProject(project.id).color, undefined);
    assert.equal(new ProjectPreferences(file).get(project.id).color, undefined);
  });

  it('attaching a store hydrates projects registered earlier', () => {
    const seeded = new ProjectPreferences(file);
    const registry = new ProjectRegistry();
    const project = registry.createProject('Alpha', dir);
    seeded.set(project.id, { starred: true });
    registry.attachAppearanceStore(seeded);
    assert.equal(registry.getProject(project.id).starred, true);
  });

  it('without a store the registry refuses appearance changes rather than pretending', () => {
    const registry = new ProjectRegistry();
    const project = registry.createProject('Alpha', dir);
    assert.equal(registry.setProjectAppearance(project.id, { starred: true }), undefined);
  });

  it('createProject returns the hydrated record it stored, not the pre-hydration one', () => {
    const registry = new ProjectRegistry();
    registry.attachAppearanceStore({
      get: () => ({ color: '#0a0b0c', starred: true }),
      set: () => undefined,
      remove: () => true,
    });
    const created = registry.createProject('Alpha', dir);
    assert.equal(created.color, '#0a0b0c');
    assert.equal(created.starred, true);
    assert.deepEqual(registry.getProject(created.id), created);
  });

  it('forgetProjectAppearance reports a failed deletion and the record keeps the stored appearance', () => {
    const registry = new ProjectRegistry();
    const store = new ProjectPreferences(file);
    registry.attachAppearanceStore(store);
    const project = registry.createProject('Alpha', dir);
    registry.setProjectAppearance(project.id, { color: '#010203', starred: true });
    fs.rmSync(file, { force: true });
    fs.mkdirSync(file);
    assert.equal(registry.forgetProjectAppearance(project.id), false);
    assert.equal(registry.getProject(project.id).color, '#010203');
    assert.equal(registry.getProject(project.id).starred, true);
  });

  it('forgetProjectAppearance validates the id and rejects a malformed one', () => {
    const registry = new ProjectRegistry();
    registry.attachAppearanceStore(new ProjectPreferences(file));
    assert.throws(() => registry.forgetProjectAppearance('not-a-project'));
  });
});
