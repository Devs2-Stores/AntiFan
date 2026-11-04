import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { StorageLocations } from '../config/storage-locations';
import { readTerminalRunSnapshot, type TerminalRunSnapshotOptions } from '../run/run-state-service';
import type { TerminalRunSnapshot } from '../../shared/contracts';
import { CapabilityError } from '../../shared/control-plane-contracts';
import { APPROVAL_DIR_NAME } from '../../omp-hooks/theme-push-approval';

/** Where a Leader asked a worker terminal to be minted. */
export interface LeaderPlacementRequest {
  cwd: string;
  name?: string;
}

export type LeaderPlacementResult =
  | { ok: true; sessionId: string; ownerKey?: string; capsuleId?: string; minted?: { capsuleId: string } }
  | { ok: false; reason: string; message: string };

/**
 * The host half of `terminal.create` for a Leader: mint a BASE terminal in the project that owns
 * `cwd`, filed the way the Terminal Manager's "new terminal in folder" files it. The terminal
 * manager state lives in the native tab host, so the host installs this late and the capability
 * layer never imports it.
 */
export interface LeaderPlacementPort {
  placeTerminal(request: LeaderPlacementRequest): Promise<LeaderPlacementResult>;
}

interface RegisteredPort {
  port: LeaderPlacementPort;
  /** The shared Terminal Manager's own host: it owns no folder, so it is the preferred placer. */
  sharedManager: boolean;
}

const placementPorts: RegisteredPort[] = [];

/**
 * Install a host's placement port; the returned function removes exactly this registration. Several
 * windows each carry a host, so the shared Terminal Manager's wins when it is present and the most
 * recently installed one answers otherwise.
 */
export function registerLeaderPlacementPort(port: LeaderPlacementPort, options: { sharedManager?: boolean } = {}): () => void {
  const entry: RegisteredPort = { port, sharedManager: options.sharedManager === true };
  placementPorts.push(entry);
  return () => {
    const index = placementPorts.indexOf(entry);
    if (index >= 0) placementPorts.splice(index, 1);
  };
}

export function getLeaderPlacementPort(): LeaderPlacementPort | undefined {
  const shared = placementPorts.find((entry) => entry.sharedManager);
  return (shared ?? placementPorts[placementPorts.length - 1])?.port;
}

/** What removing the project a Leader placement minted came to. */
export interface LeaderMintedProjectRemoval {
  /**
   * `REMOVED`: the project record was removed from the manager list. `NO_PROJECT`: the capsule never
   * became a project (it carries no validated affiliation), so there is nothing to remove. `REFUSED`: a
   * safety rule held it back (see `reason`). `FAILED`: the removal started and did not complete.
   */
  status: 'REMOVED' | 'NO_PROJECT' | 'REFUSED' | 'FAILED';
  reason?: string;
  projectId?: string;
  liveSessions?: number;
}

/**
 * The host half of `terminal.close { removeMintedProject: true }`. Main installs it, because project
 * removal drives windows and the project registry that the capability layer never imports.
 */
export interface LeaderProjectRemovalPort {
  removeMintedProject(request: { capsuleId: string }): Promise<LeaderMintedProjectRemoval>;
}

let projectRemovalPort: LeaderProjectRemovalPort | undefined;

/** Install Main's removal port; the returned function removes exactly this registration. */
export function registerLeaderProjectRemovalPort(port: LeaderProjectRemovalPort): () => void {
  projectRemovalPort = port;
  return () => {
    if (projectRemovalPort === port) projectRemovalPort = undefined;
  };
}

export function getLeaderProjectRemovalPort(): LeaderProjectRemovalPort | undefined {
  return projectRemovalPort;
}

/**
 * Folders a Leader's throwaway worker projects live under. `ANTIFAN_LEADER_SCRATCH_ROOTS` (a
 * `path.delimiter` list) replaces the default, which is the `scratch` folder beside the data root. A
 * project outside these is never removed by a Leader, whatever minted it.
 */
export function leaderScratchRoots(): string[] {
  const configured = (process.env.ANTIFAN_LEADER_SCRATCH_ROOTS ?? '')
    .split(path.delimiter)
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0 && path.isAbsolute(entry));
  if (configured.length > 0) return configured.map((entry) => path.resolve(entry));
  return [path.join(path.dirname(path.resolve(StorageLocations.getDataRoot())), 'scratch')];
}

function canonicalFolder(folder: string): string {
  let resolved = path.resolve(folder);
  try {
    resolved = fs.realpathSync.native(resolved);
  } catch {
    // A folder that no longer exists is compared by its spelling.
  }
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

/** Whether `folder` is strictly inside one of {@link leaderScratchRoots}: a root itself never qualifies. */
export function isUnderLeaderScratchRoot(folder: string): boolean {
  if (typeof folder !== 'string' || !folder.trim() || !path.isAbsolute(folder)) return false;
  const target = canonicalFolder(folder);
  return leaderScratchRoots().some((root) => {
    const relative = path.relative(canonicalFolder(root), target);
    return relative.length > 0 && !relative.startsWith('..') && !path.isAbsolute(relative);
  });
}

/** `<runtime dir>/runs`, resolved on every call so an isolated data root is honoured. */
export function leaderRunsDir(): string {
  return path.join(StorageLocations.getRuntimeDir(), 'runs');
}

/** `<runtime dir>/leader-push-approvals`: where a Leader records the user's one-use approval of a live theme push. */
export function leaderPushApprovalsDir(): string {
  return path.join(StorageLocations.getRuntimeDir(), APPROVAL_DIR_NAME);
}

/**
 * Remove every run file a terminal id left behind: its run snapshot, its brief and half-written
 * temporaries. A terminal minted for a Leader's worker must start with no history: the hook reads these
 * files by terminal id, and a daemon that predates the persisted id counters can reissue a closed id.
 */
export function clearRunFilesOf(terminalId: string): void {
  const dir = leaderRunsDir();
  let entries: string[];
  try {
    entries = fs.readdirSync(dir);
  } catch {
    return;
  }
  for (const name of entries) {
    if (name !== `${terminalId}.json` && name !== `${terminalId}.brief.json` && !name.startsWith(`${terminalId}.json.tmp-`) && !name.startsWith(`${terminalId}.brief.json.tmp-`)) continue;
    try { fs.rmSync(path.join(dir, name), { force: true }); } catch { /* a run file the hook holds open is rewritten by that hook anyway */ }
  }
}

/** One terminal's OMP run, or undefined when no hook ever wrote a run file for it. */
export function leaderRunSnapshot(terminalId: string, options?: TerminalRunSnapshotOptions): TerminalRunSnapshot | undefined {
  return readTerminalRunSnapshot(leaderRunsDir(), terminalId, options);
}

export interface RunSettledCriteria {
  /** The run counter the run must have reached. */
  minRunSeq?: number;
  /**
   * Only count a run whose last event is NEWER than this (epoch ms) and that has completed at least
   * one turn (`runSeq >= 1`): a leftover file of an earlier OMP, or a fresh session that has not yet
   * taken the prompt, is idle too but is not the answer to the input just written.
   */
  afterEventAt?: number;
}

/**
 * Whether a run has finished its turn: idle, parked on a question, or over (a dead or silent run
 * reads as ended), and past every criterion the caller set.
 */
export function isRunSettled(run: TerminalRunSnapshot, criteria: RunSettledCriteria = {}): boolean {
  if (typeof criteria.minRunSeq === 'number' && run.runSeq < criteria.minRunSeq) return false;
  if (typeof criteria.afterEventAt === 'number') {
    if (run.runSeq < 1) return false;
    if (typeof run.lastEventAt !== 'number' || run.lastEventAt <= criteria.afterEventAt) return false;
  }
  return run.state === 'idle' || run.state === 'waiting_user' || run.state === 'ended';
}

const RUN_POLL_MS = 500;

/**
 * Poll the terminal's run file until its run has settled. Rejects with `WAIT_TIMEOUT` at the
 * deadline and `WAIT_ABORTED` when the platform cancels the call. A missing run file keeps the wait
 * going: the hook may simply not have started in that terminal yet.
 */
export async function waitForRunSettled(
  terminalId: string,
  options: RunSettledCriteria & { timeoutMs: number; signal?: AbortSignal; pollMs?: number }
): Promise<TerminalRunSnapshot> {
  const deadline = Date.now() + options.timeoutMs;
  const pollMs = options.pollMs ?? RUN_POLL_MS;
  for (;;) {
    if (options.signal?.aborted) throw new CapabilityError('WAIT_ABORTED', 'Terminal wait aborted', { sessionId: terminalId });
    const run = leaderRunSnapshot(terminalId);
    if (run && isRunSettled(run, options)) return run;
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      throw new CapabilityError(
        'WAIT_TIMEOUT',
        `Terminal "${terminalId}" did not reach run-idle within ${options.timeoutMs}ms`,
        { sessionId: terminalId, ...(run ? { run } : {}) }
      );
    }
    const { promise: slept, resolve } = Promise.withResolvers<void>();
    const onAbort = (): void => {
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(() => {
      options.signal?.removeEventListener('abort', onAbort);
      resolve();
    }, Math.min(pollMs, remaining));
    options.signal?.addEventListener('abort', onAbort, { once: true });
    await slept;
  }
}

/**
 * Poll several terminals' run files in one loop until the first of them has settled; that terminal and its
 * run are returned. Rejects with `WAIT_TIMEOUT` at the deadline (carrying every run seen) and `WAIT_ABORTED`
 * when the platform cancels the call. A terminal with no run file is simply not idle yet.
 */
export async function waitForAnyRunSettled(
  terminalIds: readonly string[],
  options: RunSettledCriteria & { timeoutMs: number; signal?: AbortSignal; pollMs?: number },
): Promise<{ sessionId: string; run: TerminalRunSnapshot }> {
  const deadline = Date.now() + options.timeoutMs;
  const pollMs = options.pollMs ?? RUN_POLL_MS;
  for (;;) {
    if (options.signal?.aborted) throw new CapabilityError('WAIT_ABORTED', 'Terminal wait aborted', { sessionIds: [...terminalIds] });
    const runs: Record<string, TerminalRunSnapshot> = {};
    for (const sessionId of terminalIds) {
      const run = leaderRunSnapshot(sessionId);
      if (!run) continue;
      if (isRunSettled(run, options)) return { sessionId, run };
      runs[sessionId] = run;
    }
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      throw new CapabilityError(
        'WAIT_TIMEOUT',
        `None of ${terminalIds.length} terminals reached run-idle within ${options.timeoutMs}ms`,
        { sessionIds: [...terminalIds], runs },
      );
    }
    const { promise: slept, resolve } = Promise.withResolvers<void>();
    const onAbort = (): void => {
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(() => {
      options.signal?.removeEventListener('abort', onAbort);
      resolve();
    }, Math.min(pollMs, remaining));
    options.signal?.addEventListener('abort', onAbort, { once: true });
    await slept;
  }
}

/** The manifest the installer writes next to the user's OMP hooks (`PI_CODING_AGENT_DIR` moves it). */
function installedHooksManifestPath(): string {
  const agentDir = process.env.PI_CODING_AGENT_DIR
    ? path.resolve(process.env.PI_CODING_AGENT_DIR)
    : path.join(os.homedir(), '.omp', 'agent');
  return path.join(agentDir, 'hooks', '.antifan-hooks.json');
}

/** Build identity of the run-state hook the installer last installed, or undefined when the manifest does not say. */
export function installedRunStateHookSha256(): string | undefined {
  try {
    const manifest: unknown = JSON.parse(fs.readFileSync(installedHooksManifestPath(), 'utf8'));
    if (!manifest || typeof manifest !== 'object' || !('hooks' in manifest) || !Array.isArray(manifest.hooks)) return undefined;
    for (const hook of manifest.hooks) {
      if (hook && typeof hook === 'object' && 'id' in hook && hook.id === 'run-state') {
        return 'buildSha256' in hook && typeof hook.buildSha256 === 'string' && hook.buildSha256 ? hook.buildSha256 : undefined;
      }
    }
    return undefined;
  } catch {
    return undefined;
  }
}

/**
 * Which hook build a terminal's OMP runs and whether it is older than the installed one.
 *
 * `hookOutdated` is true when the run file's hook build differs from the installed manifest's, and
 * also when the run file carries none while the manifest does (a hook from before builds were
 * identified). It is absent when there is no run file or the manifest does not identify a build, so a
 * Leader never hears about drift that cannot be proven.
 */
export function leaderHookStatus(terminalId: string, installed: string | undefined): { hookSha256?: string; hookOutdated?: boolean } {
  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(path.join(leaderRunsDir(), `${terminalId}.json`), 'utf8'));
  } catch {
    return {};
  }
  if (!raw || typeof raw !== 'object') return {};
  const hookSha256 = 'hookSha256' in raw && typeof raw.hookSha256 === 'string' && raw.hookSha256 ? raw.hookSha256 : undefined;
  return {
    ...(hookSha256 ? { hookSha256 } : {}),
    ...(installed ? { hookOutdated: hookSha256 !== installed } : {}),
  };
}

/**
 * The hook ids `scripts/install-omp-hooks.mjs` installs. A test installs into a scratch agent dir and
 * compares this list with the manifest the real installer writes, so the two cannot drift apart.
 */
export const OMP_HOOK_IDS = ['edit-guard', 'run-state', 'leader-guard', 'playwright-gate', 'theme-qa-gate'] as const;

/** One OMP hook whose installed copy no longer matches what the installer wrote or what the repo source builds. */
export interface StaleHook {
  id: string;
  /** MISSING: the installed file is gone. INSTALLED_CHANGED: its bytes differ from the manifest. SOURCE_CHANGED: a bundled source file differs from the install-time hash. SOURCES_UNREADABLE: those sources cannot be read, so drift is unknown. NOT_INSTALLED: the manifest has no row for a hook the installer knows. */
  state: 'MISSING' | 'INSTALLED_CHANGED' | 'SOURCE_CHANGED' | 'SOURCES_UNREADABLE' | 'NOT_INSTALLED';
  detail: string;
}

interface ManifestHook {
  id: string;
  path: string;
  sha256: string;
  inputs?: string[];
  sourceSha256?: string;
}

/** What `scripts/install-omp-hooks.mjs` hashes for `sourceSha256`: `relative path, NUL, bytes, NUL` per input, in path order. */
function sourceIdentity(repoRoot: string, inputs: string[]): string | null {
  const hash = createHash('sha256');
  for (const input of inputs) {
    try {
      hash.update(input).update('\0').update(fs.readFileSync(path.join(repoRoot, input))).update('\0');
    } catch {
      return null;
    }
  }
  return hash.digest('hex');
}

function parseManifest(manifestPath: string): { repoRoot: string; hooks: ManifestHook[] } | null {
  try {
    const raw: unknown = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    if (!raw || typeof raw !== 'object' || !('hooks' in raw) || !Array.isArray(raw.hooks)) return null;
    const repoRoot = 'repoRoot' in raw && typeof raw.repoRoot === 'string' ? raw.repoRoot : '';
    const hooks: ManifestHook[] = [];
    for (const entry of raw.hooks as unknown[]) {
      if (!entry || typeof entry !== 'object') continue;
      const row = entry as Record<string, unknown>;
      if (typeof row.id !== 'string' || typeof row.path !== 'string' || typeof row.sha256 !== 'string') continue;
      hooks.push({
        id: row.id,
        path: row.path,
        sha256: row.sha256,
        ...(Array.isArray(row.inputs) && row.inputs.every((input) => typeof input === 'string') ? { inputs: row.inputs as string[] } : {}),
        ...(typeof row.sourceSha256 === 'string' ? { sourceSha256: row.sourceSha256 } : {}),
      });
    }
    return { repoRoot, hooks };
  } catch {
    return null;
  }
}

function statStamp(file: string): string {
  try {
    const stat = fs.statSync(file);
    return `${stat.mtimeMs}:${stat.size}`;
  } catch {
    return 'absent';
  }
}

let staleHooksCache: { stamp: string; stale: StaleHook[] } | undefined;

/**
 * The OMP hooks whose installed copy drifted, read the way `install-omp-hooks.mjs --check` judges
 * them but without bundling: the installed file against the manifest hash, and (for a manifest the
 * current installer wrote) the repo sources it was bundled from against the install-time source hash.
 * A hook the installer knows but the manifest has no row for (installed before the hook existed, or
 * left out by a single-hook install) is `NOT_INSTALLED`. The answer is cached on the mtime and size of
 * the manifest, the installed files and the sources, so a `terminal.list` call costs a handful of
 * `stat` calls until something changes. An empty list means nothing drifted that can be proven; no
 * manifest at all proves nothing, and a manifest that predates source hashes proves no source drift.
 */
export function installedHooksStale(): StaleHook[] {
  const manifestPath = installedHooksManifestPath();
  const manifest = parseManifest(manifestPath);
  if (!manifest) {
    staleHooksCache = undefined;
    return [];
  }
  const stamp = [
    statStamp(manifestPath),
    ...manifest.hooks.flatMap((hook) => [statStamp(hook.path), ...(hook.inputs ?? []).map((input) => statStamp(path.join(manifest.repoRoot, input)))]),
  ].join('|');
  if (staleHooksCache?.stamp === stamp) return staleHooksCache.stale;
  const stale: StaleHook[] = [];
  for (const hook of manifest.hooks) {
    let installed: Buffer;
    try {
      installed = fs.readFileSync(hook.path);
    } catch {
      stale.push({ id: hook.id, state: 'MISSING', detail: `${hook.path} is not there` });
      continue;
    }
    if (createHash('sha256').update(installed).digest('hex') !== hook.sha256) {
      stale.push({ id: hook.id, state: 'INSTALLED_CHANGED', detail: `${hook.path} differs from what the installer wrote` });
    } else if (hook.inputs && hook.sourceSha256) {
      const now = sourceIdentity(manifest.repoRoot, hook.inputs);
      if (now === null) {
        stale.push({ id: hook.id, state: 'SOURCES_UNREADABLE', detail: `the sources this hook was built from are not readable under ${manifest.repoRoot} (the checkout that installed it moved or was deleted): drift cannot be judged, reinstall from the current checkout` });
      } else if (now !== hook.sourceSha256) {
        stale.push({ id: hook.id, state: 'SOURCE_CHANGED', detail: 'a source file this hook is built from changed after the install' });
      }
    }
  }
  for (const id of OMP_HOOK_IDS) {
    if (!manifest.hooks.some((hook) => hook.id === id)) {
      stale.push({ id, state: 'NOT_INSTALLED', detail: 'the installer manifest has no row for this hook: run node scripts/install-omp-hooks.mjs --install' });
    }
  }
  staleHooksCache = { stamp, stale };
  return stale;
}
