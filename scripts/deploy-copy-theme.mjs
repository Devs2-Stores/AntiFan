import fs from 'node:fs';
import path from 'node:path';
import https from 'node:https';

const TARGET_THEME_ID = 1001512581;
const PROTECTED_LIVE_THEME_ID = 1001510509;
const ORG_ID = '200001207485';
const THEME_DIR = path.resolve('themes/phukienmaymoc-copy');

// Safety Gate Assertion
if (TARGET_THEME_ID !== 1001512581) {
  throw new Error(`[SAFETY VIOLATION] Refusing to deploy to unauthorized theme: ${TARGET_THEME_ID}`);
}
if (TARGET_THEME_ID === PROTECTED_LIVE_THEME_ID) {
  throw new Error(`[FATAL SAFETY VIOLATION] Attempt to write to live production theme ${PROTECTED_LIVE_THEME_ID} blocked!`);
}

const cliData = JSON.parse(fs.readFileSync('C:/Users/Admin/.haravan-cli.json', 'utf8'));
const token = cliData[ORG_ID]?.access_token;
if (!token) throw new Error('Missing Haravan access token for org ' + ORG_ID);

function putAsset(key, content, isBinary = false) {
  return new Promise((resolve, reject) => {
    const assetPayload = { key };
    if (isBinary) {
      assetPayload.attachment = content.toString('base64');
    } else {
      assetPayload.value = content.toString('utf8');
    }

    const payload = JSON.stringify({ asset: assetPayload });
    const req = https.request({
      hostname: 'apis.haravan.com',
      path: `/web/themes/${TARGET_THEME_ID}/assets.json`,
      method: 'PUT',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload)
      }
    }, res => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          try {
            const data = JSON.parse(d);
            resolve({ ok: true, status: res.statusCode, key: data.asset?.key });
          } catch (e) {
            resolve({ ok: true, status: res.statusCode, key });
          }
        } else {
          reject(new Error(`HTTP ${res.statusCode}: ${d.slice(0, 150)}`));
        }
      });
    });

    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function main() {
  console.log(`[SAFETY CHECK PASSED] Target theme verified: #${TARGET_THEME_ID} (Copy)`);
  console.log(`[INFO] Scanning files to deploy from ${THEME_DIR}...`);

  // Target files: sanitized snippets, templates, config, and synthesized assets
  const filesToDeploy = [];

  // 1. Templates
  const templatesDir = path.join(THEME_DIR, 'templates');
  for (const f of fs.readdirSync(templatesDir)) {
    if (f.endsWith('.liquid') || f.endsWith('.json')) {
      filesToDeploy.push(`templates/${f}`);
    }
  }

  // 2. Snippets
  const snippetsDir = path.join(THEME_DIR, 'snippets');
  for (const f of fs.readdirSync(snippetsDir)) {
    if (f.endsWith('.liquid') || f.endsWith('.js') || f.endsWith('.css')) {
      filesToDeploy.push(`snippets/${f}`);
    }
  }

  // 3. Config
  const configDir = path.join(THEME_DIR, 'config');
  for (const f of fs.readdirSync(configDir)) {
    if (f.endsWith('.json')) {
      filesToDeploy.push(`config/${f}`);
    }
  }

  // 4. Layout
  const layoutDir = path.join(THEME_DIR, 'layout');
  if (fs.existsSync(layoutDir)) {
    for (const f of fs.readdirSync(layoutDir)) {
      if (f.endsWith('.liquid')) filesToDeploy.push(`layout/${f}`);
    }
  }

  // 5. Synthesized assets
  filesToDeploy.push('assets/bocongthuong.png');
  filesToDeploy.push('assets/default_image.png.webp');

  console.log(`[INFO] Total files queued for deployment: ${filesToDeploy.length}`);

  let success = 0;
  let skipped = 0;
  let failed = 0;

  for (let i = 0; i < filesToDeploy.length; i++) {
    const relPath = filesToDeploy[i];
    const fullPath = path.join(THEME_DIR, relPath);
    if (!fs.existsSync(fullPath)) {
      skipped++;
      continue;
    }

    const isBinary = relPath.endsWith('.png') || relPath.endsWith('.webp') || relPath.endsWith('.jpg') || relPath.endsWith('.ico');
    const content = fs.readFileSync(fullPath);

    try {
      const res = await putAsset(relPath, content, isBinary);
      success++;
      if (success % 10 === 0 || i === filesToDeploy.length - 1) {
        console.log(`[PROGRESS ${i + 1}/${filesToDeploy.length}] Uploaded: ${res.key}`);
      }
      await sleep(150); // Respect Haravan API call limits
    } catch (err) {
      console.error(`[ERROR] Failed to upload ${relPath}:`, err.message);
      failed++;
      await sleep(1000);
    }
  }

  console.log(`\n================ DEPLOYMENT SUMMARY ================`);
  console.log(`Target Theme ID: ${TARGET_THEME_ID} (phukienmaymoc-copy)`);
  console.log(`Successfully Uploaded: ${success}`);
  console.log(`Failed: ${failed}`);
  console.log(`Skipped: ${skipped}`);
  console.log(`Status: ${failed === 0 ? 'SUCCESS' : 'PARTIAL'}`);
  console.log(`====================================================\n`);
}

main().catch(err => {
  console.error('[FATAL]', err);
  process.exit(1);
});
