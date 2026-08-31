import { CapabilityCatalogue } from './capability-catalogue';
import { WorkspaceFilePort } from './workspace-file-port';
import { CapabilityError, CapabilityRequestContext, AuthenticatedCapabilityContext } from '../../shared/control-plane-contracts';

export function registerFileCapabilities(
  catalogue: CapabilityCatalogue,
  files: WorkspaceFilePort,
  getAuthoritativeWorkspaceRoot: () => string
): void {
  if (typeof getAuthoritativeWorkspaceRoot !== 'function') {
    throw new CapabilityError('INVALID_ARGUMENT', 'registerFileCapabilities requires an authoritative workspace root getter function');
  }

  const resolveRoot = (context?: CapabilityRequestContext | AuthenticatedCapabilityContext): string => {
    if (context?.projectId && context?.workspaceId) {
      try {
        const ws = catalogue.resolveAuthoritativeWorkspace(context.projectId, context.workspaceId);
        if (ws.rootPath) return ws.rootPath;
      } catch {}
    }
    return getAuthoritativeWorkspaceRoot();
  };
  catalogue.register({
    name: 'file.read',
    description: 'Read a file relative to authoritative workspace root with boundary enforcement',
    risk: 'read',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Relative path within the workspace' },
        maxBytes: { type: 'number', description: 'Maximum bytes to read' },
      },
      required: ['path'],
    },
    execute: (params: { path: string; maxBytes?: number }, context?: CapabilityRequestContext | AuthenticatedCapabilityContext) => {
      const root = resolveRoot(context);
      if (!root) throw new CapabilityError('WORKSPACE_MISMATCH', 'No authoritative workspace attached');
      if (!params.path || typeof params.path !== 'string') {
        throw new CapabilityError('INVALID_ARGUMENT', 'Relative file path is required');
      }
      return files.read(root, params.path, params.maxBytes);
    },
  });

  catalogue.register({
    name: 'file.write',
    description: 'Write a file relative to authoritative workspace root with boundary enforcement',
    risk: 'write',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Relative path within the workspace' },
        content: { type: 'string', description: 'File content to write' },
      },
      required: ['path', 'content'],
    },
    execute: (params: { path: string; content: string }, context?: CapabilityRequestContext | AuthenticatedCapabilityContext) => {
      const root = resolveRoot(context);
      if (!root) throw new CapabilityError('WORKSPACE_MISMATCH', 'No authoritative workspace attached');
      if (!params.path || typeof params.path !== 'string' || typeof params.content !== 'string') {
        throw new CapabilityError('INVALID_ARGUMENT', 'Relative file path and content are required');
      }
      return files.write(root, params.path, params.content);
    },
  });

  catalogue.register({
    name: 'file.assert_not_contains',
    description: 'Assert that a workspace file does not contain a forbidden pattern',
    risk: 'read',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Relative path within the workspace' },
        pattern: { type: 'string', description: 'Pattern that must not be present' },
      },
      required: ['path', 'pattern'],
    },
    execute: (params: { path: string; pattern: string }, context?: CapabilityRequestContext | AuthenticatedCapabilityContext) => {
      const root = resolveRoot(context);
      if (!root) throw new CapabilityError('WORKSPACE_MISMATCH', 'No authoritative workspace attached');
      if (!params.path || typeof params.path !== 'string' || !params.pattern || typeof params.pattern !== 'string') {
        throw new CapabilityError('INVALID_ARGUMENT', 'Relative file path and pattern are required');
      }
      const res = files.read(root, params.path);
      if (res.content.includes(params.pattern)) {
        throw new Error(`File '${params.path}' contains forbidden pattern: '${params.pattern}'`);
      }
      return { ok: true };
    },
  });
}
