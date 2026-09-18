/**
 * Stage the Terminal Host daemon into a versioned directory outside the dev workspace.
 *
 * Why this exists: a running host holds Windows file locks on the native addons it has loaded. If
 * the host executed out of `apps/AntiFan/`, the next `npm run compile` would fail EBUSY exactly
 * during the dogfooding loop the host is meant to support. Staging into
 * `<dataRoot>/daemon-host/<hash>/` keeps the workspace permanently unlocked, and keying the
 * directory by content hash means a changed bundle lands in a *new* directory while the running
 * host keeps its files — so an upgrade never has to kill live sessions.
 *
 * The staged set is derived, not hardcoded: walk the compiled entry's relative-require closure for
 * local modules, then copy the packages it actually imports.
 *
 * Usage:
 *   node scripts/stage-daemon-host.mjs            # stage, print the resolved root
 *   node scripts/stage-daemon-host.mjs --json     # machine-readable result
 *   node scripts/stage-daemon-host.mjs --prune    # drop every version except the one just built
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const COMPILED = path.join(ROOT, '.compiled');
const ENTRY = path.join(COMPILED, 'src', 'main', 'terminal-daemon', 'daemon-entry.js');

const argv = process.argv.slice(2);
const asJson = argv.includes('--json');
const prune = argv.includes('--prune');

function fail(message) {
  console.error(`[stage-daemon-host] ${message}`);
  process.exit(1);
}

if (!fs.existsSync(ENTRY)) {
  fail(`compiled entry not found: ${ENTRY}\nRun \`npm run compile\` first.`);
}

function resolveDataRoot() {
  if (process.env.ANTIFAN_DATA_ROOT) return path.resolve(process.env.ANTIFAN_DATA_ROOT);
  for (const candidate of ['E:\\Work\\.antifan-data', 'E:\\.antifan-data', 'D:\\Work\\.antifan-data']) {
    if (fs.existsSync(path.dirname(candidate))) return candidate;
  }
  const home = os.homedir();
  if (home && fs.existsSync(home)) {
    return path.join(home, '.antifan-data');
  }
  return path.join(os.tmpdir(), '.antifan-data');
}

/**
 * The daemon's own Node builtins and bare package specifiers, read straight from the source text.
 * Type-only imports (erased at compile time) do not survive into the emitted JS, so scanning the
 * compiled output rather than the TypeScript is what keeps the closure honest.
 */
function specifiersIn(file) {
  const source = fs.readFileSync(file, 'utf8');
  const specs = new Set();
  const patterns = [
    /\brequire\(\s*['"]([^'"]+)['"]\s*\)/g,
    /\bfrom\s*['"]([^'"]+)['"]/g,
    /\bimport\(\s*['"]([^'"]+)['"]\s*\)/g,
  ];
  for (const pattern of patterns) {
    let match;
    while ((match = pattern.exec(source))) specs.add(match[1]);
  }
  return [...specs];
}

function isBuiltin(spec) {
  return spec.startsWith('node:') || /^(fs|path|os|http|https|net|tls|crypto|events|stream|url|util|zlib|child_process|worker_threads|timers|assert|buffer|string_decoder|readline|tty|perf_hooks|process|v8|module|querystring|dns|cluster)$/.test(spec);
}

/** Package name for a bare specifier: `@scope/pkg/sub` -> `@scope/pkg`, `ws/lib/x` -> `ws`. */
function packageNameOf(spec) {
  const parts = spec.split('/');
  return spec.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0];
}

/** Collect the compiled local modules reachable from the entry, plus the packages they import. */
function buildClosure(entryFile) {
  const local = new Set();
  const packages = new Set();
  const queue = [entryFile];
  const seen = new Set();

  while (queue.length) {
    const file = queue.pop();
    if (seen.has(file) || !fs.existsSync(file)) continue;
    seen.add(file);
    local.add(file);

    for (const spec of specifiersIn(file)) {
      if (isBuiltin(spec)) continue;
      if (spec.startsWith('.')) {
        const base = path.resolve(path.dirname(file), spec);
        for (const candidate of [`${base}.js`, path.join(base, 'index.js'), base]) {
          if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
            queue.push(candidate);
            break;
          }
        }
        continue;
      }
      packages.add(packageNameOf(spec));
    }
  }
  return { local: [...local].sort(), packages: [...packages].sort() };
}

/**
 * node-pty's loader probes `build/Release`, `build/Debug`, then `prebuilds/<platform>-<arch>`, and
 * its ConPTY path additionally needs `conpty/conpty.dll` + `conpty/OpenConsole.exe` beside the
 * addon. Debug symbols (`*.pdb`, ~28 MB) are never loaded at runtime and are skipped.
 */
function nodePtyPayload(pkgDir) {
  const wanted = [];
  const add = (abs) => { if (fs.existsSync(abs)) wanted.push(abs); };

  add(path.join(pkgDir, 'package.json'));
  for (const name of ['index.js', 'utils.js', 'windowsTerminal.js', 'windowsPtyAgent.js',
    'windowsConoutConnection.js', 'conpty_console_list_agent.js', 'eventEmitter2.js',
    'terminal.js', 'interfaces.js', 'types.js', 'worker/conoutSocketWorker.js',
    'shared/conout.js']) {
    add(path.join(pkgDir, 'lib', name));
  }

  const prebuildDir = path.join(pkgDir, 'prebuilds', `${process.platform}-${process.arch}`);
  add(path.join(prebuildDir, 'pty.node'));
  add(path.join(prebuildDir, 'conpty.node'));
  add(path.join(prebuildDir, 'conpty_console_list.node'));
  add(path.join(prebuildDir, 'winpty.dll'));
  add(path.join(prebuildDir, 'winpty-agent.exe'));
  add(path.join(prebuildDir, 'conpty', 'conpty.dll'));
  add(path.join(prebuildDir, 'conpty', 'OpenConsole.exe'));
  return wanted;
}

/** Runtime payload for a pure-JS package: everything but docs, tests, source maps, and TypeScript. */
function packagePayload(pkgDir) {
  const skipDirs = new Set(['test', 'tests', '__tests__', 'docs', 'example', 'examples', 'coverage', '.github']);
  const wanted = [];

  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const abs = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (skipDirs.has(entry.name)) continue;
        walk(abs);
      } else if (!/\.(md|map|ts|tsbuildinfo|pdb|flow)$/i.test(entry.name)) {
        wanted.push(abs);
      }
    }
  };

  walk(pkgDir);
  return wanted;
}

const dataRoot = resolveDataRoot();
const closure = buildClosure(ENTRY);

if (!closure.local.includes(ENTRY)) fail('entry missing from its own closure');

const nodePtyDir = path.join(ROOT, 'node_modules', 'node-pty');
if (!fs.existsSync(nodePtyDir)) fail('node-pty not installed');

const payload = new Map(); // absolute source -> destination relative to the staged root

for (const file of closure.local) {
  payload.set(file, path.relative(COMPILED, file));
}

for (const name of closure.packages) {
  const pkgDir = path.join(ROOT, 'node_modules', name);
  if (!fs.existsSync(pkgDir)) fail(`package '${name}' required by the daemon is not installed`);
  const files = name === 'node-pty' ? nodePtyPayload(pkgDir) : packagePayload(pkgDir);
  if (!files.length) fail(`package '${name}' produced an empty payload`);
  for (const file of files) {
    payload.set(file, path.join('node_modules', name, path.relative(pkgDir, file)));
  }
}

/**
 * Hash every byte that will be staged, plus the staging layout itself. Directory names are part of
 * the hash so that a change in *where* a file lands is a new version even when contents match.
 */
const hasher = crypto.createHash('sha256');
for (const [source, dest] of [...payload.entries()].sort((a, b) => (a[1] < b[1] ? -1 : 1))) {
  hasher.update(`${dest}\u0000`);
  hasher.update(fs.readFileSync(source));
}
const versionHash = hasher.digest('hex').slice(0, 16);

const hostRoot = path.join(dataRoot, 'daemon-host');
const stageDir = path.join(hostRoot, versionHash);

fs.mkdirSync(stageDir, { recursive: true });

let written = 0;
let bytes = 0;
const sameBytes = (a, b) => {
  const ha = crypto.createHash('sha256').update(fs.readFileSync(a)).digest('hex');
  const hb = crypto.createHash('sha256').update(fs.readFileSync(b)).digest('hex');
  return ha === hb;
};
for (const [source, dest] of payload) {
  const target = path.join(stageDir, dest);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  // The version directory is content-addressed, so a target with identical bytes is already the
  // file this run would write. Skipping the rewrite is what makes re-staging a live version
  // possible on Windows: a running host keeps `pty.node` loaded, and a loaded addon cannot be
  // replaced — the rename would fail with EPERM against a bundle that is already correct.
  let current;
  try {
    current = fs.statSync(target);
  } catch {
    current = null;
  }
  if (current && current.size === fs.statSync(source).size && sameBytes(source, target)) {
    written++;
    bytes += current.size;
    continue;
  }
  // Copy through a temp name so a concurrently-starting host never loads a half-written addon.
  const tmp = `${target}.staging-${process.pid}`;
  fs.copyFileSync(source, tmp);
  fs.renameSync(tmp, target);
  written++;
  bytes += fs.statSync(target).size;
}

const entryRelative = path.relative(COMPILED, ENTRY).replace(/\\/g, '/');

const manifest = {
  version: versionHash,
  stagedAt: new Date().toISOString(),
  entry: entryRelative,
  files: written,
  bytes,
  packages: closure.packages,
  localModules: closure.local.length,
  platform: `${process.platform}-${process.arch}`,
};
fs.writeFileSync(path.join(stageDir, 'staged-manifest.json'), JSON.stringify(manifest, null, 2));

// The `current` pointer is published only after the directory is complete, so a reader either sees
// the previous complete version or this one — never a partial tree.
const currentPointer = path.join(hostRoot, 'current.json');
const pointerTmp = `${currentPointer}.${process.pid}.tmp`;
fs.writeFileSync(pointerTmp, JSON.stringify({ version: versionHash, dir: stageDir, entry: path.join(stageDir, manifest.entry) }, null, 2));
fs.renameSync(pointerTmp, currentPointer);

let pruned = [];
if (prune) {
  for (const entry of fs.readdirSync(hostRoot, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name === versionHash) continue;
    fs.rmSync(path.join(hostRoot, entry.name), { recursive: true, force: true });
    pruned.push(entry.name);
  }
}

const result = {
  version: versionHash,
  stageDir,
  entry: path.join(stageDir, manifest.entry),
  files: written,
  bytes,
  packages: closure.packages,
  pruned,
  dataRoot,
};

if (asJson) {
  console.log(JSON.stringify(result, null, 2));
} else {
  console.log(`[stage-daemon-host] version=${versionHash} files=${written} (${(bytes / 1024).toFixed(0)} KB)`);
  console.log(`[stage-daemon-host] entry=${result.entry}`);
  console.log(`[stage-daemon-host] packages=${closure.packages.join(', ') || '(none)'}`);
  if (pruned.length) console.log(`[stage-daemon-host] pruned=${pruned.join(', ')}`);
}
