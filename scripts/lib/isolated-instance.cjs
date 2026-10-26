'use strict';
/**
 * A throwaway AntiFan world for probes that boot the shipping main process: a temp data root,
 * config dir and Chromium profile, a seeded capsule registry, and its own bridge port.
 *
 * Why it exists: restarting the live app to try a change breaks every other project's work that
 * runs through it, so a change that needs a real main process is tried in one of these instead.
 * Nothing seeded here can read or write the developer's real profile, data root or capsules.
 *
 * `createIsolatedInstance` mutates `process.env` of the CALLING process (the Electron process
 * that is about to require the compiled `index.js`), so it must run before that require: the
 * main process reads these variables at import. A probe launched from an AntiFan terminal
 * inherits that terminal's ANTIFAN_* variables; every one the app reads for storage is pinned
 * here so none of the inherited values can leak the real config into the run.
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const REQUIRED_PROJECT_FIELDS = ['name', 'projectId', 'workspaceId', 'capsuleId', 'dir'];

/**
 * @param {object} options
 * @param {string} options.prefix temp directory prefix, e.g. `antifan-quit-probe-`
 * @param {Array<{name:string, projectId:string, workspaceId:string, capsuleId:string, dir:string}>} options.projects
 *   One entry per project; `dir` is the folder name created under the temp root. The first
 *   entry is the boot project (its ids are exported as ANTIFAN_PROJECT_ID / ANTIFAN_WORKSPACE_ID).
 * @param {number} options.bridgePortBase first port of the range the bridge port is picked from
 * @param {number} options.bridgePortSpan size of that range; the port is `base + (pid % span)`
 * @param {boolean} [options.terminalDaemon=false] route terminals through the detached daemon host.
 *   Off by default: the daemon is built to outlive the GUI and would be left running on the machine.
 * @param {boolean} [options.pinWorkspaceRoot=false] export the boot project's folder as
 *   ANTIFAN_WORKSPACE_ROOT (the control plane reads its authoritative root from there)
 * @param {NodeJS.ProcessEnv} [options.env=process.env] environment to pin (a test passes its own object)
 * @returns {{tempRoot:string, configDir:string, userDataDir:string, bridgePort:number,
 *   projects:Array<object>, dispose:() => void}}
 */
function createIsolatedInstance(options) {
  const { prefix, projects, bridgePortBase, bridgePortSpan, terminalDaemon = false, pinWorkspaceRoot = false, env = process.env } = options || {};
  if (typeof prefix !== 'string' || prefix.length === 0) throw new TypeError('createIsolatedInstance: prefix is required');
  if (!Array.isArray(projects) || projects.length === 0) throw new TypeError('createIsolatedInstance: at least one project is required');
  if (!Number.isInteger(bridgePortBase) || !Number.isInteger(bridgePortSpan) || bridgePortSpan < 1) {
    throw new TypeError('createIsolatedInstance: bridgePortBase and a positive bridgePortSpan are required');
  }
  for (const project of projects) {
    for (const field of REQUIRED_PROJECT_FIELDS) {
      if (typeof project?.[field] !== 'string' || project[field].length === 0) {
        throw new TypeError(`createIsolatedInstance: project.${field} is required`);
      }
    }
  }

  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const configDir = path.join(tempRoot, 'config');
  const userDataDir = path.join(tempRoot, 'Profile');
  const bridgePort = bridgePortBase + (process.pid % bridgePortSpan);

  const resolved = projects.map(({ dir, ...project }) => {
    const folder = path.join(tempRoot, dir);
    fs.mkdirSync(folder, { recursive: true });
    return { ...project, path: folder };
  });
  const boot = resolved[0];

  env.ANTIFAN_DATA_ROOT = tempRoot;
  env.ANTIFAN_CONFIG_DIR = configDir;
  env.ANTIFAN_USER_DATA = userDataDir;
  env.ANTIFAN_USER_DATA_DIR = userDataDir;
  env.ANTIFAN_PROJECT_ID = boot.projectId;
  env.ANTIFAN_WORKSPACE_ID = boot.workspaceId;
  env.ANTIFAN_USE_TERMINAL_DAEMON = terminalDaemon ? '1' : '0';
  env.ANTIFAN_BRIDGE_PORT = String(bridgePort);
  if (pinWorkspaceRoot) env.ANTIFAN_WORKSPACE_ROOT = boot.path;

  fs.mkdirSync(configDir, { recursive: true });
  const now = Date.now();
  fs.writeFileSync(
    path.join(configDir, 'workspace-capsules.json'),
    JSON.stringify({
      version: 1,
      activeCapsuleId: boot.capsuleId,
      capsules: resolved.map((entry) => ({
        id: entry.capsuleId,
        name: entry.name,
        workspacePath: entry.path,
        state: {},
        createdAt: now,
        updatedAt: now,
        projectId: entry.projectId,
        workspaceId: entry.workspaceId,
        migrationMarker: 'explicit',
      })),
    }, null, 2),
    'utf8',
  );

  return {
    tempRoot,
    configDir,
    userDataDir,
    bridgePort,
    projects: resolved,
    /** Remove the whole throwaway world. Never throws: it runs on the way out of a failed probe. */
    dispose() {
      try { fs.rmSync(tempRoot, { recursive: true, force: true }); } catch {}
    },
  };
}

module.exports = { createIsolatedInstance };
