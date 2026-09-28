/**
 * Which chrome surface may ask Main to open a project.
 *
 * A terminal window is where a move starts: step one opens (or focuses) the project's
 * window, and that request leaves the renderer as `antifan:project:open`. The shared
 * manager window is a `terminalPopout`, so refusing that surface there made the button
 * answer `CHROME_SURFACE_MISMATCH` before Main ever ran — the observable defect was a
 * header chip reading "Error invoking remote method 'antifan:project:open'" and a move
 * that could never reach its handover.
 *
 * The gate itself still has to hold: a page's own webContents is not a chrome view, and a
 * page must not be able to drive window creation. Both directions are pinned below, and
 * they go through the router's own authorization path rather than a private copy of it.
 */
import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import type { WebContents } from 'electron';

import { installElectronStub } from '../support/electron-stub';

// The stub must be in the require cache before src/main/index is loaded: the module
// registers its privileged schemes at import time, which no plain node run can serve.
installElectronStub();

import {
  ChromeSurfaceMismatchError,
  dispatchChromeRoute,
  setChromeSenderResolver,
  type RoutedSurface,
} from '../../src/main/browser/ipc-router';
import { PROJECT_WINDOW_ROUTES } from '../../src/main/index';
import { PROJECT_WINDOW_CHANNELS } from '../../src/shared/contracts';

const SENDER = { id: 7_424_242 } as unknown as WebContents;

/** A project id no window record can describe, so the route body refuses instead of opening. */
const ABSENT_PROJECT = { projectId: 'project-absent-surface-authorization' };

/**
 * Dispatch the open request as `surface`. Anything the route body raises for its own
 * reasons (an unknown project, no window to parent to) is not a surface verdict, so only
 * the gate's own refusal is reported.
 */
function openRefusalFor(surface: RoutedSurface): ChromeSurfaceMismatchError | undefined {
  setChromeSenderResolver(() => ({ host: {} as never, surface }));
  try {
    dispatchChromeRoute(PROJECT_WINDOW_ROUTES, PROJECT_WINDOW_CHANNELS.PROJECT_OPEN, SENDER, [ABSENT_PROJECT]);
    return undefined;
  } catch (err) {
    return err instanceof ChromeSurfaceMismatchError ? err : undefined;
  } finally {
    setChromeSenderResolver(undefined);
  }
}

describe('project open surface authorization', () => {
  it('lets a terminal window ask for the project it is about to hand a session to', () => {
    assert.equal(
      openRefusalFor('terminalPopout'),
      undefined,
      'a terminal window must reach the open route: moving a terminal starts by opening that project',
    );
  });

  it('keeps both chrome views of a project window allowed', () => {
    assert.equal(openRefusalFor('toolbar'), undefined);
    assert.equal(openRefusalFor('sidebar'), undefined);
  });

  it('still refuses a page, which is not a chrome surface at all', () => {
    const refusal = openRefusalFor('tab');
    assert.ok(refusal, 'a tab page must not be able to open project windows');
    assert.equal(refusal.code, 'CHROME_SURFACE_MISMATCH');
    assert.equal(refusal.name, 'ChromeSurfaceMismatchError');
  });
});
