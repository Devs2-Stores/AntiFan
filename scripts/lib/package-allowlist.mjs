// package-allowlist.mjs - what may ship inside the AntiFan Windows package.
//
// The old packager config was a deny-list, so every new private directory at the repo root
// (.super-core, .canary, .claude, .antifan, scratch, ...) shipped by default. This is an allow-list: a path
// is packaged only when it is explicitly listed here.

/** Single files at the app root. */
const ROOT_FILES = new Set(['/package.json', '/main.cjs']);
/** Directories shipped whole (the directory itself and everything below it). */
const ROOT_TREES = ['/scripts', '/node_modules', '/assets', '/packages', '/extension', '/bin', '/.compiled/src'];
/** Directories that only exist to hold an allowed child. */
const ROOT_CONTAINERS = new Set(['/.compiled']);
/** Files inside a container that are allowed. */
const CONTAINER_FILES = new Set(['/.compiled/.tsbuildinfo']);

/** Residual exclusions inside allowed trees (carried over from the deny-list that these trees were filtered by). */
const RESIDUAL_DENY = [
  /^\/node_modules\/node-pty\/prebuilds\/darwin-arm64/,
  /^\/node_modules\/node-pty\/prebuilds\/darwin-x64/,
  /^\/node_modules\/node-pty\/prebuilds\/win32-arm64/,
  /\.pdb$/,
  /\.md$/,
  /\.ts$/,
  /\.map$/,
];

/** Top-level names that hold private data and must never be packaged, listed so the pre-pack guard can check them by name. */
export const PRIVATE_ROOTS = ['.super-core', '.canary', '.claude', '.antifan', '.omp', 'scratch', '.haravan-cli_local.json', '.env', '.scratch', '.tmp', 'themes', 'customizes', 'reports'];

const norm = (p) => `/${String(p).replace(/\\/g, '/').replace(/^\/+/, '')}`.replace(/\/+$/, '');

/** True when the app-relative path (leading "/", as @electron/packager passes it) belongs in the package. */
export function isPackaged(appRelPath) {
  if (appRelPath === '' || appRelPath === '/') return true;
  const p = norm(appRelPath);
  const allowed =
    ROOT_FILES.has(p) ||
    ROOT_CONTAINERS.has(p) ||
    CONTAINER_FILES.has(p) ||
    ROOT_TREES.some((t) => p === t || p.startsWith(`${t}/`) || t.startsWith(`${p}/`));
  return allowed && !RESIDUAL_DENY.some((re) => re.test(p));
}

/** `ignore` option for @electron/packager. */
export const packagerIgnore = (p) => !isPackaged(p);

/**
 * Refuse to package when a private root that exists on disk would be included. Returns the list of offending
 * root names (empty when safe); the caller throws.
 */
export function privateRootsLeaking(rootExists) {
  return PRIVATE_ROOTS.filter((name) => rootExists(name) && isPackaged(`/${name}`));
}

// --- post-pack tree assertion -------------------------------------------------------------------------------

const FORBIDDEN_PATH = [
  /\.db$/i,
  /\.db-(wal|shm)$/i,
  /\.bak$/i,
  /(^|\/)\.env(\.|$)/i,
  /(^|\/)\.antifan\//i,
  /(^|\/)\.canary\//i,
  /(^|\/)\.omp\//i,
  /(^|\/)\.claude\//i,
  /(^|\/)\.super-core\//i,
  /(^|\/)scratch\//i,
  /qa-receipts/i,
  /\.har$/i,
  /\.pem$/i,
  /\.pfx$/i,
  /(^|\/)\.haravan-cli_local\.json$/i,
];
/** `token` / `secret` in a data file name; node_modules and compiled code legitimately contain those words. */
const SECRET_NAME = /(token|secret)[^/]*\.(json|txt|env|log|html|db|bak)$/i;

/** @param {string[]} paths app.asar entries (forward slashes) @returns {string[]} the offending paths */
export function forbiddenInTree(paths) {
  const bad = [];
  for (const raw of paths) {
    const p = raw.replace(/\\/g, '/');
    const inCode = /(^|\/)node_modules\//i.test(p) || /^\/?\.compiled\//i.test(p);
    if (FORBIDDEN_PATH.some((re) => re.test(p)) || (!inCode && SECRET_NAME.test(p))) bad.push(p);
  }
  return bad;
}
