import { CapabilityError } from '../../shared/control-plane-contracts';

/**
 * A page the site serves INSTEAD of the requested document once it has decided the
 * visitor is automated (a traffic-verification or captcha interstitial). Reaching one
 * is a terminal condition for the run: more navigation, retries or rebinding only feeds
 * the detector, so it is reported as its own code rather than as a stale target.
 */
export interface AntiBotChallenge {
  host: string;
  /** Pathname only; the query string and fragment are never kept (they carry tokens and the return URL). */
  path: string;
  marker: 'verify-traffic' | 'verify-captcha' | 'anti-bot-marker';
}

const VERIFY_TRAFFIC_PATH = /^\/verify\/traffic(?:\/|$)/i;
const VERIFY_CAPTCHA_PATH = /^\/verify\/captcha(?:\/|$)/i;
const ANTI_BOT_NAME = /anti[_-]?bot/i;

export const ANTI_BOT_CHALLENGE_RECOVERY =
  'Stop automated access to this site for this run: do not retry, reload or open more tabs. Ask the user to clear the verification in the AntiFan window (or wait before trying again), then resume from a fresh navigation.';

/**
 * Classifies a document URL as an anti-bot interstitial, or returns undefined for any
 * ordinary page. Matching is on the path (`/verify/traffic`, `/verify/captcha`) and on an
 * `anti_bot` / `anti-bot` marker in a path segment or a query parameter NAME; query values
 * are never inspected so a product slug can not trip the detector.
 */
export function classifyAntiBotUrl(url: string | undefined | null): AntiBotChallenge | undefined {
  if (typeof url !== 'string' || !url.trim()) return undefined;
  let parsed: URL;
  try {
    parsed = new URL(url.trim());
  } catch {
    return undefined;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return undefined;
  const pathname = parsed.pathname || '/';
  if (VERIFY_TRAFFIC_PATH.test(pathname)) return { host: parsed.host, path: pathname, marker: 'verify-traffic' };
  if (VERIFY_CAPTCHA_PATH.test(pathname)) return { host: parsed.host, path: pathname, marker: 'verify-captcha' };
  if (ANTI_BOT_NAME.test(pathname)) return { host: parsed.host, path: pathname, marker: 'anti-bot-marker' };
  for (const name of parsed.searchParams.keys()) {
    if (ANTI_BOT_NAME.test(name)) return { host: parsed.host, path: pathname, marker: 'anti-bot-marker' };
  }
  return undefined;
}

/** The refusal for a detected challenge. Carries host and path only, never the query. */
export function antiBotChallengeError(challenge: AntiBotChallenge, extra?: Record<string, unknown>): CapabilityError {
  return new CapabilityError(
    'ANTI_BOT_CHALLENGE',
    `${challenge.host} answered with an anti-bot verification page (${challenge.host}${challenge.path}) instead of the requested document. ${ANTI_BOT_CHALLENGE_RECOVERY}`,
    {
      host: challenge.host,
      path: challenge.path,
      marker: challenge.marker,
      recovery: ANTI_BOT_CHALLENGE_RECOVERY,
      retryable: false,
      ...(extra ?? {}),
    }
  );
}

/** Throws ANTI_BOT_CHALLENGE when `url` is a challenge page; otherwise returns. */
export function assertNotAntiBotChallenge(url: string | undefined | null, extra?: Record<string, unknown>): void {
  const challenge = classifyAntiBotUrl(url);
  if (challenge) throw antiBotChallengeError(challenge, extra);
}

/** How long a latched challenge keeps refusing navigation to its host when nothing proves it was cleared. */
export const ANTI_BOT_LATCH_TTL_MS = 10 * 60_000;

/** Partition name of a tab that runs without an explicit session partition. */
export const DEFAULT_ANTI_BOT_PARTITION = 'default';

interface LatchEntry {
  challenge: AntiBotChallenge;
  /** Tabs that were sitting on the challenge page; one of them leaving it for an ordinary page on the host clears the latch. */
  tabIds: Set<string>;
  expiresAt: number;
}

export interface AntiBotLatchHit {
  challenge: AntiBotChallenge;
  retryAfterMs: number;
  tabIds: string[];
}

function hostOf(url: string | undefined | null): string | undefined {
  if (typeof url !== 'string' || !url.trim()) return undefined;
  try {
    const parsed = new URL(url.trim());
    return parsed.protocol === 'http:' || parsed.protocol === 'https:' ? parsed.host : undefined;
  } catch {
    return undefined;
  }
}

/** True when `url` is an ordinary (non-challenge) http(s) page on `host`. */
export function isOrdinaryPageOnHost(url: string | undefined | null, host: string): boolean {
  return hostOf(url)?.toLowerCase() === host.toLowerCase() && !classifyAntiBotUrl(url);
}

/**
 * A site that answered with a verification page has decided the visitor is automated: another
 * navigation to that host from the same browser identity (session partition) only feeds the
 * detector. The latch remembers the refusal per `(partition, host)` so the next navigate or
 * tab open fails fast without touching the network; another partition is a different visitor
 * and is unaffected. In memory only: it ends with the app, after {@link ANTI_BOT_LATCH_TTL_MS},
 * or as soon as the caller finds the host loaded normally again (the user solved it by hand).
 */
export class AntiBotLatch {
  private readonly entries = new Map<string, LatchEntry>();

  constructor(private readonly now: () => number = Date.now, private readonly ttlMs: number = ANTI_BOT_LATCH_TTL_MS) {}

  private static key(partition: string, host: string): string {
    return `${partition || DEFAULT_ANTI_BOT_PARTITION}\u0000${host.toLowerCase()}`;
  }

  /** Records that `tabId` (in `partition`) was served `challenge`. */
  set(partition: string, challenge: AntiBotChallenge, tabId?: string): void {
    const key = AntiBotLatch.key(partition, challenge.host);
    const expiresAt = this.now() + this.ttlMs;
    const entry = this.entries.get(key);
    if (entry) {
      entry.challenge = challenge;
      entry.expiresAt = expiresAt;
      if (tabId) entry.tabIds.add(tabId);
      return;
    }
    this.entries.set(key, { challenge, tabIds: new Set(tabId ? [tabId] : []), expiresAt });
  }

  /** The live latch for `url`'s host in `partition`, or undefined (an expired entry is dropped). */
  check(partition: string, url: string | undefined | null): AntiBotLatchHit | undefined {
    const host = hostOf(url);
    if (!host) return undefined;
    const key = AntiBotLatch.key(partition, host);
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    const remaining = entry.expiresAt - this.now();
    if (remaining <= 0) {
      this.entries.delete(key);
      return undefined;
    }
    return { challenge: entry.challenge, retryAfterMs: remaining, tabIds: [...entry.tabIds] };
  }

  /** Drops the latch for `url`'s host in `partition`; true when one was held. */
  clear(partition: string, url: string | undefined | null): boolean {
    const host = hostOf(url);
    return host ? this.entries.delete(AntiBotLatch.key(partition, host)) : false;
  }
}
