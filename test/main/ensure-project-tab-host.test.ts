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
  const calls: string[] = [];
  const journal: Array<{ event: string; fields: Record<string, unknown> }> = [];
  const ensure = createEnsureProjectTabHost({
    isKnownProjectId: () => options.known ?? true,
    hasProjectHost: () => options.hasHost ?? false,
    openProjectWindow: async (projectId) => {
      calls.push(projectId);
      return options.created ?? true;
    },
    journal: (event, fields) => journal.push({ event, fields }),
  });
  return { ensure, calls, journal };
}

describe('ensureProjectTabHost', () => {
  it('opens the window of a known project that has no host and journals it', async () => {
    const h = harness();
    await h.ensure(PROJECT);
    assert.deepEqual(h.calls, [PROJECT]);
    assert.deepEqual(h.journal, [
      { event: 'project-window.reopened-off-screen', fields: { projectId: PROJECT, reason: 'agent-tab-create' } },
    ]);
  });

  it('is a no-op when the project already has a host', async () => {
    const h = harness({ hasHost: true });
    await h.ensure(PROJECT);
    assert.deepEqual(h.calls, []);
    assert.deepEqual(h.journal, []);
  });

  it('does not journal a reopen when the window already existed', async () => {
    const h = harness({ created: false });
    await h.ensure(PROJECT);
    assert.deepEqual(h.calls, [PROJECT]);
    assert.deepEqual(h.journal, []);
  });

  it('rejects an unknown project with TARGET_REQUIRED and opens nothing', async () => {
    const h = harness({ known: false });
    await assert.rejects(
      () => h.ensure(PROJECT),
      (err: unknown) => err instanceof CapabilityError
        && err.code === 'TARGET_REQUIRED'
        && err.details?.projectId === PROJECT,
    );
    assert.deepEqual(h.calls, []);
  });
});
