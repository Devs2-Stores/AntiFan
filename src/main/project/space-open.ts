import * as fs from 'node:fs';
import * as path from 'node:path';
import type { SpaceOpenResult } from '../../shared/contracts';
import {
  readSpaceManifest,
  resolveSpaceTabPath,
  type SpaceManifest,
  type SpaceTabSpec,
  type SpaceTerminalSpec,
} from './space-manifest';

/** The project window a Space opens its tabs into. */
export interface SpaceWindow {
  capsuleId: string;
  hasTab(spec: SpaceTabSpec): boolean;
  /** `absolutePath` is set for `path` tabs: the contained file the preview route serves. */
  openTab(spec: SpaceTabSpec, absolutePath?: string): boolean;
}

export interface SpaceSessionView {
  id: string;
  cwd?: string;
  state?: string;
  spaceTerminalId?: string;
}

/**
 * Everything Space opening needs from the app, injected so the flow is exercised without Electron
 * and so Main - not the manifest - decides which window, shell and admission rules apply.
 */
export interface SpaceOpenDeps {
  folderKey(folder: string): string;
  /** Throws when the application no longer admits new work (a quit has committed). */
  admit(): void;
  isConfirmed(key: string, hash: string): boolean;
  recordConfirmed(key: string, hash: string): void;
  openWindow(realFolder: string): Promise<{ ok: true; window: SpaceWindow } | { ok: false; message: string }>;
  sessions(): SpaceSessionView[];
  /** Mint one shell in the folder stamped with the declared role; resolves the new session id. */
  mint(realFolder: string, capsuleId: string, spec: SpaceTerminalSpec): Promise<string | null>;
  /**
   * The live sync watcher that already pushes to the same remote as a `sync` terminal minted in
   * this folder, or undefined. Opening a Space never acknowledges a duplicate on the user's behalf.
   */
  findSyncDuplicate(realFolder: string, capsuleId: string): { id: string; label: string } | undefined;
  typeCommand(sessionId: string, text: string): Promise<unknown> | unknown;
  /** Wake a sleeping session (a fresh shell in the same cwd); false when it could not be woken. */
  wake(sessionId: string): Promise<boolean> | boolean;
}

// Process-wide: watchers in different folders can share one remote, so the sync duplicate check
// and its mint may not interleave with another folder's.
let syncMintChain: Promise<unknown> = Promise.resolve();
function withSyncMintLock<T>(fn: () => Promise<T>): Promise<T> {
  const run = syncMintChain.then(fn, fn);
  syncMintChain = run.catch(() => undefined);
  return run;
}

// One open per folder at a time: a second call waits for the first and then re-checks reuse, so
// two clicks can never both decide "nothing exists yet".
const openLocks = new Map<string, Promise<unknown>>();

/**
 * Which manifest contents the user already confirmed, per canonical folder, persisted in the data
 * root (never in the folder: a checked-in file must not be able to pre-approve itself).
 */
export function createConfirmationStore(filePath: string): Pick<SpaceOpenDeps, 'isConfirmed' | 'recordConfirmed'> {
  const read = (): Record<string, string[]> => {
    try {
      const parsed: unknown = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
      // Hand-edited file: keep only string-array entries so isConfirmed can never throw.
      const clean: Record<string, string[]> = {};
      for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
        if (Array.isArray(v)) clean[k] = v.filter((h): h is string => typeof h === 'string');
      }
      return clean;
    } catch {
      return {};
    }
  };
  return {
    isConfirmed: (key, hash) => (read()[key] ?? []).includes(hash),
    recordConfirmed: (key, hash) => {
      const all = read();
      // Only the latest confirmed content per folder is kept: an older approved file re-prompts.
      all[key] = [hash];
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      fs.writeFileSync(filePath, JSON.stringify(all), 'utf8');
    },
  };
}

export function openSpace(
  deps: SpaceOpenDeps,
  realFolder: string,
  confirmHash: string | undefined,
): Promise<SpaceOpenResult> {
  const key = deps.folderKey(realFolder);
  const previous = openLocks.get(key) ?? Promise.resolve();
  const run = previous.then(
    () => runOpen(deps, realFolder, key, confirmHash),
    () => runOpen(deps, realFolder, key, confirmHash),
  );
  openLocks.set(key, run);
  const release = (): void => {
    if (openLocks.get(key) === run) openLocks.delete(key);
  };
  run.then(release, release);
  return run;
}

async function runOpen(
  deps: SpaceOpenDeps,
  realFolder: string,
  key: string,
  confirmHash: string | undefined,
): Promise<SpaceOpenResult> {
  try {
    deps.admit();
  } catch (err) {
    return { ok: false, reason: 'SENDER_NOT_ADMITTED', message: String(err instanceof Error ? err.message : err) };
  }
  // Read once: this buffer is validated, hashed and (if confirmed) executed - never re-read.
  const read = readSpaceManifest(realFolder);
  if (!read.found) return { ok: false, reason: 'NO_MANIFEST', message: 'This folder has no .antifan/space.json' };
  if (!read.parse.ok) {
    return { ok: false, reason: 'MANIFEST_INVALID', message: 'space.json is invalid', errors: read.parse.errors };
  }
  const { manifest, hash } = read.parse;
  const withCommands = manifest.terminals.filter((t) => t.command);
  if (confirmHash !== undefined && confirmHash !== hash) {
    return { ok: false, reason: 'CONFIRM_MISMATCH', message: 'space.json changed since it was shown; review it again' };
  }
  if (withCommands.length > 0 && confirmHash === undefined && !deps.isConfirmed(key, hash)) {
    return {
      ok: false,
      reason: 'NEEDS_CONFIRM',
      hash,
      commands: withCommands.map((t) => ({ label: t.label, command: t.command as string })),
    };
  }
  if (confirmHash !== undefined && withCommands.length > 0) deps.recordConfirmed(key, hash);

  const opened = await deps.openWindow(realFolder);
  if (!opened.ok) return { ok: false, reason: 'WINDOW_FAILED', message: opened.message };
  try {
    deps.admit();
  } catch (err) {
    return { ok: false, reason: 'SENDER_NOT_ADMITTED', message: String(err instanceof Error ? err.message : err) };
  }
  return applyManifest(deps, realFolder, key, manifest, opened.window);
}

async function applyManifest(
  deps: SpaceOpenDeps,
  realFolder: string,
  key: string,
  manifest: SpaceManifest,
  window: SpaceWindow,
): Promise<SpaceOpenResult> {
  let terminalsOpened = 0;
  let terminalsReused = 0;
  let terminalsWoken = 0;
  const syncDuplicates: Array<{ spaceTerminalId: string; duplicate: { id: string; label: string } }> = [];
  for (const spec of manifest.terminals) {
    try {
      deps.admit();
      const live = deps.sessions().find(
        (s) =>
          s.spaceTerminalId === spec.id &&
          (s.state === 'running' || s.state === 'sleeping') &&
          typeof s.cwd === 'string' &&
          deps.folderKey(s.cwd) === key,
      );
      if (live) {
        terminalsReused += 1;
        if (live.state === 'sleeping') {
          // Reuse must deliver the declared work: a sleeping shell is woken (a fresh shell in the
          // same cwd) and gets its command, else the Space would report a terminal that does nothing.
          const woke = await deps.wake(live.id);
          if (woke === false) {
            return { ok: false, reason: 'CREATE_FAILED', message: `Terminal '${spec.id}' is sleeping and could not be woken` };
          }
          terminalsWoken += 1;
          if (spec.command && (await deps.typeCommand(live.id, `${spec.command}\r`)) === false) {
            return { ok: false, reason: 'CREATE_FAILED', message: `Command for '${spec.id}' was not delivered` };
          }
        }
        continue;
      }
      let id: string | null;
      if (spec.role === 'sync') {
        // The duplicate lookup and the mint are one critical section across ALL folders: two
        // folders bound to one remote must not both see "no watcher yet" and each mint one.
        const outcome = await withSyncMintLock(
          async (): Promise<{ duplicate: { id: string; label: string } } | { id: string | null }> => {
            const duplicate = deps.findSyncDuplicate(realFolder, window.capsuleId);
            if (duplicate) return { duplicate };
            return { id: await deps.mint(realFolder, window.capsuleId, spec) };
          },
        );
        if ('duplicate' in outcome) {
          // A second watcher on one remote overwrites the first's uploads: refuse to mint, report.
          syncDuplicates.push({ spaceTerminalId: spec.id, duplicate: outcome.duplicate });
          continue;
        }
        id = outcome.id;
      } else {
        id = await deps.mint(realFolder, window.capsuleId, spec);
      }
      if (!id) return { ok: false, reason: 'CREATE_FAILED', message: `Terminal '${spec.id}' minted no session` };
      terminalsOpened += 1;
      if (spec.command && (await deps.typeCommand(id, `${spec.command}\r`)) === false) {
        // Daemon-mode writeTo maps an RPC failure to false: the terminal exists, its command does not.
        return { ok: false, reason: 'CREATE_FAILED', message: `Command for '${spec.id}' was not delivered` };
      }
    } catch (err) {
      return { ok: false, reason: 'CREATE_FAILED', message: String(err instanceof Error ? err.message : err) };
    }
  }
  let tabsOpened = 0;
  let tabsReused = 0;
  for (const spec of manifest.tabs) {
    try {
      // Every externally awaited step above can outlive a committed quit; tabs are mutations too.
      deps.admit();
    } catch (err) {
      return { ok: false, reason: 'SENDER_NOT_ADMITTED', message: String(err instanceof Error ? err.message : err) };
    }
    let absolute: string | undefined;
    if (spec.kind === 'path') {
      absolute = resolveSpaceTabPath(realFolder, spec.path);
      // A path that resolves outside the folder (including through a link) is skipped, not opened.
      if (!absolute) continue;
    }
    if (window.hasTab(spec)) {
      tabsReused += 1;
    } else if (window.openTab(spec, absolute)) {
      tabsOpened += 1;
    }
  }
  return {
    ok: true,
    terminalsOpened,
    terminalsReused,
    ...(terminalsWoken > 0 ? { terminalsWoken } : {}),
    tabsOpened,
    tabsReused,
    ...(syncDuplicates.length > 0 ? { syncDuplicates } : {}),
  };
}
