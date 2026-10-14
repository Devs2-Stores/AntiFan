import { buildCookieSetDetails, type CapsuleMigrationCookie, type CookieSetDetails } from './capsule-partition-migration';

export const STOREFRONT_PASSWORD_COOKIE = 'storefront_digest';

export const STOREFRONT_RESTORE_COOLDOWN_MS = 5000;

export interface StorefrontCookieGuardTarget {
  cookies: {
    on: (event: 'changed', listener: (...args: unknown[]) => void) => unknown;
    set: (details: CookieSetDetails) => Promise<void>;
  };
}

export interface StorefrontCookieGuardRecord {
  partition: string;
  action: 'upgraded' | 'restored' | 'restore-skipped' | 'failed';
  domain: string;
  path: string;
  reason?: string;
}

export type StorefrontCookieGuardSink = (record: StorefrontCookieGuardRecord) => void;

export interface StorefrontCookieGuardOptions {
  cooldownMs?: number;
  now?: () => number;
}

const SAME_SITE: Record<string, true> = { unspecified: true, no_restriction: true, lax: true, strict: true };

const guardArmed = new WeakSet<object>();

function readCookie(raw: unknown): (CapsuleMigrationCookie & { domain: string; path: string }) | null {
  if (!raw || typeof raw !== 'object') return null;
  const c = raw as Record<string, unknown>;
  if (typeof c.name !== 'string' || typeof c.value !== 'string' || typeof c.domain !== 'string' || !c.domain) return null;
  const sameSite = typeof c.sameSite === 'string' && SAME_SITE[c.sameSite]
    ? (c.sameSite as CapsuleMigrationCookie['sameSite'])
    : undefined;
  return {
    name: c.name,
    value: c.value,
    domain: c.domain,
    path: typeof c.path === 'string' && c.path ? c.path : '/',
    secure: c.secure === true,
    httpOnly: c.httpOnly === true,
    ...(typeof c.expirationDate === 'number' ? { expirationDate: c.expirationDate } : {}),
    ...(sameSite ? { sameSite } : {}),
  };
}

// A Secure cookie is never sent over plain http, so loopback/IP hosts (local theme-dev proxies) keep their original flag.
function canUpgradeToSecure(domain: string): boolean {
  const host = domain.replace(/^\./, '').toLowerCase();
  if (host === 'localhost' || host.endsWith('.localhost')) return false;
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host) || host.includes(':') || host.startsWith('[')) return false;
  return true;
}

export function armStorefrontPasswordCookieGuard(
  target: StorefrontCookieGuardTarget | null | undefined,
  partition: string,
  sink: StorefrontCookieGuardSink,
  options: StorefrontCookieGuardOptions = {}
): boolean {
  if (!target || typeof target !== 'object') return false;
  const { cookies } = target;
  if (typeof cookies?.on !== 'function' || typeof cookies.set !== 'function') return false;
  if (guardArmed.has(target)) return false;
  guardArmed.add(target);

  const cooldownMs = options.cooldownMs ?? STOREFRONT_RESTORE_COOLDOWN_MS;
  const now = options.now ?? Date.now;
  const lastRestoreAt = new Map<string, number>();

  // Records carry domain/path only: the password digest value must never reach a log.
  const emit = (record: StorefrontCookieGuardRecord): void => {
    try {
      sink(record);
    } catch {
      // A diagnostic write must never break the cookie store listener.
    }
  };

  const write = (action: 'upgraded' | 'restored', cookie: CapsuleMigrationCookie & { domain: string; path: string }): void => {
    const where = { partition, domain: cookie.domain, path: cookie.path };
    let pending: Promise<void>;
    try {
      pending = cookies.set(buildCookieSetDetails(cookie));
    } catch (err) {
      emit({ ...where, action: 'failed', reason: `${action}: ${err instanceof Error ? err.message : String(err)}` });
      return;
    }
    pending.then(
      () => emit({ ...where, action }),
      (err: unknown) => emit({ ...where, action: 'failed', reason: `${action}: ${err instanceof Error ? err.message : String(err)}` })
    );
  };

  cookies.on('changed', (...args: unknown[]) => {
    const [, raw, cause, removed] = args;
    const cookie = readCookie(raw);
    if (!cookie || cookie.name !== STOREFRONT_PASSWORD_COOKIE) return;

    if (removed === false) {
      if (cookie.secure || !canUpgradeToSecure(cookie.domain)) return;
      write('upgraded', { ...cookie, secure: true });
      return;
    }
    if (removed !== true || cause !== 'evicted') return;

    const where = { partition, domain: cookie.domain, path: cookie.path };
    const at = now();
    if (typeof cookie.expirationDate === 'number' && cookie.expirationDate * 1000 <= at) {
      emit({ ...where, action: 'restore-skipped', reason: 'expired' });
      return;
    }
    const key = `${cookie.domain}|${cookie.path}`;
    const last = lastRestoreAt.get(key);
    if (last !== undefined && at - last < cooldownMs) {
      emit({ ...where, action: 'restore-skipped', reason: 'cooldown' });
      return;
    }
    lastRestoreAt.set(key, at);
    write('restored', { ...cookie, secure: cookie.secure || canUpgradeToSecure(cookie.domain) });
  });
  return true;
}
