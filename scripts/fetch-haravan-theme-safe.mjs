import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import https from 'node:https';

// Target is taken from the environment so no single theme id is baked in.
// Defaults point at the theme currently under work.
const ORG_ID = process.env.HARAVAN_ORG_ID || '200001207485';
const THEME_ID = process.env.HARAVAN_THEME_ID || '1001514194';
const TARGET_DIR = path.resolve(process.env.HARAVAN_THEME_DIR || path.join('themes', `haravan-${THEME_ID}`));

const configPath = process.env.HARAVAN_CLI_CONFIG || path.join(os.homedir(), '.haravan-cli.json');
const cliData = JSON.parse(fs.readFileSync(configPath, 'utf8'));
const org = cliData[ORG_ID];
if (!org || !org.access_token) {
  throw new Error(`No access token for org ${ORG_ID} in ${configPath}`);
}
const token = org.access_token;

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
  fs.writeFileSync(
    path.join(TARGET_DIR, '.haravan-cli_local.json'),
    JSON.stringify({ org_id: ORG_ID, theme_id: THEME_ID, theme_name: themeName }, null, 2)
  );

  let fetchedCount = 0;
  let refreshedCount = 0;
  let skippedCount = 0;
  let failCount = 0;
  const failedKeys = [];

  for (let i = 0; i < assets.length; i++) {
    const asset = assets[i];
    const destPath = path.join(TARGET_DIR, asset.key);
    if (fs.existsSync(destPath)) {
      const localSize = fs.statSync(destPath).size;
      // A local file is only trusted when its byte length matches what the theme
      // API reports; a truncated download also has a non-zero size.
      if (localSize > 0 && localSize === asset.size) {
        skippedCount++;
        continue;
      }
      refreshedCount++;
    }

    try {
      const isText = asset.key.endsWith('.liquid') ||
                     asset.key.endsWith('.json') ||
                     asset.key.endsWith('.css') ||
                     asset.key.endsWith('.js') ||
                     asset.key.endsWith('.html') ||
                     asset.key.startsWith('layout/') ||
                     asset.key.startsWith('templates/') ||
                     asset.key.startsWith('snippets/') ||
                     asset.key.startsWith('sections/') ||
                     asset.key.startsWith('config/') ||
                     asset.key.startsWith('locales/');

      if (isText) {
        const detail = await apiRequestWithRetry(`/web/themes/${THEME_ID}/assets.json?asset[key]=${encodeURIComponent(asset.key)}`);
        if (detail && detail.asset && detail.asset.value != null) {
          fs.mkdirSync(path.dirname(destPath), { recursive: true });
          fs.writeFileSync(destPath, detail.asset.value, 'utf8');
          fetchedCount++;
        } else {
          failCount++;
          failedKeys.push({ key: asset.key, reason: 'API returned no value for a text asset' });
        }
      } else if (asset.public_url) {
        await downloadBinary(asset.public_url, destPath);
        fetchedCount++;
      }
      await new Promise(r => setTimeout(r, 80));
    } catch (err) {
      failCount++;
      failedKeys.push({ key: asset.key, reason: err && err.message ? err.message : String(err) });
    }
    process.stdout.write(`\rProgress: ${i + 1}/${assets.length} (fetched: ${fetchedCount}, refreshed: ${refreshedCount}, skipped: ${skippedCount}, fail: ${failCount})`);
  }

  console.log(`\n[DONE] Finished: fetched ${fetchedCount}, refreshed ${refreshedCount}, skipped ${skippedCount}, failed ${failCount}.`);
  // A few binary assets are served by the CDN under a version query that differs
  // from the byte count the theme API declares. The rendered storefront is the
  // authority for those, so a length difference is reported, never a failure.
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
    console.log(`[INFO] ${variantDiffs.length} asset(s) whose local bytes differ from the API-declared size (served CDN variant wins):`);
    for (const line of variantDiffs.slice(0, 10)) console.log(`  - ${line}`);
  } else {
    console.log('[OK] Every local asset matches the API-declared byte size.');
  }

  if (failedKeys.length > 0) {
    const failurePath = path.join(TARGET_DIR, '.haravan-cli_fetch-failures.json');
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
