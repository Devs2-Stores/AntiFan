import { protocol, Response } from 'electron';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { WorkspaceCapsuleManager, WorkspaceCapsule } from '../project/workspace-capsule';
import { ParsedPreviewUrl, parsePreviewUrl } from './preview-url-codec';
import { safeResolveAndOpenFile } from './safe-fs-resolver';

const CAPSULE_HOST_REGEX = /^capsule-[a-z0-9-]+$/i;

/**
 * Locate a capsule by host name with case-insensitive normalization.
 */
export function findCapsuleByHost(capsuleManager: WorkspaceCapsuleManager, host: string): WorkspaceCapsule | null {
  if (!host || !CAPSULE_HOST_REGEX.test(host)) {
    return null;
  }
  const normalizedHost = host.toLowerCase().trim();
  const all = capsuleManager.list();
  return all.find((c) => c.id.toLowerCase() === normalizedHost) || null;
}

/**
 * Register the custom protocol handler for antifan-preview://.
 * Origin-per-capsule mapping with canonical root containment.
 *
 * Threat Model & Security Scope:
 * - Protects against static malicious repository assets, encoded URL traversal, and in-root secret leaks.
 * - Assumes non-hostile local concurrent workspace writers (standard userspace Node.js boundary).
 */
export function registerPreviewProtocolHandler(capsuleManager: WorkspaceCapsuleManager): void {
  protocol.handle('antifan-preview', async (request) => {
    try {
      let parsedUrl: ParsedPreviewUrl;
      try {
        parsedUrl = parsePreviewUrl(request.url);
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : '400 Bad Request';
        return new Response(message, { status: 400 });
      }

      const { capsuleId, relativePath } = parsedUrl;

      // 1. Validate host format
      if (!CAPSULE_HOST_REGEX.test(capsuleId)) {
        return new Response('400 Bad Request: Invalid capsule origin format.', { status: 400 });
      }

      // 2. Strict Capsule Lookup by immutable Host (not mutable active capsule)
      const capsule = findCapsuleByHost(capsuleManager, capsuleId);
      if (!capsule || !capsule.workspacePath) {
        return new Response('404 Not Found: Capsule workspace is not registered or missing.', { status: 404 });
      }

      if (!fs.existsSync(capsule.workspacePath)) {
        return new Response('404 Not Found: Capsule workspace directory does not exist on disk.', { status: 404 });
      }

      let canonicalRoot: string;
      try {
        canonicalRoot = fs.realpathSync.native(path.resolve(capsule.workspacePath));
      } catch {
        return new Response('404 Not Found: Unable to resolve canonical workspace root.', { status: 404 });
      }

      // 3. Resolve and open file securely
      const result = await safeResolveAndOpenFile(canonicalRoot, relativePath);
      if (!result.ok) {
        return new Response(result.message, { status: result.status });
      }

      return new Response(result.stream as unknown as BodyInit, {
        status: 200,
        headers: {
          'Content-Type': result.mimeType,
          'Content-Length': String(result.size),
          'X-Content-Type-Options': 'nosniff',
          'Cache-Control': 'no-cache, no-store, must-revalidate',
        },
      });
    } catch {
      return new Response('500 Internal Server Error', { status: 500 });
    }
  });
}
