import { ControlPlaneEvent, RunState } from '../../shared/control-plane-contracts';

export interface RecoveredRun {
  runId: string;
  state: RunState;
  attemptIds: string[];
  lastSequence: number;
}

export class RunRecovery {
  recover(events: ControlPlaneEvent[]): RecoveredRun[] {
    const runs = new Map<string, RecoveredRun>();
    for (const event of events) {
      if (!event.runId) continue;
      const current = runs.get(event.runId) || { runId: event.runId, state: 'queued' as RunState, attemptIds: [], lastSequence: event.sequence };
      current.lastSequence = Math.max(current.lastSequence, event.sequence);
      if (event.attemptId && !current.attemptIds.includes(event.attemptId)) current.attemptIds.push(event.attemptId);
      if (event.type === 'run/start' || event.type === 'backend/status') current.state = (event.payload as { state?: RunState }).state || current.state;
      if (event.type === 'run/end') current.state = (event.payload as { state?: RunState }).state || 'completed';
      runs.set(event.runId, current);
    }
    for (const run of runs.values()) {
      if (run.state === 'starting' || run.state === 'streaming' || run.state === 'waiting-tool' || run.state === 'cancelling') run.state = 'interrupted';
    }
    return Array.from(runs.values());
  }
}
