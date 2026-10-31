/**
 * Named cookie jars: a tab opened with `cookieJar: "<name>"` runs in the durable
 * partition `persist:jar-<name>`, so two accounts of the same site can stay
 * signed in at once (one in the shared profile jar, one in a named jar).
 *
 * Electron-free on purpose: the name rule, the partition derivation and the
 * argument check are shared by the capability boundary, the control port, the
 * tab host and the credential-target guards, and are unit-testable without a
 * running app.
 *
 * The `persist:jar-` prefix is the whole isolation guarantee: no name can
 * resolve to `persist:profile-*`, `persist:capsule-*` or an `ephemeral-*`
 * partition, so profile-level credential operations (Chrome profile sync,
 * Session Vault, extension hydration) never see a jar.
 */
import { CapabilityError } from '../../shared/control-plane-contracts';

export type CookieJarUserAgentMode = 'clean' | 'native';

/** Lowercase letters, digits and hyphens; 2-40 characters; starts with a letter or digit. */
export const COOKIE_JAR_NAME_PATTERN = /^[a-z0-9][a-z0-9-]{1,39}$/;

/** Every jar partition starts with this; nothing else in the app derives a name under it. */
export const COOKIE_JAR_PARTITION_PREFIX = 'persist:jar-';

/** Suffix a native-UA jar partition carries (same convention as profile and capsule partitions). */
const NATIVE_SUFFIX = '-native';

/**
 * True for a name a caller may pass. A name ending in `-native` is refused so that
 * `persist:jar-<name>-native` can only ever mean "<name> in native mode", never a
 * second jar that happens to be called "<name>-native".
 */
export function isValidCookieJarName(value: unknown): value is string {
  return typeof value === 'string' && COOKIE_JAR_NAME_PATTERN.test(value) && !value.endsWith(NATIVE_SUFFIX);
}

/** The partition a jar's tabs run in. Throws on an invalid name: a bad name must never derive a partition. */
export function deriveCookieJarPartition(name: string, mode: CookieJarUserAgentMode = 'clean'): string {
  if (!isValidCookieJarName(name)) {
    throw new CapabilityError('INVALID_ARGUMENT', cookieJarNameMessage(name), { cookieJar: name });
  }
  return mode === 'native'
    ? `${COOKIE_JAR_PARTITION_PREFIX}${name}${NATIVE_SUFFIX}`
    : `${COOKIE_JAR_PARTITION_PREFIX}${name}`;
}

/** True when `partition` is a jar partition of either user-agent mode. */
export function isCookieJarPartition(partition: unknown): boolean {
  return typeof partition === 'string' && partition.startsWith(COOKIE_JAR_PARTITION_PREFIX);
}

/**
 * The jar name a partition backs, or undefined when the partition is not a jar of a
 * valid name. `mode` decides whether a trailing `-native` is the mode suffix or part of
 * the name (a name never ends in it, so a clean partition ending in it is not a jar).
 */
export function cookieJarNameOfPartition(partition: unknown, mode: CookieJarUserAgentMode = 'clean'): string | undefined {
  if (!isCookieJarPartition(partition)) return undefined;
  let name = (partition as string).slice(COOKIE_JAR_PARTITION_PREFIX.length);
  if (mode === 'native') {
    if (!name.endsWith(NATIVE_SUFFIX)) return undefined;
    name = name.slice(0, -NATIVE_SUFFIX.length);
  }
  return isValidCookieJarName(name) ? name : undefined;
}

function cookieJarNameMessage(value: unknown): string {
  const shown = typeof value === 'string' ? JSON.stringify(value) : typeof value;
  return `cookieJar ${shown} is not a valid jar name: use 2-40 lowercase letters, digits or hyphens, starting with a letter or digit, not ending in "-native" (for example "tiktok-taphoa").`;
}

/**
 * Validates the `cookieJar` argument of a tab-open call. Returns the name, or undefined
 * when the argument is absent (`undefined` or `null`). Refuses a non-string, a name that
 * breaks the rule, and the combination with `ephemeral: true` (an in-memory tab has no
 * durable jar to join).
 */
export function parseCookieJarParam(cookieJar: unknown, ephemeral?: unknown): string | undefined {
  if (cookieJar === undefined || cookieJar === null) return undefined;
  if (!isValidCookieJarName(cookieJar)) {
    throw new CapabilityError('INVALID_ARGUMENT', cookieJarNameMessage(cookieJar), { cookieJar });
  }
  if (ephemeral === true) {
    throw new CapabilityError(
      'INVALID_ARGUMENT',
      'cookieJar cannot be combined with ephemeral: true: an ephemeral tab lives in memory and has no durable jar to join.',
      { cookieJar, ephemeral: true }
    );
  }
  return cookieJar;
}
