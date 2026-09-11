import fs from 'node:fs';
import https from 'node:https';

const ORG_ID = '200001207485';
const cliData = JSON.parse(fs.readFileSync('C:/Users/Admin/.haravan-cli.json', 'utf8'));
const org = cliData[ORG_ID];
if (!org || !org.access_token) {
  throw new Error(`No access token for org ${ORG_ID}`);
}
const token = org.access_token;

function apiRequest(method, urlPath, body = null) {
  return new Promise((resolve, reject) => {
    const postData = body ? JSON.stringify(body) : null;
    const headers = {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json',
    };
    if (postData) {
      headers['Content-Length'] = Buffer.byteLength(postData);
    }
    const req = https.request({
      hostname: 'apis.haravan.com',
      path: urlPath,
      method,
      headers,
    }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          try {
            resolve(JSON.parse(data));
          } catch {
            resolve(data);
          }
        } else {
          reject(new Error(`HTTP ${res.statusCode}: ${data.slice(0, 300)}`));
        }
      });
    });
    req.on('error', reject);
    if (postData) req.write(postData);
    req.end();
  });
}

const FIXTURE_PAGES = [
  {
    title: 'Danh mục thương hiệu',
    handle: 'brands',
    body_html: '<p>Danh mục các thương hiệu thiết bị tự động hóa công nghiệp chính hãng.</p>',
    template_suffix: 'brands',
  },
  {
    title: 'Yêu cầu báo giá',
    handle: 'bao-gia',
    body_html: '<p>Gửi yêu cầu báo giá thiết bị tự động hóa công nghiệp nhanh chóng, chính xác.</p>',
    template_suffix: 'quote',
  },
  {
    title: 'Tài liệu kỹ thuật',
    handle: 'tai-lieu-ky-thuat',
    body_html: '<p>Tài liệu hướng dẫn kỹ thuật, catalogue, sơ đồ đấu nối thiết bị.</p>',
    template_suffix: 'documents',
  },
  {
    title: 'Giới thiệu về Hợp Long',
    handle: 'gioi-thieu',
    body_html: '<p>Công ty Cổ phần Công nghệ Hợp Long là nhà phân phối chính thức thiết bị tự động hóa tại Việt Nam.</p>',
    template_suffix: 'about-us',
  },
  {
    title: 'Lịch sử phát triển',
    handle: 'lich-su-phat-trien',
    body_html: '<p>Hành trình 15 năm phát triển cùng ngành tự động hóa công nghiệp Việt Nam.</p>',
    template_suffix: '',
  },
  {
    title: 'Tuyển dụng',
    handle: 'tuyen-dung',
    body_html: '<p>Cơ hội nghề nghiệp và phát triển sự nghiệp tại Hợp Long.</p>',
    template_suffix: '',
  },
];

async function main() {
  console.log('[1] Checking existing pages on Haravan...');
  const existingRes = await apiRequest('GET', '/web/pages.json');
  const existingPages = existingRes.pages || [];
  console.log(`Found ${existingPages.length} existing pages.`);
  const handleMap = new Map(existingPages.map(p => [p.handle, p]));

  for (const fix of FIXTURE_PAGES) {
    if (handleMap.has(fix.handle)) {
      const p = handleMap.get(fix.handle);
      console.log(`[EXISTS] Page '${fix.handle}' already exists with ID ${p.id}.`);
    } else {
      console.log(`[CREATE] Creating minimal fixture page '${fix.handle}'...`);
      try {
        const created = await apiRequest('POST', '/web/pages.json', { page: fix });
        console.log(`[OK] Created page '${fix.handle}' ID: ${created.page?.id}`);
      } catch (err) {
        console.error(`[FAIL] Could not create page '${fix.handle}':`, err.message);
      }
    }
  }

  console.log('[DONE] Fixture creation complete.');
}

main().catch(console.error);
