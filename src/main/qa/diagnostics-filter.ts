import { resolve } from 'node:path';

/**
 * AntiFan Browser Desktop — Shared Diagnostics Testability Filter
 * Single source of truth for origin classification and fail-fast gating,
 * used by BOTH the full ThemeQaWorkflow.validate path and the fallback quick
 * path (browser-capabilities.ts theme.qa_validate).
 *
 * Failure policy (Plan: QA Gate Trust, Red Team Session 1):
 * - Console level >= 3 from first-party/theme-asset sources => critical.
 * - Network failures (Chromium NetError < 0, except -3 aborted; or HTTP >= 400)
 *   from first-party/theme-asset sources => critical.
 * - Third-party noise (GTM, FB Pixel, chat widgets) => warnings only.
 * - isMainFrame network failure => critical unless ERR_ABORTED (user cancel).
 *
 * This module is PURE: no I/O, no Electron. All output text is sanitized
 * (control chars, backticks, role markers stripped; URLs lose query strings).
 */

export interface OriginInfo {
  origin: string;
  isFirstParty: boolean;
}

/** CDN hosts that serve theme assets and count as first-party for QA gating. */
export const THEME_ASSET_HOSTS: readonly string[] = [
  'hstatic.net',
  'shopifycdn.com',
  'cdn.shopify.com',
  'cdn.sapo.vn',
  'dktcdn.net',
  'bizweb.dktcdn.net',
];

const MAX_MESSAGE_LENGTH = 200;
const ROLE_MARKER_PATTERN = /\[?\s*(?:SYSTEM|system|assistant|user)\s*\]?\s*:/g;
const CONTROL_CHAR_PATTERN = /[\u0000-\u001f\u007f]/g;

function normalizeHostname(host: string): string {
  return host.trim().toLowerCase().replace(/^www\./, '');
}

function hostnameOf(value: string): string {
  try {
    return new URL(value).hostname || '';
  } catch {
    return '';
  }
}

/**
 * Classify whether a diagnostic source belongs to the storefront tab.
 * Non-parseable sources (empty, "eval at <anonymous>", blob:, javascript:,
 * data:) fall back to the tab origin and count as first-party — inline page
 * scripts are page-owned. Never throws (Red Team Finding 7).
 */
export function computeOrigin(sourceUrl: string, baseUrl: string): OriginInfo {
  let baseHost = '';
  try {
    baseHost = hostnameOf(baseUrl);
  } catch {
    baseHost = '';
  }

  let sourceHost = '';
  try {
    const parsed = new URL(sourceUrl || '');
    sourceHost = parsed.hostname || '';
    if (!sourceHost && parsed.protocol === 'blob:') {
      // blob:https://store.example.com/uuid -> inner URL carries the origin
      try {
        sourceHost = new URL(parsed.pathname).hostname || '';
      } catch {
        sourceHost = '';
      }
    }
  } catch {
    sourceHost = '';
  }

  if (!sourceHost) {
    // Inline / eval / blob-without-origin / data: — page-owned by default
    return { origin: baseHost, isFirstParty: true };
  }

  const src = normalizeHostname(sourceHost);
  const base = normalizeHostname(baseHost);
  if (!base) {
    // No base host to compare against: cannot prove third-party, treat as page-owned
    return { origin: src, isFirstParty: true };
  }
  const isFirstParty = src === base || src.endsWith(`.${base}`);
  return { origin: src, isFirstParty };
}

/**
 * Strip control characters, backticks, and role markers from untrusted
 * diagnostic text, then truncate (Red Team Findings 9, 10).
 */
export function sanitizeDiagnosticText(text: string, maxLength: number = MAX_MESSAGE_LENGTH): string {
  if (!text) return '';
  const cleaned = String(text)
    .replace(CONTROL_CHAR_PATTERN, '')
    .replace(/`/g, '')
    .replace(ROLE_MARKER_PATTERN, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (cleaned.length <= maxLength) return cleaned;
  return `${cleaned.slice(0, maxLength)}…`;
}

/**
 * Remove query string and fragment from a URL so tokens/emails in params
 * (e.g. ?apiKey=..&token=..&email=..) never reach reports or agent prompts.
 */
export function stripUrlQuery(url: string): string {
  if (!url) return '';
  try {
    const parsed = new URL(url);
    parsed.search = '';
    parsed.hash = '';
    return parsed.toString();
  } catch {
    // Unparseable source: cut at the first query/fragment marker
    return String(url).split(/[?#]/)[0] || '';
  }
}

/** Structural views of diagnostics entries. Kept local to avoid import cycles. */
export interface ConsoleEntryLike {
  level?: number | string;
  message?: string;
  source?: string;
  origin?: string;
  isFirstParty?: boolean;
}

export interface NetworkFailureLike {
  errorCode?: number;
  errorDescription?: string;
  validatedURL?: string;
  isMainFrame?: boolean;
  status?: number;
  origin?: string;
  isFirstParty?: boolean;
}

export interface DiagnosticsInput {
  console?: ConsoleEntryLike[];
  failures?: NetworkFailureLike[];
}

export interface DiagnosticIssue {
  kind: 'console' | 'network';
  message: string;
  origin: string;
}

export interface ClassificationResult {
  criticalIssues: DiagnosticIssue[];
  warnings: DiagnosticIssue[];
}

export interface ClassifyOptions {
  themeAssetHosts?: readonly string[];
}

function isThemeAssetHost(origin: string, assetHosts: readonly string[]): boolean {
  if (!origin) return false;
  const host = normalizeHostname(origin);
  return assetHosts.some((asset) => {
    const a = normalizeHostname(asset);
    return a !== '' && (host === a || host.endsWith(`.${a}`));
  });
}

/**
 * Decide critical vs warning for a diagnostics snapshot.
 * `contextUrl` is the storefront tab URL — used only when an entry lacks
 * explicit origin/isFirstParty flags (phase 1 recorders attach them).
 */
export function classifyDiagnostics(
  diagnostics: DiagnosticsInput,
  contextUrl: string,
  opts: ClassifyOptions = {}
): ClassificationResult {
  const assetHosts = opts.themeAssetHosts ?? THEME_ASSET_HOSTS;
  const criticalIssues: DiagnosticIssue[] = [];
  const warnings: DiagnosticIssue[] = [];

  for (const entry of diagnostics.console ?? []) {
    const level = typeof entry.level === 'number' ? entry.level : Number.parseInt(String(entry.level ?? ''), 10);
    if (!Number.isFinite(level) || level < 3) continue; // filter below error level

    const originInfo = entry.origin !== undefined && entry.isFirstParty !== undefined
      ? { origin: String(entry.origin), isFirstParty: Boolean(entry.isFirstParty) }
      : computeOrigin(entry.source || '', contextUrl);
    const origin = normalizeHostname(originInfo.origin);
    const message = sanitizeDiagnosticText(entry.message || '');

    const issue: DiagnosticIssue = { kind: 'console', origin, message };
    if (originInfo.isFirstParty || isThemeAssetHost(origin, assetHosts)) {
      criticalIssues.push(issue);
    } else {
      warnings.push(issue);
    }
  }

  for (const entry of diagnostics.failures ?? []) {
    const originInfo = entry.origin !== undefined && entry.isFirstParty !== undefined
      ? { origin: String(entry.origin), isFirstParty: Boolean(entry.isFirstParty) }
      : computeOrigin(entry.validatedURL || '', contextUrl);
    const origin = normalizeHostname(originInfo.origin);
    const message = sanitizeDiagnosticText(
      `${entry.errorDescription || 'Network failure'} — ${stripUrlQuery(entry.validatedURL || '')}`
    );

    const status = typeof entry.status === 'number' ? entry.status : typeof entry.errorCode === 'number' ? entry.errorCode : 0;
    // Chromium NetError codes are negative; ERR_ABORTED (-3) is a user/navigation
    // cancel, not a load failure (Red Team Finding 1 — errorCode >= 400 is dead
    // for did-fail-load, kept only as the HTTP-status extension path).
    const isRealFailure = (typeof entry.errorCode === 'number' && entry.errorCode < 0 && entry.errorCode !== -3) || status >= 400;
    if (!isRealFailure) continue;

    const issue: DiagnosticIssue = { kind: 'network', origin, message };
    if (entry.isMainFrame === true && entry.errorCode !== -3) {
      if (status >= 400 && status < 500) {
        // Main-frame 4xx (e.g. 401/403 password challenge on dev stores, 404) is non-fatal warning
        warnings.push(issue);
      } else {
        // Main-frame 5xx server crash or negative Chromium net error: the page itself did not load — always critical
        criticalIssues.push(issue);
      }
    } else if (originInfo.isFirstParty || isThemeAssetHost(origin, assetHosts)) {
      criticalIssues.push(issue);
    } else {
      warnings.push(issue);
    }
  }

  return { criticalIssues, warnings };
}

export interface CorrelatableFailure {
  url: string;
  status?: number;
  errorText?: string;
}

/**
 * Filter first-party/theme-asset network failures for BrokenAssetScanner correlation.
 * Rejects ERR_ABORTED (-3) and third-party failures.
 */
export function extractCorrelatableAssetFailures(
  failures: unknown[] | undefined,
  contextUrl: string,
  assetHosts: readonly string[] = THEME_ASSET_HOSTS
): CorrelatableFailure[] {
  if (!Array.isArray(failures) || failures.length === 0) return [];
  return failures
    .filter((f): f is Record<string, unknown> => Boolean(f && typeof f === 'object'))
    .filter((f) => {
      const status = typeof f.status === 'number' ? f.status : typeof f.errorCode === 'number' ? f.errorCode : 0;
      const isRealFailure = (typeof f.errorCode === 'number' && f.errorCode < 0 && f.errorCode !== -3) || status >= 400;
      if (!isRealFailure) return false;

      const rawUrl = typeof f.validatedURL === 'string' && f.validatedURL ? f.validatedURL : typeof f.url === 'string' ? f.url : '';
      if (!rawUrl) return false;

      if (typeof f.isFirstParty === 'boolean') {
        const origin = normalizeHostname(typeof f.origin === 'string' && f.origin ? f.origin : computeOrigin(rawUrl, contextUrl).origin);
        if (f.isFirstParty) return true;
        return isThemeAssetHost(origin, assetHosts);
      }
      const originInfo = computeOrigin(rawUrl, contextUrl);
      const origin = normalizeHostname(originInfo.origin);
      return originInfo.isFirstParty || isThemeAssetHost(origin, assetHosts);
    })
    .map((f) => {
      const rawUrl = typeof f.validatedURL === 'string' && f.validatedURL ? f.validatedURL : typeof f.url === 'string' ? f.url : '';
      const status = typeof f.status === 'number' ? f.status : typeof f.errorCode === 'number' ? f.errorCode : undefined;
      const errorText = typeof f.errorDescription === 'string' ? f.errorDescription : undefined;
      return {
        url: rawUrl,
        status,
        errorText,
      };
    })
    .filter((f) => f.url.length > 0);
}
/**
 * Confine a caller-supplied workspace root to the authoritative workspace
 * root. Traversal candidates ("../../.."), stray absolute paths, and empty
 * values fall back to `defaultRoot` (Red Team Finding 12).
 */
export function confineWorkspaceRoot(candidate: string | undefined, defaultRoot: string): string {
  // Không có root uy quyền (empty/whitespace) → không confine được, giữ
  // back-compat: trả nguyên candidate. resolve('') trả cwd — KHÔNG dùng cwd
  // làm root confinement (bridge-only mode truyền '').
  if (!defaultRoot || !String(defaultRoot).trim()) return candidate || '';
  if (!candidate || !String(candidate).trim()) return defaultRoot;

  const resolveNormalized = (value: string): string => {
    try {
      // Luôn resolve (kể cả absolute): path.resolve chuẩn hoá ".." nên
      // "C:\root\..\..\Windows" không thể qua được prefix check (traversal).
      const resolved = resolve(String(value));
      return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
    } catch {
      return '';
    }
  };

  const root = resolveNormalized(defaultRoot);

  let resolvedCandidate = '';
  try {
    resolvedCandidate = resolve(String(candidate));
  } catch {
    return defaultRoot;
  }
  const normalizedCandidate = resolveNormalized(String(candidate));
  const sep = process.platform === 'win32' ? '\\' : '/';
  const inside = normalizedCandidate === root || normalizedCandidate.startsWith(`${root}${sep}`);
  return inside ? resolvedCandidate : defaultRoot;
}
