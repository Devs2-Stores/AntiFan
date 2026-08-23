import { describe, it } from 'node:test';
import * as assert from 'node:assert';
import * as os from 'node:os';
import * as path from 'node:path';
import { ProjectRegistry } from '../../src/main/project/project-registry';
import { WorkspaceRegistry } from '../../src/main/project/workspace-registry';
import { ChatStore } from '../../src/main/chat/chat-store';

describe('Project/Workspace/Chat ownership', () => {
  it('keeps workspace and chat lineage immutable and close idempotent', () => {
    const projects = new ProjectRegistry();
    const workspaces = new WorkspaceRegistry(projects);
    const project = projects.createProject('Theme', path.join(os.tmpdir(), 'antifan-project'));
    const workspace = workspaces.attach(project.id, path.join(os.tmpdir(), 'antifan-workspace'));
    const chatStore = new ChatStore();
    const chat = chatStore.create(project.id, workspace.id, 'QA');
    assert.strictEqual(chatStore.get(chat.id, project.id, workspace.id).workspaceId, workspace.id);
    assert.strictEqual(chatStore.close(chat.id, project.id).state, 'closed');
    assert.strictEqual(chatStore.close(chat.id, project.id).state, 'closed');
    assert.throws(() => chatStore.get(chat.id, `project-invalid`));
  });
});
