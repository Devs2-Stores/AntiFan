/**
 * Refuses a product launch that would boot on a profile the user did not choose for it.
 *
 * A persistent shell that once exported `ANTIFAN_DATA_ROOT` (or a user-data override) for a
 * throwaway run leaks it into every later `node scripts/run-electron.cjs .`. The instance
 * then boots on that other data root, takes that root's single-instance lock instead of the
 * live app's, and runs beside it as a second, unnoticed AntiFan. Both locks behave as
 * designed; the launch is simply on the wrong profile. Catching it here, before Electron is
 * spawned, names the variable instead of leaving a second instance to be discovered later.
 *
 * Only a product launch (the repository itself as the Electron app) is checked: a script
 * launch is a probe that sets its own isolation. A launch that opts into an alternate root
 * on purpose says so with one of the two markers below.
 */
const path = require('node:path');

/** Variables that move the profile or the data root away from the installation default. */
const DATA_ROOT_VARIABLES = ['ANTIFAN_DATA_ROOT'];
const USER_DATA_VARIABLES = ['ANTIFAN_USER_DATA', 'ANTIFAN_USER_DATA_DIR'];

/** `lane-env.cjs` sets the first; a harness or operator that means it sets the second. */
const ISOLATION_MARKERS = ['ANTIFAN_FAIL_ON_LOCK_CONTENTION', 'ANTIFAN_ALLOW_ALT_DATA_ROOT'];

function normalizeForCompare(value, platform) {
  const resolved = path.resolve(value).replace(/[\\/]+$/, '');
  return platform === 'win32' ? resolved.toLowerCase() : resolved;
}

/**
 * @param {{
 *   env: NodeJS.ProcessEnv | Record<string, string | undefined>,
 *   defaultDataRoot: string | (() => string),
 *   platform?: NodeJS.Platform,
 *   productLaunch: boolean,
 * }} options `defaultDataRoot` may be a function so the (filesystem-probing) default is only
 *   resolved when a variable actually needs comparing.
 * @returns {{ ok: true } | { ok: false, variable: string, value: string, defaultDataRoot: string, message: string }}
 */
function checkInheritedProfile({ env, defaultDataRoot, platform = process.platform, productLaunch }) {
  if (!productLaunch || ISOLATION_MARKERS.some((name) => env[name] === '1')) return { ok: true };

  const present = [...DATA_ROOT_VARIABLES, ...USER_DATA_VARIABLES]
    .filter((name) => typeof env[name] === 'string' && env[name].trim() !== '');
  if (present.length === 0) return { ok: true };

  const defaultRoot = typeof defaultDataRoot === 'function' ? defaultDataRoot() : defaultDataRoot;
  const normalizedDefault = normalizeForCompare(defaultRoot, platform);
  const normalizedDefaultProfile = normalizeForCompare(path.join(defaultRoot, 'Profile'), platform);

  for (const variable of present) {
    const value = env[variable].trim();
    const normalized = normalizeForCompare(value, platform);
    const accepted = DATA_ROOT_VARIABLES.includes(variable)
      ? [normalizedDefault]
      : [normalizedDefault, normalizedDefaultProfile];
    if (accepted.includes(normalized)) continue;
    return {
      ok: false,
      variable,
      value,
      defaultDataRoot: defaultRoot,
      message:
        `[run-electron] refusing to launch: ${variable}=${value} points away from the installation default ` +
        `data root (${defaultRoot}). A launch of the app itself on another profile runs as a second ` +
        'AntiFan beside the live one. Likely an environment variable leaked from an earlier shell session: ' +
        `run \`unset ${variable}\` (PowerShell: \`Remove-Item Env:${variable}\`), or set ` +
        'ANTIFAN_ALLOW_ALT_DATA_ROOT=1 if the alternate root is intentional.',
    };
  }
  return { ok: true };
}

module.exports = { checkInheritedProfile, ISOLATION_MARKERS };
