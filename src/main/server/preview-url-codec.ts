import * as path from 'node:path';

export interface ParsedPreviewUrl {
  capsuleId: string;
  relativePath: string;
}

/**
 * Build a canonical antifan-preview:// URL from a capsule ID and a workspace-relative filesystem path.
 * Enforces segment-by-segment encoding without .trim() to prevent semantic corruption of valid filenames.
 */
export function buildPreviewUrl(capsuleId: string, rawRelativePath: string): string {
  if (!capsuleId || typeof capsuleId !== 'string') {
    throw new Error('Invalid capsuleId');
  }

  if (typeof rawRelativePath !== 'string' || rawRelativePath.length === 0) {
    throw new Error('Relative path cannot be empty');
  }

  // Reject absolute paths, drive letters, and UNC network shares
  if (
    path.isAbsolute(rawRelativePath) ||
    /^[a-zA-Z]:/i.test(rawRelativePath) ||
    rawRelativePath.startsWith('\\\\') ||
    rawRelativePath.startsWith('//')
  ) {
    throw new Error(`Forbidden: Absolute, drive-letter, or UNC paths are not allowed: ${rawRelativePath}`);
  }

  // Normalize Windows backslashes to forward slashes
  const normalizedSeparators = rawRelativePath.replace(/\\/g, '/');

  // Split into individual segments, preserving non-empty segments
  const rawSegments = normalizedSeparators.split('/').filter((seg) => seg.length > 0);

  for (const seg of rawSegments) {
    if (seg === '.' || seg === '..' || seg.includes('\0')) {
      throw new Error(`Forbidden path segment: '${seg}'`);
    }
  }

  // Encode each segment individually
  const encodedSegments = rawSegments.map((seg) => encodeURIComponent(seg));
  const encodedPath = encodedSegments.join('/');

  const normalizedCapsuleHost = encodeURIComponent(capsuleId.toLowerCase());
  return `antifan-preview://${normalizedCapsuleHost}/${encodedPath}`;
}

/**
 * Parse and validate an antifan-preview:// URL.
 * Performs post-decode deep inspection on each segment to reject encoded separators (%2F, %5C),
 * dot traversals (%2E%2E), and null bytes.
 */
export function parsePreviewUrl(rawUrl: string): ParsedPreviewUrl {
  const parsed = new URL(rawUrl);
  const capsuleId = decodeURIComponent(parsed.host).toLowerCase();

  const rawSegments = parsed.pathname.split('/').filter((seg) => seg.length > 0);
  const decodedSegments: string[] = [];

  for (const rawSeg of rawSegments) {
    let decodedSeg: string;
    try {
      decodedSeg = decodeURIComponent(rawSeg);
    } catch {
      throw new Error(`400 Bad Request: Malformed URL encoding in segment: '${rawSeg}'`);
    }

    // Guard 1: Reject injected separators (%2F or %5C)
    if (decodedSeg.includes('/') || decodedSeg.includes('\\')) {
      throw new Error(`403 Forbidden: Encoded path separator detected inside segment: '${rawSeg}'`);
    }

    // Guard 2: Reject dot traversals
    if (decodedSeg === '.' || decodedSeg === '..') {
      throw new Error(`403 Forbidden: Encoded dot directory traversal segment: '${rawSeg}'`);
    }

    // Guard 3: Reject null bytes
    if (decodedSeg.includes('\0')) {
      throw new Error(`403 Forbidden: Null byte injection detected in segment: '${rawSeg}'`);
    }

    decodedSegments.push(decodedSeg);
  }

  const relativePath = '/' + decodedSegments.join('/');
  return {
    capsuleId,
    relativePath,
  };
}
