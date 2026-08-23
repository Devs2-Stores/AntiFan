import { describe, it } from 'node:test';
import * as assert from 'node:assert';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { EventStore } from '../../src/main/session/event-store';
import { RunRecovery } from '../../src/main/session/run-recovery';

describe('Event store and run recovery', () => {
  it('replays durable facts and marks in-flight runs interrupted after restart', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'antifan-events-'));
    const store = new EventStore({ filePath: path.join(dir, 'events.jsonl'), projectId: 'project-12345678901234567890', workspaceId: 'workspace-12345678901234567890' });
    store.append({ type: 'run/start', projectId: 'project-12345678901234567890', workspaceId: 'workspace-12345678901234567890', runId: 'run-12345678901234567890', attemptId: 'attempt-12345678901234567890', createdAt: Date.now(), payload: { state: 'streaming' } });
    const recovered = new RunRecovery().recover(new EventStore({ filePath: path.join(dir, 'events.jsonl'), projectId: 'project-12345678901234567890', workspaceId: 'workspace-12345678901234567890' }).replay());
    assert.strictEqual(recovered[0]?.state, 'interrupted');
  });
});
