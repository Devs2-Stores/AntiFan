/**
 * `tabs.create` after a restart: the project's window may not exist yet, and tab creation is
 * synchronous, so the window is opened first through this seam. Pinned over injected deps.
 */
import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import { installElectronStub } from '../support/electron-stub';

installElectronStub();

import { CapabilityError } from '../../src/shared/control-plane-contracts';
import { createEnsureProjectTabHost } from '../../src/main/index';

const PROJECT = 'project-11111111-1111-4111-8111-111111111111';

function harness(options: { known?: boolean; hasHost?: boolean; created?: boolean } = {}) {
  const calls: Array<{ projectId: string; visible: boolean }> = [];
  const journal: Array<{ event: string; fields: Record<string, unknown> }> = [];
  const ensure = createEnsureProjectTabHost({
    isKnownProjectId: () => options.known ?? true,
    hasProjectHost: () => options.hasHost ?? false,
    openProjectWindow: async (projectId, visible) => {
      calls.push({ projectId, visible });
      return options.created ?? true;
    },
    journal: (event, fields) => journal.push({ event, fields }),
  });
  return { ensure, calls, journal };
}

describe('ensureProjectTabHost', () => {
  it('opens a known project window hidden when the call is not web work, and journals it', async () => {
    const h = harness();
    await h.ensure(PROJECT);
    assert.deepEqual(h.calls, [{ projectId: PROJECT, visible: false }]);
    assert.deepEqual(h.journal, [
      { event: 'project-window.reopened-off-screen', fields: { projectId: PROJECT, reason: 'agent-tab-create' } },
    ]);
  });

  it('shows the window when the call is real web work', async () => {
    const h = harness();
    await h.ensure(PROJECT, { visible: true });
    assert.deepEqual(h.calls, [{ projectId: PROJECT, visible: true }]);
    assert.deepEqual(h.journal, [
      { event: 'project-window.opened-for-agent', fields: { projectId: PROJECT, reason: 'agent-tab-create' } },
    ]);
  });

  it('leaves a window that already exists alone unless the call is web work, which joins it to surface it', async () => {
    const quiet = harness({ hasHost: true });
    await quiet.ensure(PROJECT);
    assert.deepEqual(quiet.calls, []);
    assert.deepEqual(quiet.journal, []);

    const web = harness({ hasHost: true, created: false });
    await web.ensure(PROJECT, { visible: true });
    assert.deepEqual(web.calls, [{ projectId: PROJECT, visible: true }]);
    assert.deepEqual(web.journal, [], 'a join is not a reopen');
  });

  it('does not journal a reopen when the window already existed', async () => {
    const h = harness({ created: false });
    await h.ensure(PROJECT);
    assert.deepEqual(h.calls, [{ projectId: PROJECT, visible: false }]);
    assert.deepEqual(h.journal, []);
  });

  it('rejects an unknown project with TARGET_REQUIRED and opens nothing', async () => {
    const h = harness({ known: false });
    await assert.rejects(
      () => h.ensure(PROJECT, { visible: true }),
      (err: unknown) => err instanceof CapabilityError
        && err.code === 'TARGET_REQUIRED'
        && err.details?.projectId === PROJECT,
    );
    assert.deepEqual(h.calls, []);
  });
});
