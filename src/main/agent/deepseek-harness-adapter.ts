import { RunEvent, StartRunInput } from './execution-backend';

export interface DeepSeekHarnessEvent { type: string; [key: string]: unknown; }

export class DeepSeekHarnessAdapter {
  readonly featureFlag = 'ANTIFAN_DSH_SPIKE';
  mapEvent(input: DeepSeekHarnessEvent, context: Pick<StartRunInput, 'runId' | 'attemptId'>): RunEvent | null {
    if (!process.env[this.featureFlag]) return null;
    if (input.type === 'assistant/message' || input.type === 'assistant/chunk') return { type: 'text', runId: context.runId, attemptId: context.attemptId, text: typeof input.text === 'string' ? input.text : '', stream: 'stdout' };
    if (input.type === 'tool/call') return { type: 'tool/call', runId: context.runId, attemptId: context.attemptId, toolName: typeof input.name === 'string' ? input.name : 'unknown', args: (input.args && typeof input.args === 'object' ? input.args : {}) as Record<string, unknown> };
    if (input.type === 'tool/result') return { type: 'tool/result', runId: context.runId, attemptId: context.attemptId, toolName: typeof input.name === 'string' ? input.name : 'unknown', result: input.result };
    if (input.type === 'turn/end') return { type: 'status', runId: context.runId, attemptId: context.attemptId, state: 'completed' };
    if (input.type === 'turn/start') return { type: 'status', runId: context.runId, attemptId: context.attemptId, state: 'streaming' };
    return null;
  }
}
