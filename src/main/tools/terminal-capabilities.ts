import { CapabilityCatalogue } from './capability-catalogue';
import { TerminalManager } from '../browser/terminal-manager';
import {
  CapabilityError,
  CapabilityRequestContext,
  AuthenticatedCapabilityContext,
  TerminalWaitInput,
  TerminalWaitResult,
} from '../../shared/control-plane-contracts';

export function registerTerminalCapabilities(
  catalogue: CapabilityCatalogue,
  terminal: TerminalManager
): void {
  catalogue.register<{ sessionId: string; input: string }, { written: boolean }>({
    name: 'terminal.write',
    description: 'Write raw input text to an active PTY terminal session',
    risk: 'write',
    policy: {
      effect: 'interactive-effect',
      risk: 'write',
      requiresBrowserTarget: false,
      schedulerLane: 'unbounded',
      duplicateMode: 'reject-concurrent',
      recordedVisibility: 'tenant-scoped',
      receiptReadPermission: 'write',
      timeoutMs: 15_000,
      retentionPolicy: 'run-durable',
      ownerCancellationBehavior: 'abort-immediate',
      subscriberDisconnectBehavior: 'abort-when-unobserved',
      cancellationAckTimeoutMs: 5_000,
      policyVersion: 1,
    },
    inputSchema: {
      type: 'object',
      properties: {
        sessionId: { type: 'string', description: 'Target terminal session ID' },
        input: { type: 'string', description: 'Data/commands to write into PTY stdin' },
      },
      required: ['sessionId', 'input'],
    },
    execute: (params: { sessionId: string; input: string }) => {
      if (!params.sessionId || typeof params.sessionId !== 'string') {
        throw new CapabilityError('INVALID_ARGUMENT', 'sessionId is required');
      }
      if (typeof params.input !== 'string') {
        throw new CapabilityError('INVALID_ARGUMENT', 'input string is required');
      }
      terminal.writeTo(params.sessionId, params.input);
      return { written: true };
    },
  });

  catalogue.register<{ sessionId: string; cols: number; rows: number }, { resized: boolean }>({
    name: 'terminal.resize',
    description: 'Resize terminal rows and columns for an active PTY session',
    risk: 'write',
    policy: {
      effect: 'idempotent-write',
      risk: 'write',
      requiresBrowserTarget: false,
      schedulerLane: 'unbounded',
      duplicateMode: 'reject-concurrent',
      recordedVisibility: 'tenant-scoped',
      receiptReadPermission: 'write',
      timeoutMs: 15_000,
      retentionPolicy: 'run-durable',
      ownerCancellationBehavior: 'abort-immediate',
      subscriberDisconnectBehavior: 'abort-when-unobserved',
      cancellationAckTimeoutMs: 5_000,
      policyVersion: 1,
    },
    inputSchema: {
      type: 'object',
      properties: {
        sessionId: { type: 'string', description: 'Target terminal session ID' },
        cols: { type: 'number', description: 'Terminal columns' },
        rows: { type: 'number', description: 'Terminal rows' },
      },
      required: ['sessionId', 'cols', 'rows'],
    },
    execute: (params: { sessionId: string; cols: number; rows: number }) => {
      if (!params.sessionId || typeof params.sessionId !== 'string') {
        throw new CapabilityError('INVALID_ARGUMENT', 'sessionId is required');
      }
      terminal.resizeTo(params.sessionId, params.cols, params.rows);
      return { resized: true };
    },
  });

  catalogue.register<TerminalWaitInput, TerminalWaitResult>({
    name: 'terminal.wait',
    description: 'Wait for output-match pattern, process exit, or silence on a terminal session',
    risk: 'read',
    policy: {
      effect: 'read',
      risk: 'read',
      requiresBrowserTarget: false,
      schedulerLane: 'event-wait',
      duplicateMode: 'in-process-join',
      recordedVisibility: 'tenant-scoped',
      receiptReadPermission: 'read',
      timeoutMs: 30_000,
      retentionPolicy: 'run-durable',
      ownerCancellationBehavior: 'abort-immediate',
      subscriberDisconnectBehavior: 'abort-when-unobserved',
      cancellationAckTimeoutMs: 5_000,
      policyVersion: 1,
    },
    inputSchema: {
      type: 'object',
      properties: {
        sessionId: { type: 'string', description: 'Terminal session ID' },
        condition: { type: 'string', enum: ['output-match', 'exit', 'silence'] },
        pattern: { type: 'string', description: 'Regex pattern for output-match' },
        sessionGeneration: { type: 'number', description: 'Expected session incarnation' },
        afterSeq: { type: 'number', description: 'Sequence cursor' },
        silenceMs: { type: 'number', description: 'Silence duration threshold in milliseconds' },
        timeoutMs: { type: 'number', description: 'Wait deadline in milliseconds' },
      },
      required: ['sessionId', 'condition'],
    },
    execute: (
      params: TerminalWaitInput,
      context?: CapabilityRequestContext | AuthenticatedCapabilityContext
    ) => {
      const signal = context && 'signal' in context ? context.signal : undefined;
      return terminal.waitTerminal(params, signal);
    },
  });

  catalogue.register<{ paged?: boolean }, { sessions: unknown[]; activeSessionId: string }>({
    name: 'terminal.list',
    description: 'List active terminal sessions with bounded wire summary and incarnation metadata',
    risk: 'read',
    policy: {
      effect: 'read',
      risk: 'read',
      requiresBrowserTarget: false,
      schedulerLane: 'unbounded',
      duplicateMode: 'in-process-join',
      recordedVisibility: 'tenant-scoped',
      receiptReadPermission: 'read',
      timeoutMs: 15_000,
      retentionPolicy: 'run-durable',
      ownerCancellationBehavior: 'abort-immediate',
      subscriberDisconnectBehavior: 'abort-when-unobserved',
      cancellationAckTimeoutMs: 5_000,
      policyVersion: 1,
    },
    inputSchema: {
      type: 'object',
      properties: {
        paged: { type: 'boolean', description: 'Whether to page buffers according to wire budget' },
      },
    },
    execute: (params: { paged?: boolean }) => {
      return {
        sessions: terminal.listSessions(params.paged ?? true),
        activeSessionId: terminal.getActiveSessionId(),
      };
    },
  });

  catalogue.register<{
    cwd?: string;
    parentId?: string;
    initialCols?: number;
    initialRows?: number;
  }, { sessionId: string }>({
    name: 'terminal.create',
    description: 'Create a new base or split terminal PTY session',
    risk: 'write',
    policy: {
      effect: 'management',
      risk: 'write',
      requiresBrowserTarget: false,
      schedulerLane: 'unbounded',
      duplicateMode: 'reject-concurrent',
      recordedVisibility: 'tenant-scoped',
      receiptReadPermission: 'write',
      timeoutMs: 15_000,
      retentionPolicy: 'run-durable',
      ownerCancellationBehavior: 'abort-immediate',
      subscriberDisconnectBehavior: 'abort-when-unobserved',
      cancellationAckTimeoutMs: 5_000,
      policyVersion: 1,
    },
    inputSchema: {
      type: 'object',
      properties: {
        cwd: { type: 'string' },
        parentId: { type: 'string' },
        initialCols: { type: 'number' },
        initialRows: { type: 'number' },
      },
    },
    execute: (params: { cwd?: string; parentId?: string; initialCols?: number; initialRows?: number }) => {
      const id = params.parentId
        ? terminal.createSplitSession(params.parentId, params.cwd, params.initialCols, params.initialRows)
        : terminal.createSession(params.cwd);
      return { sessionId: id };
    },
  });

  catalogue.register<{ sessionId: string; isSplit?: boolean }, { closed: boolean }>({
    name: 'terminal.close',
    description: 'Close a terminal session and safely terminate its process tree',
    risk: 'write',
    policy: {
      effect: 'management',
      risk: 'write',
      requiresBrowserTarget: false,
      schedulerLane: 'unbounded',
      duplicateMode: 'reject-concurrent',
      recordedVisibility: 'tenant-scoped',
      receiptReadPermission: 'write',
      timeoutMs: 15_000,
      retentionPolicy: 'run-durable',
      ownerCancellationBehavior: 'abort-immediate',
      subscriberDisconnectBehavior: 'abort-when-unobserved',
      cancellationAckTimeoutMs: 5_000,
      policyVersion: 1,
    },
    inputSchema: {
      type: 'object',
      properties: {
        sessionId: { type: 'string', description: 'Session ID to close' },
        isSplit: { type: 'boolean', description: 'Whether target is a split session' },
      },
      required: ['sessionId'],
    },
    execute: async (params: { sessionId: string; isSplit?: boolean }) => {
      if (!params.sessionId || typeof params.sessionId !== 'string') {
        throw new CapabilityError('INVALID_ARGUMENT', 'sessionId is required');
      }
      const closed = params.isSplit
        ? await terminal.closeSplitSession(params.sessionId)
        : await terminal.closeSession(params.sessionId);
      return { closed };
    },
  });
}
