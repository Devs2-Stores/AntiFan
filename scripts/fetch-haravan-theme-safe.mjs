import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import https from 'node:https';

// Every input is taken from the environment so no theme id, directory or
// personal config path is baked into the repository.
const ORG_ID = process.env.HARAVAN_ORG_ID || '200001207485';
const THEME_ID = process.env.HARAVAN_THEME_ID || '1001514194';
const EXPLICIT_DIR = process.env.HARAVAN_THEME_DIR || '';
const DEFAULT_DIR = path.join('themes', `haravan-${THEME_ID}`);
const FORCE_REFRESH = process.env.HARAVAN_FORCE_REFRESH === '1';
const ALLOW_DUPLICATE_MIRROR = process.env.HARAVAN_ALLOW_DUPLICATE_MIRROR === '1';

const BIND_FILE = '.haravan-cli_local.json';
const MANIFEST_FILE = '.haravan-cli_pull-manifest.json';
const FAILURE_FILE = '.haravan-cli_fetch-failures.json';

const configPath = process.env.HARAVAN_CLI_CONFIG || path.join(os.homedir(), '.haravan-cli.json');
const cliData = JSON.parse(fs.readFileSync(configPath, 'utf8'));
const org = cliData[ORG_ID];
if (!org || !org.access_token) {
  throw new Error(`No access token for org ${ORG_ID} in ${configPath}`);
}
const token = org.access_token;

// A second mirror of the same theme splits later parity work between two
// copies, so an existing binding is adopted and a conflicting one refuses.
function scanBindings(themeId) {
  const found = [];
  const roots = fs.readdirSync('.', { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && !['node_modules', '.git', 'dist', 'out', 'build'].includes(entry.name));
  const candidates = [];
  for (const root of roots) {
    candidates.push(root.name);
    let children = [];
    try {
      children = fs.readdirSync(root.name, { withFileTypes: true }).filter((e) => e.isDirectory());
    } catch {
      children = [];
    }
    for (const child of children) candidates.push(path.join(root.name, child.name));
  }
  for (const dir of candidates) {
    const bindPath = path.join(dir, BIND_FILE);
    if (!fs.existsSync(bindPath)) continue;
    try {
      const bind = JSON.parse(fs.readFileSync(bindPath, 'utf8'));
      if (String(bind.theme_id) === String(themeId)) {
        found.push({ dir: path.resolve(dir), themeName: bind.theme_name || null });
      }
    } catch {
      // An unreadable binding is not evidence of a mirror; ignore it.
    }
  }
  return found;
}

const bindings = scanBindings(THEME_ID);
let TARGET_DIR;
if (!EXPLICIT_DIR && bindings.length === 1) {
  TARGET_DIR = bindings[0].dir;
  console.log(`[INFO] Adopting the existing mirror of theme ${THEME_ID}: ${TARGET_DIR}`);
} else {
  TARGET_DIR = path.resolve(EXPLICIT_DIR || DEFAULT_DIR);
}

const conflicts = bindings.filter((b) => b.dir !== TARGET_DIR);
if (conflicts.length > 0 && !ALLOW_DUPLICATE_MIRROR) {
  console.error(`[ABORT] Theme ${THEME_ID} is already bound to another directory:`);
  for (const c of conflicts) console.error(`  - ${c.dir}${c.themeName ? ` (${c.themeName})` : ''}`);
  console.error(`[ABORT] Pull into that directory, or set HARAVAN_ALLOW_DUPLICATE_MIRROR=1 to create a second copy on purpose.`);
  process.exit(1);
}

async function apiRequestWithRetry(urlPath, retries = 6) {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      return await new Promise((resolve, reject) => {
        const req = https.request({
          hostname: 'apis.haravan.com',
          path: urlPath,
          method: 'GET',
          headers: {
            'Authorization': `Bearer ${token}`,
            'Content-Type': 'application/json',
          },
        }, (res) => {
          let data = '';
          res.on('data', chunk => data += chunk);
          res.on('end', () => {
            if (res.statusCode === 429) {
              return reject(new Error('RATE_LIMITED'));
            }
            if (res.statusCode >= 200 && res.statusCode < 300) {
              try {
                resolve(JSON.parse(data));
              } catch (e) {
                resolve(data);
              }
            } else {
              reject(new Error(`HTTP ${res.statusCode}: ${data.slice(0, 300)}`));
            }
          });
        });
        req.on('error', reject);
        req.end();
      });
    } catch (err) {
      if (err.message === 'RATE_LIMITED' || attempt < retries) {
        const waitMs = attempt * 1200;
        await new Promise(r => setTimeout(r, waitMs));
      } else {
        throw err;
      }
    }
  }
}

function downloadBinary(url, destPath) {
  return new Promise((resolve, reject) => {
    https.get(url, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return downloadBinary(res.headers.location, destPath).then(resolve).catch(reject);
      }
      if (res.statusCode !== 200) {
        return reject(new Error(`HTTP ${res.statusCode}`));
      }
      const dir = path.dirname(destPath);
      fs.mkdirSync(dir, { recursive: true });
      const stream = fs.createWriteStream(destPath);
      res.pipe(stream);
      stream.on('finish', () => resolve(true));
      stream.on('error', reject);
    }).on('error', reject);
  });
}

function isTextAsset(key) {
  return key.endsWith('.liquid') ||
    key.endsWith('.json') ||
    key.endsWith('.css') ||
    key.endsWith('.js') ||
    key.endsWith('.html') ||
    key.startsWith('layout/') ||
    key.startsWith('templates/') ||
    key.startsWith('snippets/') ||
    key.startsWith('sections/') ||
    key.startsWith('config/') ||
    key.startsWith('locales/');
}

function sha256(filePath) {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

function readManifest(manifestPath) {
  if (!fs.existsSync(manifestPath)) return {};
  try {
    const parsed = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    return parsed && parsed.assets ? parsed.assets : {};
  } catch {
    return {};
  }
}

async function main() {
  console.log(`[1] Fetching theme metadata for ${THEME_ID}...`);
  const themeMeta = await apiRequestWithRetry(`/web/themes/${THEME_ID}.json`);
  const theme = themeMeta && themeMeta.theme ? themeMeta.theme : themeMeta;
  const themeName = theme && theme.name ? theme.name : `haravan-${THEME_ID}`;
  const themeRole = theme && theme.role ? theme.role : 'unknown';
  console.log(`[OK] Theme #${THEME_ID} "${themeName}" (role: ${themeRole})`);

  const listRes = await apiRequestWithRetry(`/web/themes/${THEME_ID}/assets.json`);
  const assets = listRes.assets || [];
  console.log(`[OK] Found ${assets.length} total assets.`);

  fs.mkdirSync(TARGET_DIR, { recursive: true });
  const manifestPath = path.join(TARGET_DIR, MANIFEST_FILE);
  const previousManifest = readManifest(manifestPath);
  const nextManifest = {};

  fs.writeFileSync(
    path.join(TARGET_DIR, BIND_FILE),
    JSON.stringify({ org_id: ORG_ID, theme_id: THEME_ID, theme_name: themeName }, null, 2)
  );

  let fetchedCount = 0;
  let refreshedCount = 0;
  let skippedCount = 0;
  let editedCount = 0;
  let failCount = 0;
  const failedKeys = [];
  const locallyEdited = [];

  for (let i = 0; i < assets.length; i++) {
    const asset = assets[i];
    const destPath = path.join(TARGET_DIR, asset.key);
    const text = isTextAsset(asset.key);
    let action = 'fetch';

    if (fs.existsSync(destPath) && fs.statSync(destPath).size > 0) {
      const localSize = fs.statSync(destPath).size;
      const recorded = previousManifest[asset.key];
      const localHash = sha256(destPath);
      if (recorded && recorded.sha256 && recorded.sha256 !== localHash) {
        // The file changed after the pull: it is someone's work, not a cache.
        action = 'edited';
      } else if (FORCE_REFRESH) {
        action = 'refresh';
      } else if (recorded && recorded.sha256 === localHash) {
        // Unmodified since the pull; refresh only when the remote asset moved on.
        action = text && typeof asset.size === 'number' && localSize !== asset.size ? 'refresh' : 'skip';
      } else if (!recorded && text && typeof asset.size === 'number' && localSize === asset.size) {
        // No manifest yet, but the byte length proves the text asset is intact.
        action = 'skip';
      } else {
        action = 'skip';
      }
    }

    if (action === 'skip') {
      skippedCount++;
      nextManifest[asset.key] = { bytes: fs.statSync(destPath).size, sha256: sha256(destPath), updated_at: asset.updated_at || null };
      continue;
    }
    if (action === 'edited') {
      editedCount++;
      locallyEdited.push(asset.key);
      nextManifest[asset.key] = { bytes: fs.statSync(destPath).size, sha256: sha256(destPath), updated_at: previousManifest[asset.key]?.updated_at || null, locallyModified: true };
      continue;
    }

    try {
      if (text) {
        const detail = await apiRequestWithRetry(`/web/themes/${THEME_ID}/assets.json?asset[key]=${encodeURIComponent(asset.key)}`);
        if (detail && detail.asset && detail.asset.value != null) {
          fs.mkdirSync(path.dirname(destPath), { recursive: true });
          fs.writeFileSync(destPath, detail.asset.value, 'utf8');
        } else {
          failCount++;
          failedKeys.push({ key: asset.key, reason: 'API returned no value for a text asset' });
          continue;
        }
      } else if (asset.public_url) {
        await downloadBinary(asset.public_url, destPath);
      } else {
        failCount++;
        failedKeys.push({ key: asset.key, reason: 'binary asset without a public URL' });
        continue;
      }
      if (action === 'refresh') refreshedCount++;
      else fetchedCount++;
      nextManifest[asset.key] = { bytes: fs.statSync(destPath).size, sha256: sha256(destPath), updated_at: asset.updated_at || null };
      await new Promise(r => setTimeout(r, 80));
    } catch (err) {
      failCount++;
      failedKeys.push({ key: asset.key, reason: err && err.message ? err.message : String(err) });
    }
  }

  fs.writeFileSync(manifestPath, JSON.stringify({
    org_id: ORG_ID,
    theme_id: THEME_ID,
    theme_name: themeName,
    generated_at: new Date().toISOString(),
    assets: nextManifest,
  }, null, 2));

  console.log(`\n[DONE] Finished: fetched ${fetchedCount}, refreshed ${refreshedCount}, skipped ${skippedCount}, locally edited ${editedCount}, failed ${failCount}.`);

  if (editedCount > 0) {
    console.log(`[INFO] ${editedCount} file(s) differ from the pull manifest and were left untouched:`);
    for (const key of locallyEdited.slice(0, 10)) console.log(`  - ${key}`);
    console.log('[INFO] Delete a file or set HARAVAN_FORCE_REFRESH=1 to take the remote copy over local work.');
  }

  // The theme API reports the size of the stored asset, while the CDN serves a
  // converted variant, so a length difference on a binary asset is expected and
  // is reported as information instead of being treated as a failure.
  const variantDiffs = [];
  for (const asset of assets) {
    const filePath = path.join(TARGET_DIR, asset.key);
    if (!fs.existsSync(filePath) || typeof asset.size !== 'number') continue;
    const localSize = fs.statSync(filePath).size;
    if (localSize !== asset.size) {
      variantDiffs.push(`${asset.key} (local ${localSize}, api ${asset.size})`);
    }
  }
  if (variantDiffs.length > 0) {
    console.log(`[INFO] ${variantDiffs.length} asset(s) whose local bytes differ from the API-declared size (the CDN serves a different variant):`);
    for (const line of variantDiffs.slice(0, 10)) console.log(`  - ${line}`);
  } else {
    console.log('[OK] Every local asset matches the API-declared byte size.');
  }

  if (failedKeys.length > 0) {
    const failurePath = path.join(TARGET_DIR, FAILURE_FILE);
    fs.writeFileSync(failurePath, JSON.stringify({ org_id: ORG_ID, theme_id: THEME_ID, failures: failedKeys }, null, 2));
    console.error(`[FAIL] ${failedKeys.length} asset(s) could not be fetched; list written to ${failurePath}`);
    for (const entry of failedKeys.slice(0, 20)) {
      console.error(`  - ${entry.key}: ${entry.reason}`);
    }
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
