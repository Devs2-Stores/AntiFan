import https from 'node:https';

const routes = [
  { name: '1. Trang chu (Home)', path: '/?preview_theme_id=1001512581' },
  { name: '2. Danh muc Cam bien', path: '/collections/cam-bien?preview_theme_id=1001512581' },
  { name: '3. Danh muc Contactor', path: '/collections/contactor?preview_theme_id=1001512581' },
  { name: '4. Thuong hieu Inovance', path: '/collections/vendors?q=Inovance&preview_theme_id=1001512581' },
  { name: '5. San pham LC1D09M7', path: '/products/lc1d09m7?preview_theme_id=1001512581' },
  { name: '6. Gio hang (Cart)', path: '/cart?preview_theme_id=1001512581' },
  { name: '7. Tin tuc (Blog)', path: '/blogs/news?preview_theme_id=1001512581' },
  { name: '8. Bai viet chi tiet', path: '/blogs/news/plc-la-gi-cau-tao-nguyen-ly-hoat-dong?preview_theme_id=1001512581' },
  { name: '9. Tim kiem (Search)', path: '/search?q=laser&preview_theme_id=1001512581' },
  { name: '10. Trang Brands', path: '/pages/brands?preview_theme_id=1001512581' },
  { name: '11. Trang Bao gia', path: '/pages/bao-gia?preview_theme_id=1001512581' },
  { name: '12. Trang Tai lieu', path: '/pages/tai-lieu-ky-thuat?preview_theme_id=1001512581' },
  { name: '13. Trang Gioi thieu', path: '/pages/gioi-thieu?preview_theme_id=1001512581' },
  { name: '14. Trang Lich su', path: '/pages/lich-su-phat-trien?preview_theme_id=1001512581' },
  { name: '15. Trang Tuyen dung', path: '/pages/tuyen-dung?preview_theme_id=1001512581' }
];

function checkRoute(r) {
  return new Promise(resolve => {
    const req = https.request({
      hostname: 'phukienmaymoc.com',
      path: r.path,
      method: 'GET',
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
      }
    }, res => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => {
        const titleMatch = d.match(/<title>([^<]*)<\/title>/i);
        resolve({
          name: r.name,
          path: r.path,
          status: res.statusCode,
          length: d.length,
          title: titleMatch ? titleMatch[1].trim() : 'N/A'
        });
      });
    });
    req.on('error', err => resolve({ name: r.name, path: r.path, error: err.message }));
    req.end();
  });
}

async function main() {
  console.log('Probing all 15 Haravan storefront preview routes on phukienmaymoc.com...\n');
  const results = [];
  for (const r of routes) {
    const res = await checkRoute(r);
    results.push(res);
    console.log(`[HTTP ${res.status}] ${res.name.padEnd(26)} | Bytes: ${String(res.length).padStart(6)} | Title: ${res.title}`);
  }

  const all200 = results.every(r => r.status === 200);
  console.log(`\nResult: ${results.length}/15 routes probed. All HTTP 200 OK: ${all200}`);
}

main();
