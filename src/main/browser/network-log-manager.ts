/**
 * Per-tab network request log.
 *
 * Fed from the CDP `Network.*` events the first-party tracker already listens to, and kept apart
 * from the console/failure diagnostics store: that store is cleared on every navigation, while a
 * request made by the page before it navigated away is exactly what an agent debugging a
 * redirect, a failed XHR or a missing asset needs to see afterwards.
 *
 * What is stored is deliberately small and safe by default: request and response headers are cut
 * down to an allowlist (never `authorization`, `cookie`, `set-cookie`), request and response
 * bodies are never captured, and query parameters that look like credentials are redacted from
 * every URL before it is kept.
 */

import { CapabilityError } from '../../shared/control-plane-contracts';

/** Entries kept per tab and pane; the oldest entry is dropped first. */
export const NETWORK_LOG_CAPACITY = 500;
export const NETWORK_LOG_DEFAULT_LIMIT = 100;
export const NETWORK_LOG_MAX_LIMIT = 500;

/** The only headers that ever leave this module, lower-case. */
export const NETWORK_LOG_HEADER_ALLOWLIST: readonly string[] = Object.freeze(['content-type', 'content-length', 'cache-control', 'status']);

const URL_MAX_CHARS = 2048;
const SENSITIVE_QUERY_PARAM = new RegExp(
  [
    'token', 'secret', 'passw', 'auth', 'session', 'sid$', 'signature', 'hmac', 'nonce', 'credential', 'jwt', 'bearer', 'cookie',
    'api[-_]?key', '(^|[-_.])key$', '(^|[-_.])sig($|[-_.])', '(^|[-_.])otp($|[-_.])', '^state$', '^code$',
    '(verification|reset|confirm|activation|invite|promo|discount|coupon)[-_]?code',
  ].join('|'),
  'i'
);
/** A path segment that names a resource whose next segment is a capability, as in /checkouts/cn/<token>. */
const SENSITIVE_PATH_PARENT = /^(checkouts?|orders?|carts?|tokens?|reset|activate|invite|unsubscribe|receipts?|invoices?|downloads?)$/i;
const OPAQUE_SEGMENT = /^[A-Za-z0-9_-]{16,}$/;
const LONG_HEX_SEGMENT = /^[A-Fa-f0-9]{32,}$/;
/** A `/pattern/flags` urlPattern is a regular expression only with at least one of these flags. */
const URL_REGEX_FLAGS = /^[imsu]+$/;
const URL_REGEX_MAX_CHARS = 200;
const URL_REGEX_MAX_UNBOUNDED_REPEATS = 3;
const REDACTED_VALUE = 'REDACTED';

export interface NetworkLogEntry {
  /** Monotonic across every tab of this manager; `sinceSeq` pages on it. */
  seq: number;
  requestId: string;
  method: string;
  url: string;
  /** Lower-case CDP resource type: `document`, `xhr`, `fetch`, `script`, `stylesheet`, `image`, ... */
  resourceType: string;
  /** URL of the document that issued the request. */
  documentUrl?: string;
  /** Epoch ms the request was issued. */
  startedAt: number;
  status?: number;
  statusText?: string;
  mimeType?: string;
  fromCache?: boolean;
  encodedDataLength?: number;
  durationMs?: number;
  failed?: boolean;
  errorText?: string;
  canceled?: boolean;
  blockedReason?: string;
  /** `seq` of the request this one replaced through a redirect. */
  redirectedFrom?: number;
  requestHeaders?: Record<string, string>;
  responseHeaders?: Record<string, string>;
  /** The debugger session was lost before this request finished; its outcome was never recorded. */
  interrupted?: boolean;
}

export interface NetworkLogFilters {
  /**
   * A case-insensitive URL substring, or a regular expression written `/pattern/flags` with at
   * least one flag from `i`, `m`, `s`, `u` (for example `/\.(png|js)$/i`). Text that does not have
   * that shape, `/api/v1/` or `/cart/add` for instance, is a plain substring. A regular
   * expression is capped at 200 characters and refused when it repeats a group that itself
   * repeats or alternates, uses a backreference, or has more than three unbounded repeats.
   */
  urlPattern?: string;
  method?: string;
  /** An exact status, `failed`, `error` (failed or >= 400), or a class such as `4xx`. */
  status?: number | string;
  resourceType?: string;
  sinceSeq?: number;
  limit?: number;
  /** Default true: allowlisted headers. False drops every header. */
  includeHeaders?: boolean;
  /** Bodies are never captured; true is refused rather than silently ignored. */
  includeBodies?: boolean;
}

export interface NetworkLogResult {
  entries: NetworkLogEntry[];
  totalMatched: number;
  returned: number;
  highestSeq: number;
  evictedCount: number;
  bufferCapacity: number;
  /** Epoch ms the log for this tab started; requests made before it are not in the log. */
  attachedAt?: number;
  /** `seq` to pass as `sinceSeq` to continue after the last entry returned; unchanged cursor when nothing matched. */
  nextSeq: number;
  /** With `sinceSeq`: more matching entries remain after this page. Entries are then returned oldest first so a cursor never skips one. */
  hasMore?: boolean;
  /** True while the debugger session that records this log is gone: nothing is recorded until it is re-attached. */
  detached?: boolean;
  detachReason?: string;
  /** Periods the log did not record because the debugger session was lost; requests made during them are absent. */
  recordingGaps?: { count: number; lastStartedAt: number; lastEndedAt?: number; lastReason: string };
}

interface TabNetworkLog {
  entries: NetworkLogEntry[];
  byRequestId: Map<string, NetworkLogEntry>;
  evicted: number;
  attachedAt: number;
  gaps: number;
  lastGap?: { startedAt: number; endedAt?: number; reason: string };
}

type CdpParams = Record<string, unknown> | undefined;

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function asFiniteNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

/** Redacts a URL path: the capability segment of /checkouts/<token>-style routes, and any 32+ character hex segment. */
function redactPathSegments(pathname: string): string {
  const parts = pathname.split('/');
  return parts
    .map((segment, index) => {
      if (!segment) return segment;
      if (LONG_HEX_SEGMENT.test(segment)) return REDACTED_VALUE;
      const afterSensitive = SENSITIVE_PATH_PARENT.test(parts[index - 1] ?? '') || SENSITIVE_PATH_PARENT.test(parts[index - 2] ?? '');
      return afterSensitive && OPAQUE_SEGMENT.test(segment) && /\d/.test(segment) && /[A-Za-z]/.test(segment) ? REDACTED_VALUE : segment;
    })
    .join('/');
}

/**
 * Drops credentials from a URL: userinfo, the value of every query parameter whose name looks
 * like a secret, and opaque capability segments in the path (`/checkouts/cn/<token>`). A `data:`
 * URL keeps only its media type, since the payload can be arbitrarily large and is the page's own
 * content; a `blob:` URL keeps the redacted URL it wraps; a `javascript:` URL keeps no code.
 */
export function redactNetworkUrl(raw: string): string {
  if (raw.startsWith('data:')) {
    const comma = raw.indexOf(',');
    return `${raw.slice(0, comma === -1 ? Math.min(raw.length, 64) : Math.min(comma, 64))},...`;
  }
  if (/^javascript:/i.test(raw)) return 'javascript:...';
  const clip = (text: string) => (text.length > URL_MAX_CHARS ? `${text.slice(0, URL_MAX_CHARS)}...` : text);
  const redactQuery = (query: string): string =>
    query
      .split('&')
      .map((pair) => {
        const eq = pair.indexOf('=');
        if (eq === -1) return pair;
        let name = pair.slice(0, eq);
        try {
          name = decodeURIComponent(name);
        } catch {
          // An undecodable name is tested as written.
        }
        return SENSITIVE_QUERY_PARAM.test(name) ? `${pair.slice(0, eq)}=${REDACTED_VALUE}` : pair;
      })
      .join('&');
  try {
    const parsed = new URL(raw);
    if (parsed.protocol === 'blob:') return clip(`blob:${redactNetworkUrl(parsed.pathname)}`);
    parsed.username = '';
    parsed.password = '';
    const hashless = parsed.hash;
    parsed.hash = '';
    const search = parsed.search ? `?${redactQuery(parsed.search.slice(1))}` : '';
    const hasAuthority = parsed.host !== '' || raw.slice(parsed.protocol.length, parsed.protocol.length + 2) === '//';
    const origin = parsed.origin === 'null' ? (hasAuthority ? `${parsed.protocol}//${parsed.host}` : parsed.protocol) : parsed.origin;
    return clip(`${origin}${redactPathSegments(parsed.pathname)}${search}${hashless ? '#' : ''}`);
  } catch {
    const queryAt = raw.indexOf('?');
    return clip(queryAt === -1 ? raw : `${raw.slice(0, queryAt + 1)}${redactQuery(raw.slice(queryAt + 1))}`);
  }
}

/** Keeps only allowlisted headers, keyed in lower case. A value that is not a string is dropped. */
export function redactNetworkHeaders(headers: unknown): Record<string, string> | undefined {
  const source = asRecord(headers);
  if (!source) return undefined;
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(source)) {
    const key = name.toLowerCase();
    if (!NETWORK_LOG_HEADER_ALLOWLIST.includes(key)) continue;
    if (typeof value === 'string') out[key] = value.length > 256 ? `${value.slice(0, 256)}...` : value;
    else if (typeof value === 'number') out[key] = String(value);
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/**
 * Why a regular expression could backtrack catastrophically against an attacker-chosen URL, or
 * `undefined` when none of the known shapes is present. The match runs synchronously in the main
 * process, so the check is deliberately conservative: a group that contains a repeat or an
 * alternation may not itself be repeated, backreferences are refused, and unbounded repeats are
 * limited.
 */
function unsafeRegexReason(source: string): string | undefined {
  interface Group { quantified: boolean; alternates: boolean }
  const stack: Group[] = [];
  let unbounded = 0;
  let closedGroup: Group | undefined;
  for (let i = 0; i < source.length; i++) {
    const ch = source[i]!;
    const justClosed = closedGroup;
    closedGroup = undefined;
    if (ch === '\\') {
      if (/[1-9k]/.test(source[i + 1] ?? '')) return 'backreferences are not allowed';
      i++;
      continue;
    }
    if (ch === '[') {
      i++;
      while (i < source.length && source[i] !== ']') {
        if (source[i] === '\\') i++;
        i++;
      }
      continue;
    }
    if (ch === '(') {
      stack.push({ quantified: false, alternates: false });
      continue;
    }
    if (ch === ')') {
      const group = stack.pop();
      if (group) {
        const parent = stack[stack.length - 1];
        if (parent) {
          parent.quantified ||= group.quantified;
          parent.alternates ||= group.alternates;
        }
        closedGroup = group;
      }
      continue;
    }
    if (ch === '|') {
      const group = stack[stack.length - 1];
      if (group) group.alternates = true;
      continue;
    }
    const braces = ch === '{' ? /^\{\d+(,\d*)?\}/.exec(source.slice(i)) : null;
    const repeats = ch === '*' || ch === '+' || braces !== null;
    if (repeats || ch === '?') {
      const enclosing = stack[stack.length - 1];
      if (enclosing) enclosing.quantified = true;
    }
    if (repeats) {
      if (justClosed && (justClosed.quantified || justClosed.alternates)) {
        return 'a repeated group may not itself repeat or alternate';
      }
      if (ch !== '{' || /,\}$/.test(braces![0])) {
        unbounded++;
        if (unbounded > URL_REGEX_MAX_UNBOUNDED_REPEATS) return `more than ${URL_REGEX_MAX_UNBOUNDED_REPEATS} unbounded repeats`;
      }
      if (braces) i += braces[0].length - 1;
    }
  }
  return undefined;
}

function compileUrlPattern(pattern: string): (url: string) => boolean {
  const regexForm = /^\/(.+)\/([a-z]+)$/.exec(pattern);
  if (regexForm && URL_REGEX_FLAGS.test(regexForm[2] ?? '')) {
    const source = regexForm[1] ?? '';
    if (source.length > URL_REGEX_MAX_CHARS) {
      throw new CapabilityError('INVALID_ARGUMENT', `urlPattern regular expression is longer than ${URL_REGEX_MAX_CHARS} characters`, { urlPattern: pattern });
    }
    const unsafe = unsafeRegexReason(source);
    if (unsafe) {
      throw new CapabilityError('INVALID_ARGUMENT', `urlPattern regular expression refused: ${unsafe}`, { urlPattern: pattern });
    }
    let regex: RegExp;
    try {
      regex = new RegExp(source, regexForm[2] ?? '');
    } catch (err) {
      throw new CapabilityError('INVALID_ARGUMENT', `urlPattern is not a valid regular expression: ${err instanceof Error ? err.message : String(err)}`, { urlPattern: pattern });
    }
    return (url) => regex.test(url);
  }
  const needle = pattern.toLowerCase();
  return (url) => url.toLowerCase().includes(needle);
}

function compileStatusFilter(status: number | string): (entry: NetworkLogEntry) => boolean {
  if (typeof status === 'number') {
    if (!Number.isInteger(status) || status < 100 || status > 599) {
      throw new CapabilityError('INVALID_ARGUMENT', `status must be an HTTP status 100-599, 'failed', 'error' or a class such as '4xx', got ${status}`, { status });
    }
    return (entry) => entry.status === status;
  }
  const normalized = String(status).trim().toLowerCase();
  if (normalized === 'failed') return (entry) => entry.failed === true;
  if (normalized === 'error') return (entry) => entry.failed === true || (entry.status ?? 0) >= 400;
  const statusClass = /^([1-5])xx$/.exec(normalized);
  if (statusClass) {
    const digit = Number(statusClass[1]);
    return (entry) => typeof entry.status === 'number' && Math.floor(entry.status / 100) === digit;
  }
  throw new CapabilityError('INVALID_ARGUMENT', `status must be an HTTP status 100-599, 'failed', 'error' or a class such as '4xx', got ${JSON.stringify(status)}`, { status });
}

export class NetworkLogManager {
  private readonly logs = new Map<string, TabNetworkLog>();
  private readonly startedAtMonotonic = new WeakMap<NetworkLogEntry, number>();
  private seq = 0;

  constructor(
    private readonly capacity: number = NETWORK_LOG_CAPACITY,
    private readonly now: () => number = Date.now
  ) {}

  private keyOf(tabId: string, paneId: string): string {
    return `${tabId}:${paneId}`;
  }

  private logFor(tabId: string, paneId: string): TabNetworkLog {
    const key = this.keyOf(tabId, paneId);
    let log = this.logs.get(key);
    if (!log) {
      log = { entries: [], byRequestId: new Map(), evicted: 0, attachedAt: this.now(), gaps: 0 };
      this.logs.set(key, log);
    }
    return log;
  }

  /** Marks a tab's log as started without recording anything, so `attachedAt` is honest for a quiet tab. */
  public ensureTab(tabId: string, paneId: string = 'desktop'): void {
    this.logFor(tabId, paneId);
  }

  /**
   * The debugger session that feeds this log is gone. Requests still in flight will never finish,
   * so they are marked interrupted, and the log reports `detached` until `markAttached`.
   */
  public markDetached(tabId: string, paneId: string, reason: string): void {
    const log = this.logFor(tabId, paneId);
    if (log.lastGap && log.lastGap.endedAt === undefined) return;
    for (const entry of log.byRequestId.values()) entry.interrupted = true;
    log.byRequestId.clear();
    log.gaps++;
    log.lastGap = { startedAt: this.now(), reason };
  }

  /** Recording resumed; closes the open gap so the result stops reporting `detached`. */
  public markAttached(tabId: string, paneId: string): void {
    const gap = this.logs.get(this.keyOf(tabId, paneId))?.lastGap;
    if (gap && gap.endedAt === undefined) gap.endedAt = this.now();
  }

  /** Entry point for the CDP message listener; unknown methods are ignored. */
  public onCdpEvent(tabId: string, paneId: string, method: string, params: CdpParams): void {
    if (!params) return;
    switch (method) {
      case 'Network.requestWillBeSent':
        this.recordRequest(tabId, paneId, params);
        break;
      case 'Network.responseReceived': {
        const entry = this.entryFor(tabId, paneId, params);
        const response = asRecord(params.response);
        if (entry && response) this.applyResponse(entry, response);
        break;
      }
      case 'Network.requestServedFromCache': {
        const entry = this.entryFor(tabId, paneId, params);
        if (entry) entry.fromCache = true;
        break;
      }
      case 'Network.loadingFinished': {
        const entry = this.entryFor(tabId, paneId, params);
        if (!entry) break;
        this.applyTiming(entry, asFiniteNumber(params.timestamp));
        const length = asFiniteNumber(params.encodedDataLength);
        if (length !== undefined) entry.encodedDataLength = length;
        this.logFor(tabId, paneId).byRequestId.delete(entry.requestId);
        break;
      }
      case 'Network.loadingFailed': {
        const entry = this.entryFor(tabId, paneId, params);
        if (!entry) break;
        entry.failed = true;
        const errorText = asString(params.errorText);
        if (errorText) entry.errorText = errorText;
        if (params.canceled === true) entry.canceled = true;
        const blocked = asString(params.blockedReason);
        if (blocked) entry.blockedReason = blocked;
        this.applyTiming(entry, asFiniteNumber(params.timestamp));
        this.logFor(tabId, paneId).byRequestId.delete(entry.requestId);
        break;
      }
      default:
        break;
    }
  }

  /** Forget a tab's log when its target goes away; a closed tab can no longer be queried. */
  public onTargetDetached(tabId: string, paneId: string = 'desktop'): void {
    this.logs.delete(this.keyOf(tabId, paneId));
  }

  public clear(tabId: string, paneId: string = 'desktop'): void {
    this.logs.delete(this.keyOf(tabId, paneId));
  }

  public getStats(): { tabCount: number; entryCount: number } {
    let entryCount = 0;
    for (const log of this.logs.values()) entryCount += log.entries.length;
    return { tabCount: this.logs.size, entryCount };
  }

  public query(tabId: string, paneId: string = 'desktop', filters: NetworkLogFilters = {}): NetworkLogResult {
    if (filters.includeBodies === true) {
      throw new CapabilityError('INVALID_ARGUMENT', 'includeBodies is not supported: request and response bodies are never captured', { includeBodies: true });
    }
    const limit = filters.limit === undefined ? NETWORK_LOG_DEFAULT_LIMIT : filters.limit;
    if (typeof limit !== 'number' || !Number.isInteger(limit) || limit < 1 || limit > NETWORK_LOG_MAX_LIMIT) {
      throw new CapabilityError('INVALID_ARGUMENT', `limit must be an integer 1-${NETWORK_LOG_MAX_LIMIT}, got ${JSON.stringify(filters.limit)}`, { limit: filters.limit });
    }
    if (filters.sinceSeq !== undefined && (typeof filters.sinceSeq !== 'number' || !Number.isInteger(filters.sinceSeq) || filters.sinceSeq < 0)) {
      throw new CapabilityError('INVALID_ARGUMENT', `sinceSeq must be a non-negative integer, got ${JSON.stringify(filters.sinceSeq)}`, { sinceSeq: filters.sinceSeq });
    }
    if (filters.urlPattern !== undefined && (typeof filters.urlPattern !== 'string' || !filters.urlPattern.trim() || filters.urlPattern.length > 500)) {
      throw new CapabilityError('INVALID_ARGUMENT', 'urlPattern must be a non-empty string of at most 500 characters', { urlPattern: filters.urlPattern });
    }
    const matchesUrl = filters.urlPattern !== undefined ? compileUrlPattern(filters.urlPattern.trim()) : undefined;
    const matchesStatus = filters.status !== undefined ? compileStatusFilter(filters.status) : undefined;
    const method = typeof filters.method === 'string' && filters.method.trim() ? filters.method.trim().toUpperCase() : undefined;
    const resourceType = typeof filters.resourceType === 'string' && filters.resourceType.trim() ? filters.resourceType.trim().toLowerCase() : undefined;
    const sinceSeq = filters.sinceSeq ?? 0;
    const includeHeaders = filters.includeHeaders !== false;

    const log = this.logs.get(this.keyOf(tabId, paneId));
    const matched = (log?.entries ?? []).filter((entry) => {
      if (entry.seq <= sinceSeq) return false;
      if (method && entry.method !== method) return false;
      if (resourceType && entry.resourceType !== resourceType) return false;
      if (matchesUrl && !matchesUrl(entry.url)) return false;
      if (matchesStatus && !matchesStatus(entry)) return false;
      return true;
    });
    // With a cursor the page is the oldest matches after it, so a poller that advances to nextSeq
    // never skips an entry; without one the page is the newest matches.
    const paging = filters.sinceSeq !== undefined;
    const page = (paging ? matched.slice(0, limit) : matched.slice(-limit)).map((entry) => {
      const copy: NetworkLogEntry = { ...entry };
      if (!includeHeaders) {
        delete copy.requestHeaders;
        delete copy.responseHeaders;
      } else {
        if (copy.requestHeaders) copy.requestHeaders = { ...copy.requestHeaders };
        if (copy.responseHeaders) copy.responseHeaders = { ...copy.responseHeaders };
      }
      return copy;
    });
    const entries = log?.entries ?? [];
    const openGap = log?.lastGap && log.lastGap.endedAt === undefined ? log.lastGap : undefined;
    return {
      entries: page,
      totalMatched: matched.length,
      returned: page.length,
      highestSeq: entries[entries.length - 1]?.seq ?? 0,
      nextSeq: page[page.length - 1]?.seq ?? sinceSeq,
      ...(paging ? { hasMore: matched.length > page.length } : {}),
      evictedCount: log?.evicted ?? 0,
      bufferCapacity: this.capacity,
      ...(log ? { attachedAt: log.attachedAt } : {}),
      ...(openGap ? { detached: true, detachReason: openGap.reason } : {}),
      ...(log && log.gaps > 0 && log.lastGap
        ? {
            recordingGaps: {
              count: log.gaps,
              lastStartedAt: log.lastGap.startedAt,
              ...(log.lastGap.endedAt !== undefined ? { lastEndedAt: log.lastGap.endedAt } : {}),
              lastReason: log.lastGap.reason,
            },
          }
        : {}),
    };
  }

  private entryFor(tabId: string, paneId: string, params: Record<string, unknown>): NetworkLogEntry | undefined {
    const requestId = asString(params.requestId);
    if (!requestId) return undefined;
    return this.logs.get(this.keyOf(tabId, paneId))?.byRequestId.get(requestId);
  }

  private recordRequest(tabId: string, paneId: string, params: Record<string, unknown>): void {
    const requestId = asString(params.requestId);
    const request = asRecord(params.request);
    const url = asString(request?.url);
    if (!requestId || !request || url === undefined) return;
    const log = this.logFor(tabId, paneId);
    let redirectedFrom: number | undefined;
    const redirectResponse = asRecord(params.redirectResponse);
    if (redirectResponse) {
      const previous = log.byRequestId.get(requestId);
      if (previous) {
        this.applyResponse(previous, redirectResponse);
        this.applyTiming(previous, asFiniteNumber(params.timestamp));
        log.byRequestId.delete(requestId);
        redirectedFrom = previous.seq;
      }
    }
    const wallTime = asFiniteNumber(params.wallTime);
    const documentUrl = asString(params.documentURL);
    const requestHeaders = redactNetworkHeaders(request.headers);
    const entry: NetworkLogEntry = {
      seq: ++this.seq,
      requestId,
      method: (asString(request.method) ?? 'GET').toUpperCase(),
      url: redactNetworkUrl(url),
      resourceType: (asString(params.type) ?? 'other').toLowerCase(),
      ...(documentUrl ? { documentUrl: redactNetworkUrl(documentUrl) } : {}),
      startedAt: wallTime !== undefined ? Math.round(wallTime * 1000) : this.now(),
      ...(redirectedFrom !== undefined ? { redirectedFrom } : {}),
      ...(requestHeaders ? { requestHeaders } : {}),
    };
    const startedAt = asFiniteNumber(params.timestamp);
    if (startedAt !== undefined) this.startedAtMonotonic.set(entry, startedAt);
    log.entries.push(entry);
    log.byRequestId.set(requestId, entry);
    while (log.entries.length > this.capacity) {
      const dropped = log.entries.shift();
      log.evicted++;
      if (dropped && log.byRequestId.get(dropped.requestId) === dropped) log.byRequestId.delete(dropped.requestId);
    }
  }

  private applyResponse(entry: NetworkLogEntry, response: Record<string, unknown>): void {
    const status = asFiniteNumber(response.status);
    if (status !== undefined) entry.status = status;
    const statusText = asString(response.statusText);
    if (statusText) entry.statusText = statusText;
    const mimeType = asString(response.mimeType);
    if (mimeType) entry.mimeType = mimeType;
    if (response.fromDiskCache === true || response.fromServiceWorker === true || response.fromPrefetchCache === true) entry.fromCache = true;
    const headers = redactNetworkHeaders(response.headers);
    if (headers) entry.responseHeaders = headers;
  }

  private applyTiming(entry: NetworkLogEntry, finishedAt: number | undefined): void {
    const startedAt = this.startedAtMonotonic.get(entry);
    if (startedAt === undefined || finishedAt === undefined || finishedAt < startedAt) return;
    entry.durationMs = Math.round((finishedAt - startedAt) * 1000);
  }
}
