import { describe, it, before, after } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { ArtifactStore } from '../src/main/tools/artifact-store';
import { WorkflowRegistry } from '../src/main/workflow/workflow-registry';

describe('Workflow & Artifact Security and Hub Registry', () => {
  const tmpDir = path.join(os.tmpdir(), `antifan-test-hub-${Date.now()}`);
  const artifactsRoot = path.join(tmpDir, 'artifacts');
  const workflowsDir = path.join(tmpDir, 'workflows');

  before(() => {
    fs.mkdirSync(artifactsRoot, { recursive: true });
    fs.mkdirSync(workflowsDir, { recursive: true });
  });

  after(() => {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {}
  });

  describe('ArtifactStore ID-based Lookup & Path Containment', () => {
    it('stages artifact with unique ID and allows reading by ID', () => {
      const store = new ArtifactStore({ root: artifactsRoot });
      const ref = store.stage({
        kind: 'screenshot',
        mime: 'image/png',
        data: Buffer.from('fake-png-bytes-12345'),
        runId: 'run-001',
        attemptId: 'att-001',
      });

      assert.ok(ref.id.startsWith('artifact-'));
      assert.strictEqual(ref.mime, 'image/png');

      const readResult = store.readBytesById(ref.id);
      assert.strictEqual(readResult.ref.id, ref.id);
      assert.strictEqual(readResult.data.toString(), 'fake-png-bytes-12345');

      const textResult = store.readTextById(ref.id);
      assert.strictEqual(textResult.text, 'fake-png-bytes-12345');
    });

    it('rejects non-existent artifact IDs with INVALID_ARGUMENT', () => {
      const store = new ArtifactStore({ root: artifactsRoot });
      assert.throws(
        () => store.readBytesById('artifact-non-existent-uuid'),
        (err: any) => err.code === 'INVALID_ARGUMENT' || err.message.includes('not found')
      );
    });

    it('rejects arbitrary filesystem paths that are not staged in store', () => {
      const store = new ArtifactStore({ root: artifactsRoot });
      assert.throws(
        () => store.readBytesById('C:\\Windows\\System32\\drivers\\etc\\hosts'),
        (err: any) => err.code === 'INVALID_ARGUMENT' || err.message.includes('not found')
      );
      assert.throws(
        () => store.readBytesById('/etc/passwd'),
        (err: any) => err.code === 'INVALID_ARGUMENT' || err.message.includes('not found')
      );
    });

    it('enforces containment and rejects traversal outside artifact root', () => {
      const store = new ArtifactStore({ root: artifactsRoot });
      const outsideFile = path.join(tmpDir, 'outside-secret.txt');
      fs.writeFileSync(outsideFile, 'secret-data');

      // Inject a crafted ref pointing outside root
      const fakeRef: any = {
        id: 'artifact-evil-traversal',
        runId: 'run-evil',
        attemptId: 'att-evil',
        kind: 'log',
        path: outsideFile,
        byteLength: 11,
        sha256: 'deadbeef',
        mime: 'text/plain',
        truncated: false,
        redacted: false,
        createdAt: Date.now(),
      };
      (store as any).artifacts.set(fakeRef.id, fakeRef);

      assert.throws(
        () => store.readBytesById(fakeRef.id),
        (err: any) => err.code === 'OUTSIDE_WORKSPACE' || err.message.includes('containment violation')
      );
    });

    it('rejects symbolic link inside root pointing outside root', () => {
      const store = new ArtifactStore({ root: artifactsRoot });
      const outsideTarget = path.join(tmpDir, 'outside-target.txt');
      fs.writeFileSync(outsideTarget, 'target-outside-content');

      const symlinkInsideRoot = path.join(artifactsRoot, 'symlink-to-outside.txt');
      try {
        fs.symlinkSync(outsideTarget, symlinkInsideRoot, 'file');
      } catch {
        // If OS environment does not permit symlink creation without admin rights, skip symlink creation
        return;
      }

      const symlinkRef: any = {
        id: 'artifact-symlink-escape',
        runId: 'run-symlink',
        attemptId: 'att-symlink',
        kind: 'log',
        path: symlinkInsideRoot,
        byteLength: 22,
        sha256: 'deadbeef',
        mime: 'text/plain',
        truncated: false,
        redacted: false,
        createdAt: Date.now(),
      };
      (store as any).artifacts.set(symlinkRef.id, symlinkRef);

      assert.throws(
        () => store.readBytesById(symlinkRef.id),
        (err: any) => err.code === 'OUTSIDE_WORKSPACE' || err.message.includes('symbolic links are not permitted') || err.message.includes('containment violation')
      );
    });
  });

  describe('WorkflowRegistry Built-ins and Custom Workflows', () => {
    it('provides default built-in workflows out of the box', () => {
      const registry = new WorkflowRegistry(workflowsDir);
      const all = registry.getAll();
      assert.ok(all.length >= 3);

      const qaWf = registry.getById('wf-storefront-qa');
      assert.ok(qaWf);
      assert.strictEqual(qaWf.category, 'qa');
      assert.ok(qaWf.definition.steps.length >= 4);

      const pdpWf = registry.getById('wf-mobile-pdp-stress-test');
      assert.ok(pdpWf);
      assert.strictEqual(pdpWf.category, 'ecommerce');

      const secWf = registry.getById('wf-theme-security-scan');
      assert.ok(secWf);
      assert.strictEqual(secWf.category, 'security');
    });

    it('saves, persists, retrieves, and deletes custom workflows', () => {
      const registry = new WorkflowRegistry(workflowsDir);
      const custom = registry.saveCustom({
        name: 'Custom Checkout Flow',
        description: 'Test custom flow',
        steps: [
          {
            id: 's1',
            name: 'Step 1',
            type: 'browser.click' as const,
            params: { selector: '.btn' },
            timeoutMs: 5000,
            retryCount: 0,
            continueOnError: false,
          },
        ],
      });

      assert.ok(custom.id);
      assert.strictEqual(custom.isBuiltIn, false);
      assert.strictEqual(registry.getById(custom.id)?.name, 'Custom Checkout Flow');

      // Check persistence by creating new registry instance from same dir
      const reloadedRegistry = new WorkflowRegistry(workflowsDir);
      const reloadedCustom = reloadedRegistry.getById(custom.id);
      assert.ok(reloadedCustom);
      assert.strictEqual(reloadedCustom.name, 'Custom Checkout Flow');

      // Delete custom
      const deleted = reloadedRegistry.deleteCustom(custom.id);
      assert.strictEqual(deleted, true);
      assert.strictEqual(reloadedRegistry.getById(custom.id), undefined);
    });
  });
});
