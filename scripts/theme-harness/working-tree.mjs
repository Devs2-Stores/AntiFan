/**
 * L2 — working-tree truth (gated).
 *
 * The only tier that proves the local `Storefront/` tree: the working tree must
 * be pushed to a user-approved UNPUBLISHED theme (the bound theme is the live
 * `main` theme and `hrv theme push` refuses it fail-closed), synced by a
 * running `hrv theme dev` watcher, then measured through the same live suite
 * as L1 against `?themeid=<devId>`.
 *
 * This module never pushes. `haravan theme push*` is forbidden without explicit
 * user approval, so the layer evaluates its prerequisites and reports BLOCKED
 * with each missing one named. When every prerequisite is satisfied the gate
 * opens and the L1 suite runs against the dev theme id — measurement itself is
 * read-only.
 *
 * Prerequisites:
 *   unpublished-theme-id — HARAVAN_DEV_THEME_ID=<numeric id>, distinct from the
 *     bound live theme (pushing to `main` is refused by the CLI role gate).
 *   user-approval — HARAVAN_THEME_PUSH_APPROVED=1 recorded in the environment
 *     of the run (the operator's explicit approval for the remote mutation the
 *     watcher already performed).
 *   watcher-active — <themeDir>/.hrv-sync-state.json exists: the marker a bound
 *     `hrv theme dev` watcher maintains (fetch-haravan-theme-safe.mjs refuses
 *     to write a dir carrying it). In-app upload attestation is the
 *     haravan-sync-barrier's job inside the QA workflow; the harness gate only
 *     requires the watcher binding to exist.
 */
import fs from 'node:fs';
import path from 'node:path';
import { runLivePublished } from './live-published.mjs';
import { LAYERS, blockedVerdict } from './verdict.mjs';

const TIER = 'WORKING_TREE';
export const WATCH_STATE_FILE = '.hrv-sync-state.json';
export const ENV_DEV_THEME_ID = 'HARAVAN_DEV_THEME_ID';
export const ENV_PUSH_APPROVED = 'HARAVAN_THEME_PUSH_APPROVED';

const LIMITS = Object.freeze([
  'requires a real remote mutation (push to an unpublished theme) — never simulated',
  'a WORKING_TREE verdict is only as fresh as the watcher sync; the marker proves a watcher is bound, not that the last edit uploaded',
]);

/**
 * Evaluate the L2 gate without running anything.
 * @param {{ themeDir: string, liveThemeId: string|null, env?: NodeJS.ProcessEnv }} input
 * @returns {{ open: boolean, devThemeId: string|null, prerequisites: Array<{id:string, satisfied:boolean, detail:string}> }}
 */
export function evaluateWorkingTreeGate({ themeDir, liveThemeId, env = process.env }) {
  const prerequisites = [];

  const rawDevId = env[ENV_DEV_THEME_ID];
  const devThemeId = typeof rawDevId === 'string' && /^\d+$/.test(rawDevId.trim()) ? rawDevId.trim() : null;
  const devIsLive = devThemeId !== null && liveThemeId !== null && devThemeId === String(liveThemeId);
  prerequisites.push({
    id: 'unpublished-theme-id',
    satisfied: devThemeId !== null && !devIsLive,
    detail: devThemeId === null
      ? `${ENV_DEV_THEME_ID} is not set to a numeric unpublished theme id`
      : devIsLive
        ? `${ENV_DEV_THEME_ID}=${devThemeId} is the bound live theme — pushing to main is refused`
        : `${ENV_DEV_THEME_ID}=${devThemeId}`,
  });

  const approved = env[ENV_PUSH_APPROVED] === '1';
  prerequisites.push({
    id: 'user-approval',
    satisfied: approved,
    detail: approved
      ? `${ENV_PUSH_APPROVED}=1 recorded`
      : `${ENV_PUSH_APPROVED}=1 required — haravan theme push* is forbidden without explicit user approval`,
  });

  const watchStatePath = path.join(themeDir, WATCH_STATE_FILE);
  const watcherActive = fs.existsSync(watchStatePath);
  prerequisites.push({
    id: 'watcher-active',
    satisfied: watcherActive,
    detail: watcherActive
      ? `${WATCH_STATE_FILE} present — an hrv theme dev watcher is bound to this tree`
      : `${WATCH_STATE_FILE} absent — no hrv theme dev watcher is bound to ${themeDir}`,
  });

  return {
    open: prerequisites.every((p) => p.satisfied),
    devThemeId: devThemeId !== null && !devIsLive ? devThemeId : null,
    prerequisites,
  };
}

/**
 * Run L2: gate evaluation, then the L1 suite against the dev theme when open.
 * @param {{ client: object|null, binding: object, repoRoot: string,
 *   themeDir: string, evidenceDir: string, bridge?: object|null,
 *   env?: NodeJS.ProcessEnv }} input
 */
export async function runWorkingTree({ client, binding, repoRoot, themeDir, evidenceDir, bridge = null, env = process.env }) {
  const gate = evaluateWorkingTreeGate({ themeDir, liveThemeId: binding?.themeId, env });
  const checks = { prerequisites: gate.prerequisites };

  if (!gate.open) {
    return blockedVerdict(
      LAYERS.L2,
      'BLOCKED',
      gate.prerequisites.filter((p) => !p.satisfied).map((p) => `${p.id}: ${p.detail}`),
      {
        checks,
        limits: [...LIMITS],
        notes: ['satisfy every prerequisite, then re-run: the layer executes the L1 suite against ?themeid=<devId>'],
      },
    );
  }

  if (!client || typeof client.callTool !== 'function') {
    return blockedVerdict(LAYERS.L2, 'BLOCKED', ['live-bridge: gate is open but no AntiFan Desktop bridge client was supplied'], {
      checks,
      limits: [...LIMITS],
    });
  }

  const devBinding = { ...binding, themeId: gate.devThemeId };
  const verdict = await runLivePublished({
    client,
    binding: devBinding,
    repoRoot,
    themeDir,
    evidenceDir,
    bridge,
    tier: TIER,
    layer: LAYERS.L2,
  });
  verdict.checks.prerequisites = gate.prerequisites;
  verdict.notes.push(`measured against dev theme ${gate.devThemeId} — the working tree as the watcher last synced it`);
  return verdict;
}
