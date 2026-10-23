import * as fs from 'node:fs';
import * as path from 'node:path';
import type { SpaceOpenResult, SpaceSplitsInfo } from '../../shared/contracts';
import {
  readSpaceManifest,
  resolveSpaceTabPath,
  resolveSpaceTerminalCwd,
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
  /** Set on a split pane: the base session it belongs to. */
  splitOf?: string;
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
  /** Mint one base shell in `directory` stamped with the declared role; resolves the new session id. */
  mint(directory: string, capsuleId: string, spec: SpaceTerminalSpec): Promise<string | null>;
  /**
   * Mint one split pane under `parentSessionId`, starting in `directory`, owning the declared
   * role, idle policy and label; resolves the new split's session id.
   */
  mintSplit(directory: string, capsuleId: string, parentSessionId: string, spec: SpaceTerminalSpec): Promise<string | null>;
  /**
   * The live sync watcher (a base shell or a split pane) that already pushes to the same remote as
   * a `sync` terminal minted in `directory`, or undefined. Opening a Space never acknowledges a
   * duplicate on the user's behalf.
   */
  findSyncDuplicate(directory: string, capsuleId: string): { id: string; label: string } | undefined;
  typeCommand(sessionId: string, text: string): Promise<unknown> | unknown;
  /** Wake a sleeping session (a fresh shell in the same cwd); false when it could not be woken. */
  wake(sessionId: string): Promise<boolean> | boolean;
}

/**
 * What opening a Space's splits under a terminal that is already open needs: no window is opened
 * and no base shell is minted, so neither dependency exists here.
 */
export type SpaceSplitDeps = Omit<SpaceOpenDeps, 'openWindow' | 'mint'>;

/** The live base terminal a Space's declared splits open under. */
export interface SpaceSplitAnchor {
  sessionId: string;
  /** The base's capsule: the duplicate-watcher check reads that capsule's brief. */
  capsuleId: string;
  /** The Space entry the base was minted for, when it was one: it picks whose splits apply. */
  spaceTerminalId?: string;
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

function withFolderLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const previous = openLocks.get(key) ?? Promise.resolve();
  const run = previous.then(fn, fn);
  openLocks.set(key, run);
  const release = (): void => {
    if (openLocks.get(key) === run) openLocks.delete(key);
  };
  run.then(release, release);
  return run;
}

export function openSpace(
  deps: SpaceOpenDeps,
  realFolder: string,
  confirmHash: string | undefined,
): Promise<SpaceOpenResult> {
  const key = deps.folderKey(realFolder);
  return withFolderLock(key, () => runOpen(deps, realFolder, key, confirmHash));
}

type ManifestRead =
  | { ok: true; manifest: SpaceManifest; hash: string }
  | { ok: false; reason: 'NO_MANIFEST' | 'MANIFEST_INVALID'; message: string; errors?: Array<{ path: string; message: string }> };

function readManifestOf(realFolder: string): ManifestRead {
  // Read once: this buffer is validated, hashed and (if confirmed) executed - never re-read.
  const read = readSpaceManifest(realFolder);
  if (!read.found) return { ok: false, reason: 'NO_MANIFEST', message: 'This folder has no .antifan/space.json' };
  if (!read.parse.ok) return { ok: false, reason: 'MANIFEST_INVALID', message: 'space.json is invalid', errors: read.parse.errors };
  return { ok: true, manifest: read.parse.manifest, hash: read.parse.hash };
}

/**
 * The confirmation gate in front of every typed command: the refusal (or the confirm request
 * listing exactly the commands `specs` would type) to return, or null when they may run.
 * `acceptedKeys` name the confirmations that cover these commands; a confirmed call records
 * `recordKey`.
 */
function confirmationRefusal(
  deps: Pick<SpaceOpenDeps, 'isConfirmed' | 'recordConfirmed'>,
  acceptedKeys: readonly string[],
  recordKey: string,
  hash: string,
  confirmHash: string | undefined,
  specs: readonly SpaceTerminalSpec[],
): SpaceOpenResult | null {
  const withCommands = specs.filter((t) => t.command);
  if (confirmHash !== undefined && confirmHash !== hash) {
    return { ok: false, reason: 'CONFIRM_MISMATCH', message: 'space.json changed since it was shown; review it again' };
  }
  if (withCommands.length > 0 && confirmHash === undefined && !acceptedKeys.some((k) => deps.isConfirmed(k, hash))) {
    return {
      ok: false,
      reason: 'NEEDS_CONFIRM',
      hash,
      commands: withCommands.map((t) => ({ label: t.label, command: t.command as string })),
    };
  }
  if (confirmHash !== undefined && withCommands.length > 0) deps.recordConfirmed(recordKey, hash);
  return null;
}

/**
 * Which base terminal's splits a session stands for: the base entry it was minted for when it
 * carries one of this manifest's base ids (even one that declares no split), otherwise the first
 * base that declares any split.
 */
export function spaceSplitsFor(
  manifest: SpaceManifest,
  spaceTerminalId: string | undefined,
): { base: SpaceTerminalSpec; splits: SpaceTerminalSpec[] } | undefined {
  const bases = manifest.terminals.filter((t) => !t.splitOf);
  const splitsOf = (id: string): SpaceTerminalSpec[] => manifest.terminals.filter((t) => t.splitOf === id);
  const own = spaceTerminalId ? bases.find((t) => t.id === spaceTerminalId) : undefined;
  const base = own ?? bases.find((t) => splitsOf(t.id).length > 0);
  return base ? { base, splits: splitsOf(base.id) } : undefined;
}

/** Read-only: the splits the Space declares for a base, for the split toggle to offer. */
export function describeSpaceSplits(realFolder: string, spaceTerminalId: string | undefined): SpaceSplitsInfo {
  const read = readManifestOf(realFolder);
  if (!read.ok) return { ok: false, reason: read.reason, message: read.message };
  const picked = spaceSplitsFor(read.manifest, spaceTerminalId);
  if (!picked || picked.splits.length === 0) {
    return { ok: false, reason: 'NO_SPLITS', message: 'space.json declares no split for this terminal' };
  }
  return {
    ok: true,
    folder: realFolder,
    baseSpecId: picked.base.id,
    splits: picked.splits.map((s) => ({
      id: s.id,
      label: s.label,
      role: s.role,
      ...(s.cwd ? { cwd: s.cwd } : {}),
      ...(s.command ? { command: s.command } : {}),
    })),
  };
}

/**
 * Open the splits the Space declares under a terminal that is already open, instead of minting
 * the Space's own base: reused, woken and minted exactly like a full open, under the same
 * per-folder lock. Confirming these commands covers only this base's splits; a confirmed full
 * open covers them too.
 */
export function openSpaceSplits(
  deps: SpaceSplitDeps,
  realFolder: string,
  anchor: SpaceSplitAnchor,
  confirmHash: string | undefined,
): Promise<SpaceOpenResult> {
  const key = deps.folderKey(realFolder);
  return withFolderLock(key, () => runOpenSplits(deps, realFolder, key, anchor, confirmHash));
}

async function runOpenSplits(
  deps: SpaceSplitDeps,
  realFolder: string,
  key: string,
  anchor: SpaceSplitAnchor,
  confirmHash: string | undefined,
): Promise<SpaceOpenResult> {
  try {
    deps.admit();
  } catch (err) {
    return { ok: false, reason: 'SENDER_NOT_ADMITTED', message: String(err instanceof Error ? err.message : err) };
  }
  const read = readManifestOf(realFolder);
  if (!read.ok) return { ok: false, reason: read.reason, message: read.message, ...(read.errors ? { errors: read.errors } : {}) };
  const picked = spaceSplitsFor(read.manifest, anchor.spaceTerminalId);
  if (!picked || picked.splits.length === 0) {
    return { ok: false, reason: 'NO_SPLITS', message: 'space.json declares no split for this terminal' };
  }
  // Checked under the lock: a split cannot own splits, and a closed tab has no row to show them in.
  const base = deps.sessions().find((s) => s.id === anchor.sessionId);
  if (!base || base.splitOf || (base.state !== 'running' && base.state !== 'sleeping')) {
    return { ok: false, reason: 'SESSION_INVALID', message: `'${anchor.sessionId}' is not an open base terminal` };
  }
  const splitsKey = `${key}#splits:${picked.base.id}`;
  const refusal = confirmationRefusal(deps, [key, splitsKey], splitsKey, read.hash, confirmHash, picked.splits);
  if (refusal) return refusal;
  const directories = resolveDirectories(realFolder, picked.splits);
  if (!(directories instanceof Map)) return directories;
  const opened = await openTerminals(deps, undefined, picked.splits, directories, anchor.capsuleId, new Map([[picked.base.id, anchor.sessionId]]));
  if (!opened.ok) return opened.result;
  return { ...summarize(opened.tally), tabsOpened: 0, tabsReused: 0 };
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
  const read = readManifestOf(realFolder);
  if (!read.ok) return { ok: false, reason: read.reason, message: read.message, ...(read.errors ? { errors: read.errors } : {}) };
  const { manifest, hash } = read;
  const refusal = confirmationRefusal(deps, [key], key, hash, confirmHash, manifest.terminals);
  if (refusal) return refusal;

  const opened = await deps.openWindow(realFolder);
  if (!opened.ok) return { ok: false, reason: 'WINDOW_FAILED', message: opened.message };
  try {
    deps.admit();
  } catch (err) {
    return { ok: false, reason: 'SENDER_NOT_ADMITTED', message: String(err instanceof Error ? err.message : err) };
  }
  return applyManifest(deps, realFolder, manifest, opened.window);
}

/**
 * Every declared directory, resolved before anything is minted: a terminal never starts somewhere
 * else than it declared, and a bad entry must not leave half a Space open.
 */
function resolveDirectories(realFolder: string, specs: readonly SpaceTerminalSpec[]): Map<string, string> | SpaceOpenResult {
  const directories = new Map<string, string>();
  for (const spec of specs) {
    if (!spec.cwd) {
      directories.set(spec.id, realFolder);
      continue;
    }
    const resolved = resolveSpaceTerminalCwd(realFolder, spec.cwd);
    if (!resolved) {
      return { ok: false, reason: 'CREATE_FAILED', message: `Terminal '${spec.id}': cwd '${spec.cwd}' is not an existing folder inside this project` };
    }
    directories.set(spec.id, resolved);
  }
  return directories;
}

interface TerminalTally {
  opened: number;
  reused: number;
  woken: number;
  syncDuplicates: Array<{ spaceTerminalId: string; duplicate: { id: string; label: string } }>;
}

function summarize(tally: TerminalTally): Omit<Extract<SpaceOpenResult, { ok: true }>, 'tabsOpened' | 'tabsReused'> {
  return {
    ok: true,
    terminalsOpened: tally.opened,
    terminalsReused: tally.reused,
    ...(tally.woken > 0 ? { terminalsWoken: tally.woken } : {}),
    ...(tally.syncDuplicates.length > 0 ? { syncDuplicates: tally.syncDuplicates } : {}),
  };
}

async function applyManifest(
  deps: SpaceOpenDeps,
  realFolder: string,
  manifest: SpaceManifest,
  window: SpaceWindow,
): Promise<SpaceOpenResult> {
  const directories = resolveDirectories(realFolder, manifest.terminals);
  if (!(directories instanceof Map)) return directories;
  const opened = await openTerminals(deps, deps.mint, manifest.terminals, directories, window.capsuleId, new Map());
  if (!opened.ok) return opened.result;
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
  return { ...summarize(opened.tally), tabsOpened, tabsReused };
}

/**
 * Reuse, wake or mint each declared terminal, bases before splits. `sessionIdBySpecId` may be
 * seeded with a base that is already open, so its splits attach to it; `mint` is absent when
 * only splits are opened.
 */
async function openTerminals(
  deps: SpaceSplitDeps,
  mint: SpaceOpenDeps['mint'] | undefined,
  specs: readonly SpaceTerminalSpec[],
  directories: Map<string, string>,
  capsuleId: string,
  sessionIdBySpecId: Map<string, string>,
): Promise<{ ok: true; tally: TerminalTally } | { ok: false; result: SpaceOpenResult }> {
  const tally: TerminalTally = { opened: 0, reused: 0, woken: 0, syncDuplicates: [] };
  const fail = (message: string): { ok: false; result: SpaceOpenResult } => ({ ok: false, result: { ok: false, reason: 'CREATE_FAILED', message } });
  // What was running when the open started. A parent's wake cascades to its splits, so a split
  // that is already awake by its own turn was still asleep when the open began and still owes
  // its command.
  const before = deps.sessions();
  // Bases first: a split needs its parent's session id before it can be minted or matched.
  const ordered = [...specs.filter((t) => !t.splitOf), ...specs.filter((t) => t.splitOf)];
  for (const spec of ordered) {
    try {
      deps.admit();
      const directory = directories.get(spec.id) as string;
      const directoryKey = deps.folderKey(directory);
      const parentSessionId = spec.splitOf ? sessionIdBySpecId.get(spec.splitOf) : undefined;
      if (spec.splitOf && !parentSessionId) {
        return fail(`Terminal '${spec.id}' is a split of '${spec.splitOf}', which was not opened`);
      }
      const live = before.find(
        (s) =>
          s.spaceTerminalId === spec.id &&
          (s.state === 'running' || s.state === 'sleeping') &&
          typeof s.cwd === 'string' &&
          deps.folderKey(s.cwd) === directoryKey &&
          (spec.splitOf ? s.splitOf === parentSessionId : !s.splitOf),
      );
      if (live) {
        sessionIdBySpecId.set(spec.id, live.id);
        tally.reused += 1;
        if (live.state === 'sleeping') {
          // Reuse must deliver the declared work: a sleeping shell is woken (a fresh shell in the
          // same cwd) and gets its command, else the Space would report a terminal that does nothing.
          const current = deps.sessions().find((s) => s.id === live.id);
          if (current?.state === 'sleeping' && (await deps.wake(live.id)) === false) {
            return fail(`Terminal '${spec.id}' is sleeping and could not be woken`);
          }
          tally.woken += 1;
          if (spec.command && (await deps.typeCommand(live.id, `${spec.command}\r`)) === false) {
            return fail(`Command for '${spec.id}' was not delivered`);
          }
        }
        continue;
      }
      if (!parentSessionId && !mint) return fail(`Terminal '${spec.id}' is a base terminal; only splits are opened here`);
      const mintOne = (): Promise<string | null> =>
        parentSessionId
          ? deps.mintSplit(directory, capsuleId, parentSessionId, spec)
          : (mint as SpaceOpenDeps['mint'])(directory, capsuleId, spec);
      let id: string | null;
      if (spec.role === 'sync') {
        // The duplicate lookup and the mint are one critical section across ALL folders: two
        // folders bound to one remote must not both see "no watcher yet" and each mint one.
        const outcome = await withSyncMintLock(
          async (): Promise<{ duplicate: { id: string; label: string } } | { id: string | null }> => {
            const duplicate = deps.findSyncDuplicate(directory, capsuleId);
            if (duplicate) return { duplicate };
            return { id: await mintOne() };
          },
        );
        if ('duplicate' in outcome) {
          // A second watcher on one remote overwrites the first's uploads: refuse to mint, report.
          tally.syncDuplicates.push({ spaceTerminalId: spec.id, duplicate: outcome.duplicate });
          continue;
        }
        id = outcome.id;
      } else {
        id = await mintOne();
      }
      if (!id) return fail(`Terminal '${spec.id}' minted no session`);
      sessionIdBySpecId.set(spec.id, id);
      tally.opened += 1;
      if (spec.command && (await deps.typeCommand(id, `${spec.command}\r`)) === false) {
        // Daemon-mode writeTo maps an RPC failure to false: the terminal exists, its command does not.
        return fail(`Command for '${spec.id}' was not delivered`);
      }
    } catch (err) {
      return fail(String(err instanceof Error ? err.message : err));
    }
  }
  return { ok: true, tally };
}

