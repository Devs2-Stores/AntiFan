import { describe, it } from 'node:test';
import * as assert from 'node:assert';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { WorkspaceFilePort } from '../../src/main/tools/workspace-file-port';
import { CapabilityError } from '../../src/shared/control-plane-contracts';

describe('Workspace file port', () => {
  it('rejects absolute/traversal writes and stages bounded attachments', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'antifan-files-'));
    fs.writeFileSync(path.join(root, 'theme.css'), 'body { color: red; }');
    const port = new WorkspaceFilePort();
    assert.strictEqual(port.read(root, 'theme.css').content, 'body { color: red; }');
    assert.throws(() => port.read(root, '../outside.txt'), (error: unknown) => error instanceof CapabilityError);
    const artifact = port.stageAttachment(root, 'theme.css', 'run-12345678901234567890', 'attempt-12345678901234567890');
    assert.strictEqual(artifact.kind, 'attachment');
  });
});
