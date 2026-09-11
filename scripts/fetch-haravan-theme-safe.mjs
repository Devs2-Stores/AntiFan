import fs from 'node:fs';
import path from 'node:path';
import https from 'node:https';

const ORG_ID = '200001207485';
const THEME_ID = '1001512581';
const TARGET_DIR = path.resolve('themes/phukienmaymoc-copy');

const cliData = JSON.parse(fs.readFileSync('C:/Users/Admin/.haravan-cli.json', 'utf8'));
const org = cliData[ORG_ID];
if (!org || !org.access_token) {
  throw new Error(`No access token for org ${ORG_ID}`);
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
  console.log(`[1] Fetching asset list for theme ${THEME_ID}...`);
  const listRes = await apiRequestWithRetry(`/web/themes/${THEME_ID}/assets.json`);
  const assets = listRes.assets || [];
  console.log(`[OK] Found ${assets.length} total assets.`);

  fs.mkdirSync(TARGET_DIR, { recursive: true });
  fs.writeFileSync(
    path.join(TARGET_DIR, '.haravan-cli_local.json'),
    JSON.stringify({ org_id: ORG_ID, theme_id: THEME_ID, theme_name: 'phukienmaymoc-copy' }, null, 2)
  );

  let fetchedCount = 0;
  let skippedCount = 0;
  let failCount = 0;

  for (let i = 0; i < assets.length; i++) {
    const asset = assets[i];
    const destPath = path.join(TARGET_DIR, asset.key);
    if (fs.existsSync(destPath) && fs.statSync(destPath).size > 0) {
      skippedCount++;
      continue;
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
        }
      } else if (asset.public_url) {
        await downloadBinary(asset.public_url, destPath);
        fetchedCount++;
      }
      await new Promise(r => setTimeout(r, 80));
    } catch (err) {
      failCount++;
    }
    process.stdout.write(`\rProgress: ${i + 1}/${assets.length} (fetched: ${fetchedCount}, skipped: ${skippedCount}, fail: ${failCount})`);
  }

  console.log(`\n[DONE] Finished: fetched ${fetchedCount}, skipped ${skippedCount}, failed ${failCount}.`);
}

main().catch(console.error);
