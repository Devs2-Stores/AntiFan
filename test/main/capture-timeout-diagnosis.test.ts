import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { BrowserControlPort, BrowserHostPort } from '../../src/main/tools/browser-control-port';
import { BrowserTarget } from '../../src/shared/control-plane-contracts';
import { CaptureError } from '../../src/main/verification/visual-capture';
import type { VerificationCaptureEnvelope } from '../../src/main/verification/visual-capture';

// The diagnosis path is exercised through the port's lifecycle journal-free
// surface: only the census matters here, and nothing in this file writes to the
// main lifecycle journal (the host double has no lifecycle hooks).
const RUNTIME_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'antifan-capture-diagnosis-'));
process.env.ANTIFAN_RUNTIME_DIR = RUNTIME_DIR;

const TARGET: BrowserTarget = {
  tabId: 'tab-b',
  projectId: 'project-1',
  workspaceId: 'workspace-1',
  runtimeId: 'runtime-1',
  browserEpoch: 1,
  documentGeneration: 1,
};

interface HostOptions {
  captureThrows?: Error;
  census?: Record<string, unknown>;
}

function buildHost(opts: HostOptions) {
  const host: Partial<BrowserHostPort> & Record<string, unknown> = {
    hasTab: () => true,
    isTabAllowed: () => true,
    getTabList: () => [{ id: 'tab-b' }],
    getManagedTabIds: () => new Set(['tab-b']),
    getDocumentGeneration: () => 1,
    isCurrentTarget: () => true,
    readRenderSurface: async () => ({ vw: 1440, vh: 900, dpr: 1, scrollX: 0, scrollY: 0, docH: 5000, readyState: 'complete', hidden: false }),
    captureVerificationScreenshot: async (): Promise<VerificationCaptureEnvelope> => {
      throw opts.captureThrows ?? new CaptureError('CAPTURE_TIMEOUT', 'CDP command Page.captureScreenshot timed out after 8000ms');
    },
    setViewportSize: async () => true,
    reapplyTabGeometry: async () => ({ before: { width: 1440, height: 900, scrollX: 0, scrollY: 0 }, after: { width: 1440, height: 900, scrollX: 0, scrollY: 0 }, restored: true, attempts: 1 }),
    closeTab: () => true,
    createTab: () => 'tab-new',
    evalJs: async () => opts.census ?? { playing: 0, buffered: 0, tags: {}, infiniteAnimations: 0, infiniteAnimationsByClass: {}, smil: 0, rafFired: false },
    navigate: async () => true,
  };
  return { host: host as unknown as BrowserHostPort };
}

describe('CAPTURE_TIMEOUT diagnosis frame-production census', () => {
  it('names the starved window compositor and prescribes a presentation change, not a media freeze', async () => {
    const { host } = buildHost({ census: { playing: 1, buffered: 0, tags: { video: 1 }, infiniteAnimations: 0, infiniteAnimationsByClass: {}, smil: 0, rafFired: false } });
    const port = new BrowserControlPort(host);

    await assert.rejects(
      () => port.screenshot(TARGET, 'run-1', 'attempt-1', 'tab-b', 'desktop'),
      (err: unknown) => {
        assert.ok(err instanceof CaptureError, `expected CaptureError, got ${err}`);
        assert.strictEqual(err.code, 'CAPTURE_TIMEOUT');
        assert.match(err.message, /window compositor produced no frame while the page still answered/);
        assert.match(err.message, /focus or move the AntiFan window once/);
        assert.doesNotMatch(err.message, /anti\.media\.freeze/);
        const diagnosis = (err.details as Record<string, unknown> | undefined)?.diagnosis as Record<string, unknown> | undefined;
        assert.strictEqual(diagnosis?.frameProduction, 'stalled');
        return true;
      }
    );
  });

  it('keeps the media-freeze remedy when the compositor still produces frames', async () => {
    const { host } = buildHost({ census: { playing: 1, buffered: 0, tags: { video: 1 }, infiniteAnimations: 2, infiniteAnimationsByClass: { Animation: 2 }, smil: 0, rafFired: true } });
    const port = new BrowserControlPort(host);

    await assert.rejects(
      () => port.screenshot(TARGET, 'run-1', 'attempt-1', 'tab-b', 'desktop'),
      (err: unknown) => {
        assert.ok(err instanceof CaptureError);
        assert.strictEqual(err.code, 'CAPTURE_TIMEOUT');
        assert.match(err.message, /anti\.media\.freeze/);
        assert.doesNotMatch(err.message, /focus or move the AntiFan window/);
        const diagnosis = (err.details as Record<string, unknown> | undefined)?.diagnosis as Record<string, unknown> | undefined;
        assert.strictEqual(diagnosis?.frameProduction, 'alive');
        return true;
      }
    );
  });
});
