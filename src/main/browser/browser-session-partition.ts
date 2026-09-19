import { session, Session } from 'electron';
import { setupClientHintsOverride } from './google-auth-identity';
import { armCookieDurability } from './cookie-durability';
export type BrowserSessionUserAgentMode = 'clean' | 'native';

const configuredPartitions = new Set<string>();
const userAgentModeBySession = new WeakMap<Session, BrowserSessionUserAgentMode>();
/** Partition name each configured session was created from — Electron exposes no reverse lookup. */
const partitionBySession = new WeakMap<Session, string>();

/**
 * Partition name a configured session belongs to. Returns '' for sessions this
 * process never configured (a bare `session.defaultSession` or a test double),
 * so callers can distinguish "durable profile jar" from "unknown".
 */
export function getBrowserSessionPartition(sess: Session): string {
  return sess ? partitionBySession.get(sess) ?? '' : '';
}

/**
 * True when the session cannot persist to disk: its partition is an in-memory
 * `ephemeral-*` jar, or Electron reports the session itself as non-persistent.
 * Credential writes must never target these — the write "succeeds" and then
 * vanishes with the process.
 */
export function isEphemeralSession(sess: Session): boolean {
  if (!sess) return true;
  if (getBrowserSessionPartition(sess).startsWith('ephemeral-')) return true;
  return typeof sess.isPersistent === 'function' ? !sess.isPersistent() : false;
}

/**
 * True when the session's partition is a capsule (per-workspace) jar:
 * `persist:capsule-*` in either user-agent mode. Capsule jars do persist, but
 * they are workspace-scoped — the shared profile session never reads them, so a
 * credential write there survives as a cookie the next launch's profile sync
 * cannot see. Profile-level credential operations must target
 * `persist:profile-*` only.
 */
export function isCapsuleSession(sess: Session): boolean {
  const partition = getBrowserSessionPartition(sess);
  if (!partition) return false;
  return partition.replace(/^persist:/, '').startsWith('capsule-');
}

/**
 * Deterministically derives an isolated Electron session partition name
 * from a validated capsuleId and userAgentMode.
 * Native mode partitions are suffixed with `-native` to ensure they never share
 * session cookies, state, or UA configurations with clean/standard storefront partitions.
 */
export function deriveCapsulePartition(
  capsuleId?: string,
  mode: BrowserSessionUserAgentMode = 'clean',
  ephemeral = false
): string {
  if (ephemeral) {
    const effectiveId = capsuleId && typeof capsuleId === 'string' && capsuleId.trim()
      ? capsuleId.trim()
      : 'default';
    const nonce = Math.random().toString(36).slice(2, 10);
    return mode === 'native'
      ? `ephemeral-${effectiveId}-${nonce}-native`
      : `ephemeral-${effectiveId}-${nonce}`;
  }
  const effectiveId = capsuleId && typeof capsuleId === 'string' && capsuleId.trim()
    ? capsuleId.trim()
    : 'default';
  return mode === 'native'
    ? `persist:capsule-${effectiveId}-native`
    : `persist:capsule-${effectiveId}`;
}

/**
 * Strips Electron and app branding tokens from a default user agent string,
 * leaving pure desktop Chromium tokens for Cloudflare Turnstile and storefront compatibility.
 */
export function cleanElectronUserAgent(userAgent: string): string {
  if (!userAgent || typeof userAgent !== 'string') return '';
  return userAgent
    .replace(/\s*Electron\/[^\s]+/g, '')
    .replace(/\s*AntiFan[^\s]*/g, '')
    .replace(/\s*antifan-browser[^\s]*/g, '')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

/**
 * Stores the userAgentMode for a specific Electron Session instance.
 */
export function setBrowserSessionUserAgentMode(
  sess: Session,
  mode: BrowserSessionUserAgentMode
): void {
  if (!sess) return;
  userAgentModeBySession.set(sess, mode);
}

/**
 * Retrieves the configured userAgentMode for a session instance, defaulting to 'clean'.
 */
export function getBrowserSessionUserAgentMode(
  sess: Session
): BrowserSessionUserAgentMode {
  if (!sess) return 'clean';
  return userAgentModeBySession.get(sess) ?? 'clean';
}

/**
 * Configures an Electron session partition with deterministic policies before view construction.
 * In 'native' mode, authentic Chromium UA & Client Hints are preserved with zero header tampering.
 * In 'clean' mode, cleanElectronUserAgent is applied for Cloudflare / merchant storefront compatibility.
 */
export function unconfigureBrowserSessionPartition(partition?: string): void {
  if (partition && partition.startsWith('ephemeral-')) {
    configuredPartitions.delete(partition);
  }
}

export function configureBrowserSessionPartition(
  partition: string,
  mode: BrowserSessionUserAgentMode = 'clean'
): Session {
  const sess = partition ? session.fromPartition(partition) : session.defaultSession;
  setBrowserSessionUserAgentMode(sess, mode);
  if (partition) {
    partitionBySession.set(sess, partition);
    // Durable profile jars get durable cookie commits; in-memory jars are
    // disposable by definition and the default session is Electron-managed.
    if (partition.startsWith('persist:')) {
      armCookieDurability(sess);
    }
  }

  if (partition && configuredPartitions.has(partition)) {
    return sess;
  }
  if (partition) {
    configuredPartitions.add(partition);
  }
  if (mode === 'native') {
    // In native mode, preserve 100% authentic Chromium runtime headers and UA.
    // Zero onBeforeSendHeaders interceptors are installed.
    return sess;
  }

  // In clean mode, strip Electron/App tokens and setup Chrome Client Hints + Google Auth override
  try {
    if (typeof sess.getUserAgent === 'function' && typeof sess.setUserAgent === 'function') {
      const currentUa = sess.getUserAgent();
      const cleaned = cleanElectronUserAgent(currentUa);
      if (cleaned && cleaned !== currentUa) {
        sess.setUserAgent(cleaned);
      }
      setupClientHintsOverride(sess, cleaned || currentUa);
    }
  } catch (err) {
    console.warn(`[browser-session-partition] Failed to configure UA & hints for partition ${partition}:`, err);
  }

  return sess;
}

/**
 * Resets tracked partition policies (useful for unit tests and partition deletion).
 */
export function clearBrowserSessionPartitionPolicies(partition?: string): void {
  if (partition) {
    configuredPartitions.delete(partition);
  } else {
    configuredPartitions.clear();
  }
}
