/**
 * AntiFan Core — Theme Task Context Contract
 *
 * Lineage Anchor:
 * Connects OMP reasoning intent with AntiFan observation, monotonic element refs (@e1..@eN),
 * and local theme workspace root.
 */

export interface ThemeTaskContext {
  taskId: string;
  url: string;
  targetRef?: string;
  workspaceRoot: string;
  timestamp: number;
}

export function isThemeTaskContext(value: unknown): value is ThemeTaskContext {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const obj = value as Record<string, unknown>;
  const hasTaskId = typeof obj.taskId === 'string' && obj.taskId.trim().length > 0;
  const hasUrl = typeof obj.url === 'string' && obj.url.trim().length > 0;
  const hasWorkspaceRoot = typeof obj.workspaceRoot === 'string' && obj.workspaceRoot.trim().length > 0;
  const hasTimestamp = typeof obj.timestamp === 'number' && Number.isFinite(obj.timestamp) && obj.timestamp > 0;
  const validRef = obj.targetRef === undefined || (typeof obj.targetRef === 'string' && obj.targetRef.trim().length > 0);

  return hasTaskId && hasUrl && hasWorkspaceRoot && hasTimestamp && validRef;
}

export function assertValidThemeTaskContext(value: unknown): asserts value is ThemeTaskContext {
  if (!isThemeTaskContext(value)) {
    throw new Error(
      'Invalid ThemeTaskContext: must be an object with non-empty taskId, url, workspaceRoot, positive timestamp, and optional targetRef'
    );
  }
}
