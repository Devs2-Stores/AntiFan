import { randomUUID } from 'node:crypto';

export type McpEvidence = { timestamp?: number; tabId?: string; url?: string; title?: string; viewport?: { width: number; height: number } };
export function requestId(value: unknown): string { return typeof value === 'string' && value.trim() ? value : `req_${randomUUID()}`; }
export function envelope<T>(data: T, evidence: McpEvidence = {}) { return { ok: true, requestId: requestId(undefined), data, evidence: { timestamp: Date.now(), ...evidence } }; }
export function failure(message: string, evidence: McpEvidence = {}) { return { ok: false, error: { code: 'MCP_TOOL_ERROR', message }, evidence: { timestamp: Date.now(), ...evidence } }; }
