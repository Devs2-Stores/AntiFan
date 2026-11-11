import type { Session } from 'electron';

/**
 * Web permission policy for every browser session: a narrow deny list with allow
 * as the default, so sign-in, meetings, clipboard, notifications, fullscreen,
 * pointer lock and geolocation keep working while hardware access and
 * window-management are refused. Names are limited to the ones the Electron
 * permission unions contain for each handler.
 */
export type PermissionHandlerKind = 'check' | 'request';

const DENIED_BY_HANDLER: Record<PermissionHandlerKind, Record<string, true>> = {
  check: { serial: true, hid: true, usb: true, midi: true, midiSysex: true, 'idle-detection': true, fileSystem: true },
  request: { midi: true, midiSysex: true, 'idle-detection': true, fileSystem: true, 'window-management': true },
};

const MAX_JOURNAL_KEYS = 256;

export type PermissionDeniedJournal = (record: { partition: string; handler: PermissionHandlerKind; permission: string; origin: string }) => void;

export function shouldDenyPermission(handler: PermissionHandlerKind, permission: string): boolean {
  return Object.prototype.hasOwnProperty.call(DENIED_BY_HANDLER[handler], permission);
}

function originOf(value: unknown): string {
  if (typeof value !== 'string' || !value) return '';
  try {
    return new URL(value).origin;
  } catch {
    return '';
  }
}

/**
 * Installs the check and request handlers on one session and journals each
 * denial once per (handler, permission, origin). The check handler is polled
 * often, hence the dedupe. Caller guarantees one install per session.
 */
export function installWebPermissionPolicy(sess: Session, partition: string, journal: PermissionDeniedJournal): void {
  const seen = new Set<string>();
  const deny = (handler: PermissionHandlerKind, permission: string, origin: string): void => {
    const key = `${handler}\u0000${permission}\u0000${origin}`;
    if (seen.has(key)) return;
    if (seen.size >= MAX_JOURNAL_KEYS) seen.clear();
    seen.add(key);
    journal({ partition, handler, permission, origin });
  };

  sess.setPermissionCheckHandler((_wc, permission, requestingOrigin) => {
    if (!shouldDenyPermission('check', permission)) return true;
    deny('check', permission, originOf(requestingOrigin));
    return false;
  });
  sess.setPermissionRequestHandler((_wc, permission, callback, details) => {
    if (!shouldDenyPermission('request', permission)) {
      callback(true);
      return;
    }
    deny('request', permission, originOf((details as { requestingUrl?: string } | undefined)?.requestingUrl));
    callback(false);
  });
}
