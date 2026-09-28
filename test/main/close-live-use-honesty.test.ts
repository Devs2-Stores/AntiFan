import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';

import { installElectronStub } from '../support/electron-stub';

// The stub must be in the require cache before src/main/index is loaded: an import that throws
// registers no case, and a file with no registered case still reports as one passing test.
installElectronStub();

import { projectWindowAuthority } from '../../src/main/index';
import {
  collectCloseLiveUse,
  CLOSE_LIVE_USE_CONTROLS,
  type CloseAdmissionTable,
  type CloseLiveUsePort,
} from '../../src/main/browser/close-live-use';
import type { LiveUseReport, LiveUseRequest } from '../../src/main/browser/project-close-coordinator';

const SHELL_A: LiveUseRequest = {
  scope: 'shell',
  ownerKey: 'project:test',
  pageIds: ['tab-1'],
  auxiliaryKeys: [],
};

const APPLICATION: LiveUseRequest = {
  scope: 'application',
  ownerKey: null,
  pageIds: ['tab-1'],
  auxiliaryKeys: [],
};

function admissionTable(): CloseAdmissionTable {
  return {
    snapshot: () => ({ inFlightOperations: 0, reservedTabIds: [], applicationReserved: false }),
    inFlightOperationsOnPage: () => 0,
    inFlightOperationsOnOwner: () => 0,
  };
}

function reasons(report: LiveUseReport) {
  return report.reasons ?? [];
}

describe('close live-use port honesty — uninitialized subsystems report unverified, never idle', () => {
  it('shipping closeLiveUsePort refuses idle when subsystems are uninitialized', () => {
    const livePort = projectWindowAuthority.closeLiveUsePort();

    // 1. operationCounters throws when browserPort is undefined
    assert.throws(
      () => livePort.operationCounters(),
      (err: unknown) => err instanceof Error && /browser control port is not initialized/i.test(err.message),
      'operationCounters must throw when browserPort is undefined'
    );

    // 2. runs and attachments throw when controlPlane is null
    assert.throws(
      () => livePort.runs(),
      (err: unknown) => err instanceof Error && /control plane runtime is not initialized/i.test(err.message),
      'runs must throw when controlPlane is null'
    );
    assert.throws(
      () => livePort.attachments(),
      (err: unknown) => err instanceof Error && /control plane runtime is not initialized/i.test(err.message),
      'attachments must throw when controlPlane is null'
    );

    // 3. terminalState reports available: false when daemon connection has not settled
    const terminalState = livePort.terminalState();
    assert.equal(terminalState.available, false);
    assert.ok('detail' in terminalState);

    // 4. collectCloseLiveUse over the uninitialized shipping port yields unknown, never idle
    const shellReport = collectCloseLiveUse(SHELL_A, livePort);
    assert.equal(shellReport.state, 'unknown', 'shell live-use snapshot must be unknown when subsystems are uninitialized');
    assert.ok(reasons(shellReport).length > 0);
    assert.ok(reasons(shellReport).some((r) => r.category === 'evidence-unavailable'));

    const appReport = collectCloseLiveUse(APPLICATION, livePort);
    assert.equal(appReport.state, 'unknown', 'application live-use snapshot must be unknown when subsystems are uninitialized');
    assert.ok(reasons(appReport).length > 0);
    assert.ok(reasons(appReport).some((r) => r.category === 'evidence-unavailable'));
  });

  it('operationCounters failure makes page/shell scope report unknown, never idle', () => {
    const portWithMissingBrowser: CloseLiveUsePort = {
      admission: () => admissionTable(),
      operationCounters: () => {
        throw new Error('the browser control port is not initialized');
      },
      ledgerInFlight: () => 0,
      runs: () => [],
      attachments: () => [],
      affinities: () => [],
      terminalState: () => ({ available: true, sessions: [] }),
    };

    const report = collectCloseLiveUse(SHELL_A, portWithMissingBrowser);
    assert.equal(report.state, 'unknown', 'missing browserPort must refuse shell close as unknown');
    assert.ok(reasons(report).some((r) => /operation counters could not be read/i.test(r.detail)));
    assert.ok(reasons(report).some((r) => r.control?.id === CLOSE_LIVE_USE_CONTROLS.runs.id));
  });

  it('controlPlane failure in runs or attachments makes application scope report unknown, never idle', () => {
    const portWithMissingControlPlane: CloseLiveUsePort = {
      admission: () => admissionTable(),
      operationCounters: () => ({}),
      ledgerInFlight: () => null,
      runs: () => {
        throw new Error('the control plane runtime is not initialized');
      },
      attachments: () => {
        throw new Error('the control plane runtime is not initialized');
      },
      affinities: () => [],
      terminalState: () => ({ available: true, sessions: [] }),
    };

    const appReport = collectCloseLiveUse(APPLICATION, portWithMissingControlPlane);
    assert.equal(appReport.state, 'unknown', 'missing controlPlane must refuse application quit as unknown');
    assert.ok(reasons(appReport).some((r) => /Runs could not be read/i.test(r.detail)));
    assert.ok(reasons(appReport).some((r) => /Active attachments could not be read/i.test(r.detail)));

    const shellReport = collectCloseLiveUse(SHELL_A, portWithMissingControlPlane);
    assert.equal(shellReport.state, 'unknown', 'missing controlPlane must refuse shell close as unknown');
  });

  it('terminal daemon disconnection makes live-use report unknown, never idle', () => {
    const portWithDisconnectedDaemon: CloseLiveUsePort = {
      admission: () => admissionTable(),
      operationCounters: () => ({}),
      ledgerInFlight: () => 0,
      runs: () => [],
      attachments: () => [],
      affinities: () => [],
      terminalState: () => ({ available: false, detail: 'the terminal host daemon is not connected' }),
    };

    const report = collectCloseLiveUse(APPLICATION, portWithDisconnectedDaemon);
    assert.equal(report.state, 'unknown', 'disconnected terminal daemon must refuse quit as unknown');
    assert.ok(reasons(report).some((r) => /terminal host daemon is not connected/i.test(r.detail)));
    assert.ok(reasons(report).some((r) => r.control?.id === CLOSE_LIVE_USE_CONTROLS.terminalPanel.id));
  });

  it('reports idle only when every subsystem is verified and available with nothing in flight', () => {
    const fullyHealthyPort: CloseLiveUsePort = {
      admission: () => admissionTable(),
      operationCounters: () => ({ pools: { getActiveTabCount: () => 0 }, waits: { getActiveTabCount: () => 0 } }),
      ledgerInFlight: () => 0,
      runs: () => [],
      attachments: () => [],
      affinities: () => [],
      terminalState: () => ({ available: true, sessions: [] }),
    };

    const shellReport = collectCloseLiveUse(SHELL_A, fullyHealthyPort);
    assert.equal(shellReport.state, 'idle');
    assert.deepEqual(shellReport.reasons, []);

    const appReport = collectCloseLiveUse(APPLICATION, fullyHealthyPort);
    assert.equal(appReport.state, 'idle');
    assert.deepEqual(appReport.reasons, []);
  });
});
