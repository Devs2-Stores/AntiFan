// Phase 1 (Explicit Authority & Dual-Plane Cutover): Canonical Ownership & Transient Lifetime
// Verifies the composition-root invariant:
//   - TerminalManager.getInstance() returns ONE canonical instance across repeated calls,
//     and no external code can spawn a second owner (private constructor).
//   - ControlPlaneRuntime receives the canonical instance via required options and registers
//     terminal capabilities against that same instance (not a separate singleton pull).
import { describe, it, before, after } from 'node:test';
import * as assert from 'node:assert/strict';
import { TerminalManager } from '../../src/main/browser/terminal-manager';
import { ControlPlaneRuntime } from '../../src/main/control-plane/control-plane-runtime';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

describe('Phase 1 - Canonical TerminalManager Ownership', () => {
  const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'antifan-p1-canonical-'));
  const projectId = 'project-00000000-0000-4000-8000-0000000000c1';
  const workspaceId = 'workspace-00000000-0000-4000-8000-0000000000c1';
  const originalInstance = (TerminalManager as any).instance;

  before(() => {
    (TerminalManager as any).instance = undefined;
  });

  after(async () => {
    (TerminalManager as any).instance = originalInstance; // restore for other suites
    try { fs.rmSync(dataRoot, { recursive: true, force: true }); } catch {}
  });

  it('1.1 getInstance() returns the same canonical instance across repeated calls', () => {
    const a = TerminalManager.getInstance();
    const b = TerminalManager.getInstance();
    assert.strictEqual(a, b, 'repeated getInstance() must be identity-equal (one registry)');
  });

  it('1.2 constructing a second TerminalManager is rejected while a canonical lives', () => {
    // The constructor is private and increments a construction counter; the dual-plane
    // invariant forbids a second live owner. While the canonical from 1.1 is alive, an
    // external construction attempt must throw.
    assert.strictEqual(TerminalManager.getInstance(), TerminalManager.getInstance(), 'single canonical established');
    // @ts-expect-error - private constructor; runtime still guards against a second owner
    assert.throws(() => new TerminalManager(), /second instance was constructed/);
    // After the throw, the canonical is still the same live instance (not corrupted).
    assert.strictEqual(TerminalManager.getInstance(), TerminalManager.getInstance(), 'canonical unchanged after rejected construction');
  });

  it('1.3 ControlPlaneRuntime uses the injected canonical instance, not a separate singleton', async () => {
    const canonical = TerminalManager.getInstance();
    const controlPlane = new ControlPlaneRuntime({
      projectId,
      workspaceId,
      dataRoot,
      terminal: canonical,
    });
    await controlPlane.initialize();
    try {
      assert.strictEqual(controlPlane.terminal, canonical, 'control plane must hold the injected canonical instance');
    } finally {
      // nothing to tear down; control plane has no external resources for this test
    }
  });

  it('1.4 canonical instance creates a session that the canonical getInstance() observes', () => {
    const canonical = TerminalManager.getInstance();
    const sessionId = canonical.createSession('/tmp');
    try {
      assert.ok(sessionId.startsWith('terminal-'));
      assert.ok(TerminalManager.getInstance().getSession(sessionId), 'session must be visible via getInstance()');
    } finally {
      void canonical.closeSession?.(sessionId)?.then?.(() => {});
    }
  });
});