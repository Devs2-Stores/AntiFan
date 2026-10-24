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
