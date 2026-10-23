import * as fs from 'node:fs';
import * as path from 'node:path';
import { canonicalFolderKey } from './workspace-capsule';

/**
 * The remote a theme-sync terminal pushes to. Two watchers with the same identity overwrite each
 * other's uploads, so the identity is what a duplicate check compares, never the folder alone when
 * a stronger key is known.
 *
 * Strength, strongest first:
 * - `haravan:<org_id>:<theme_id>` from the Haravan CLI's own binding file in the folder;
 * - `sapo:<store>:<theme_id>` from the Sapo CLI's `.sapo-cli_local.json` in the folder;
 * - `brief:<themeId>` from the capsule brief the user filled in;
 * - `folder:<canonical key>` when none exists (Shopify keeps no local binding file, so two
 *   folders bound to one theme are not detectable and the identity says so by its kind).
 */
export type SyncIdentityKind = 'haravan' | 'sapo' | 'brief' | 'folder';

export interface SyncIdentity {
  kind: SyncIdentityKind;
  key: string;
}

export const HARAVAN_LOCAL_BINDING_FILE = '.haravan-cli_local.json';
export const SAPO_LOCAL_BINDING_FILE = '.sapo-cli_local.json';

/** Ids the CLI writes are decimal or slug-like; anything else is a garbled file, not an identity. */
const REMOTE_ID_PATTERN = /^[0-9A-Za-z_-]{1,64}$/;

function remoteId(value: unknown): string | undefined {
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) return String(value);
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return REMOTE_ID_PATTERN.test(trimmed) ? trimmed : undefined;
}

/**
 * The Haravan binding a folder carries, or undefined when the file is absent, unreadable, not JSON,
 * or lacks either id. A garbled file degrades the identity; it never throws into a spawn path.
 */
export function readHaravanBinding(folder: string): { orgId: string; themeId: string } | undefined {
  let raw: string;
  try {
    raw = fs.readFileSync(path.join(folder, HARAVAN_LOCAL_BINDING_FILE), 'utf8');
  } catch {
    return undefined;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined;
  const record = parsed as Record<string, unknown>;
  const orgId = remoteId(record.org_id);
  const themeId = remoteId(record.theme_id);
  return orgId && themeId ? { orgId, themeId } : undefined;
}

/** Sapo store hosts (`<prefix>.mysapo.net`) and bare prefixes name the same store. */
const SAPO_STORE_PATTERN = /^[0-9a-z._-]{1,128}$/;
const SAPO_HOST_SUFFIX = /\.mysapo\.net$/;

function sapoStore(record: Record<string, unknown>): string | undefined {
  const fromPrefix = typeof record.store_prefix === 'string' ? record.store_prefix.trim().toLowerCase() : '';
  if (SAPO_STORE_PATTERN.test(fromPrefix)) return fromPrefix;
  if (typeof record.store_domain !== 'string') return undefined;
  // A domain may be written with a scheme, a path or a port; only the host names the store.
  const host = record.store_domain.trim().toLowerCase().replace(/^[a-z]+:\/\//, '').split(/[/?#:]/)[0] ?? '';
  const store = host.replace(SAPO_HOST_SUFFIX, '');
  return SAPO_STORE_PATTERN.test(store) ? store : undefined;
}

/**
 * The Sapo binding a folder carries, or undefined when the file is absent, unreadable, not JSON,
 * or names no store or no theme. Same degrade-never-throw contract as `readHaravanBinding`.
 */
export function readSapoBinding(folder: string): { store: string; themeId: string } | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(path.join(folder, SAPO_LOCAL_BINDING_FILE), 'utf8'));
  } catch {
    return undefined;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined;
  const record = parsed as Record<string, unknown>;
  const store = sapoStore(record);
  const themeId = remoteId(record.theme_id);
  return store && themeId ? { store, themeId } : undefined;
}

export function syncIdentity(folder: string, brief?: { themeId?: unknown } | null): SyncIdentity {
  const haravan = readHaravanBinding(folder);
  if (haravan) return { kind: 'haravan', key: `haravan:${haravan.orgId}:${haravan.themeId}` };
  const sapo = readSapoBinding(folder);
  if (sapo) return { kind: 'sapo', key: `sapo:${sapo.store}:${sapo.themeId}` };
  const briefThemeId = remoteId(brief?.themeId);
  if (briefThemeId) return { kind: 'brief', key: `brief:${briefThemeId}` };
  return { kind: 'folder', key: `folder:${canonicalFolderKey(folder)}` };
}

/** A live sync-role session as the duplicate check sees it. */
export interface LiveSyncSession {
  id: string;
  label: string;
  folder: string;
  brief?: { themeId?: unknown } | null;
}

/**
 * The first live sync session (other than `excludeId`) that pushes to the same remote as
 * `identity`, or undefined. Only running `sync` sessions belong in `live`: a sleeping or exited
 * shell uploads nothing, so it cannot collide.
 */
export function findSyncDuplicate(
  identity: SyncIdentity,
  live: readonly LiveSyncSession[],
  excludeId?: string,
): LiveSyncSession | undefined {
  return live.find((s) => s.id !== excludeId && syncIdentity(s.folder, s.brief).key === identity.key);
}
