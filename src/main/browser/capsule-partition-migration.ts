/**
 * Pure, dependency-injected cookie migration from legacy `persist:capsule-*`
 * partitions to unified `persist:profile-*` partitions.
 *
 * Electron-free on purpose: the loop, failure accounting and marker gate live
 * here so they are unit-testable under plain `node --test`. The Electron
 * wrapper in NativeTabHost supplies real partition/session access through the
 * `CapsuleMigrationDeps` interface and owns the marker file path.
 *
 * Guarantees:
 *  - Cookie data is COPIED; legacy partitions are never removed here.
 *  - The done marker is only written (`markerReady: true`) when EVERY legacy
 *    partition was listed, read, copied and flushed without error — any
 *    failure leaves the marker unset so the next launch retries safely.
 *  - Cookie mapping (domain normalization, url derivation, sameSite passthrough)
 *    mirrors the original Electron implementation exactly.
 */

export interface CapsuleMigrationCookie {
  domain?: string;
  path?: string;
  secure: boolean;
  httpOnly: boolean;
  name: string;
  value: string;
  expirationDate?: number;
  sameSite?: 'unspecified' | 'no_restriction' | 'lax' | 'strict';
}

export interface CapsuleMigrationDeps {
  /**
   * Returns legacy partition keys found on disk (e.g. `['capsule-a']`).
   * THROW to signal the enumeration itself failed — the migration then
   * MUST NOT mark itself done, because keys may have been missed.
   */
  listLegacyPartitionKeys(): string[];
  /** Reads all cookies in a partition. THROW on read failure. */
  readCookies(partition: string): Promise<CapsuleMigrationCookie[]>;
  /** Writes one cookie into the target partition. THROW on write failure. */
  writeCookie(targetPartition: string, cookie: CapsuleMigrationCookie): Promise<void>;
  /** Flushes the target partition's cookie store after a batch. THROW on failure. */
  flushStore(partition: string): Promise<void>;
}

export interface CapsuleMigrationResult {
  migrated: number;
  legacyPartitions: string[];
  /** True only when no list/read/write/flush failure occurred. */
  markerReady: boolean;
}

/**
 * Derives the `cookies.set` details for a cookie being copied to a target
 * partition. Kept pure (and used by the Electron wrapper) so the domain
 * normalization / url derivation rules are unit-testable.
 */
export function buildCookieSetDetails(c: CapsuleMigrationCookie): {
  url: string;
  name: string;
  value: string;
  domain?: string;
  path: string;
  secure: boolean;
  httpOnly: boolean;
  expirationDate?: number;
  sameSite?: 'unspecified' | 'no_restriction' | 'lax' | 'strict';
} {
  const domain = String(c.domain || '').replace(/^\./, '');
  return {
    url: `${c.secure ? 'https://' : 'http://'}${domain}${c.path || '/'}`,
    name: c.name,
    value: c.value,
    domain: String(c.domain || '').startsWith('.') ? c.domain : undefined,
    path: c.path || '/',
    secure: c.secure,
    httpOnly: c.httpOnly,
    ...(typeof c.expirationDate === 'number' ? { expirationDate: c.expirationDate } : {}),
    ...(c.sameSite ? { sameSite: c.sameSite as 'unspecified' | 'no_restriction' | 'lax' | 'strict' } : {}),
  };
}

export async function runCapsuleToProfileMigration(deps: CapsuleMigrationDeps): Promise<CapsuleMigrationResult> {
  let listFailed = false;
  let keys: string[] = [];
  try {
    keys = deps.listLegacyPartitionKeys();
  } catch {
    listFailed = true;
  }
  // Always attempt the canonical default mapping even when the on-disk
  // enumeration finds nothing (layout differences across Electron versions).
  const candidateKeys = keys.length > 0 ? keys : ['capsule-default'];
  let migrated = 0;
  let failed = listFailed;
  const legacyPartitions: string[] = [];
  for (const key of candidateKeys) {
    const legacy = `persist:${key}`;
    const target = `persist:${key.replace(/^capsule-/, 'profile-')}`;
    if (legacy === target) continue;
    try {
      const cookies = await deps.readCookies(legacy);
      if (cookies.length === 0) continue;
      let copied = 0;
      for (const c of cookies) {
        try {
          await deps.writeCookie(target, c);
          copied++;
        } catch {
          // A single unimportable cookie means the migration is NOT complete:
          // the done marker stays unset so the next launch retries (legacy
          // partition data is never removed, so retry is always safe).
          failed = true;
        }
      }
      if (copied > 0) {
        await deps.flushStore(target);
        migrated += copied;
        legacyPartitions.push(legacy);
      }
    } catch {
      failed = true;
    }
  }
  return { migrated, legacyPartitions, markerReady: !failed };
}