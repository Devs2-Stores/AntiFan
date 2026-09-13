'use strict';

const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const path = require('node:path');

app.commandLine.appendSwitch('no-sandbox');
app.commandLine.appendSwitch('disable-gpu');

const routes = [
  { id: '01', name: 'Trang chủ', dt: '', mb: 'mobile/' },
  { id: '02', name: 'Danh mục hãng', dt: 'brands/', mb: 'brands/mobile/' },
  { id: '03', name: 'Nhóm không lọc', dt: 'category/cam-bien/', mb: 'category/cam-bien/mobile/' },
  { id: '04', name: 'Nhóm có lọc', dt: 'category/contactor/', mb: 'category/contactor/mobile/' },
  { id: '05', name: 'Nhóm theo Brand', dt: 'brands/ecovacs/', mb: 'brands/ecovacs/mobile/' },
  { id: '06', name: 'Giỏ hàng', dt: 'cart/', mb: 'cart/mobile/' },
  { id: '07', name: 'Chi tiết sản phẩm', dt: 'product/', mb: 'product/mobile/' },
  { id: '08', name: 'Báo giá nhanh', dt: 'bao-gia/', mb: 'bao-gia/mobile/' },
  { id: '09', name: 'Tài liệu kỹ thuật', dt: 'tai-lieu-ky-thuat/', mb: 'tai-lieu-ky-thuat/mobile/' },
  { id: '10', name: 'Tin tức', dt: 'tin-tuc/', mb: 'tin-tuc/mobile/' },
  { id: '11', name: 'Chi tiết tin tức', dt: 'article/', mb: 'article/mobile/' },
  { id: '12', name: 'Giới thiệu', dt: 'gioi-thieu/', mb: 'gioi-thieu/mobile/' },
  { id: '13', name: 'Lịch sử phát triển', dt: 'lich-su-phat-trien/', mb: 'lich-su-phat-trien/mobile/' },
  { id: '14', name: 'Tuyển dụng & JD', dt: 'tuyen-dung/', mb: 'tuyen-dung/mobile/' },
  { id: '15', name: 'Liên hệ', dt: 'lien-he/', mb: 'lien-he/mobile/' }
];

const DESKTOP_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36';
const MOBILE_UA = 'Mozilla/5.0 (Linux; Android 14; Mobile; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.6613.114 Mobile Safari/537.36';

async function measureUrl(win, url, isMobile) {
  const width = isMobile ? 390 : 1440;
  const height = isMobile ? 844 : 900;
  
  win.setSize(width, height);
  win.webContents.setUserAgent(isMobile ? MOBILE_UA : DESKTOP_UA);
  
  await win.loadURL(url);
  // Wait a moment for layout settlement and images
  await new Promise(r => setTimeout(r, 600));

  const metrics = await win.webContents.executeJavaScript(`
    (() => {
      const imgs = Array.from(document.images);
      const loaded = imgs.filter(i => i.complete && i.naturalWidth > 0).length;
      const broken = imgs.filter(i => i.complete && i.naturalWidth === 0).length;
      return {
        scrollHeight: document.documentElement.scrollHeight,
        scrollWidth: document.documentElement.scrollWidth,
        clientWidth: document.documentElement.clientWidth,
        clientHeight: document.documentElement.clientHeight,
        imagesTotal: imgs.length,
        imagesLoaded: loaded,
        imagesBroken: broken,
        overflowX: document.documentElement.scrollWidth > document.documentElement.clientWidth
      };
    })()
  `);

  return metrics;
}

app.whenReady().then(async () => {
  console.log('[Live Measurement Runner] Measuring all 15 routes on port 3300 across Desktop (1440x900) and Mobile (390x844)...');

  const win = new BrowserWindow({
    width: 1440,
    height: 900,
    show: false,
    webPreferences: {
      offscreen: true,
      contextIsolation: false
    }
  });

  const results = [];

  for (const r of routes) {
    const dtUrl = `http://127.0.0.1:3300/${r.dt}`;
    const mbUrl = `http://127.0.0.1:3300/${r.mb}`;

    try {
      const dtMetrics = await measureUrl(win, dtUrl, false);
      const mbMetrics = await measureUrl(win, mbUrl, true);

      results.push({
        id: r.id,
        name: r.name,
        desktop: {
          url: dtUrl,
          ...dtMetrics
        },
        mobile: {
          url: mbUrl,
          ...mbMetrics
        }
      });

      console.log(`[Route ${r.id}] ${r.name.padEnd(20)} | DT: ${dtMetrics.scrollHeight}px (overflowX: ${dtMetrics.overflowX}) | MB: ${mbMetrics.scrollHeight}px (overflowX: ${mbMetrics.overflowX}) | BrokenImgs: ${dtMetrics.imagesBroken + mbMetrics.imagesBroken}`);
    } catch (err) {
      console.error(`[Route ${r.id}] Error measuring ${r.name}:`, err.message);
    }
  }

  win.close();

  const outPath = path.resolve('tmp/measured-routes-results.json');
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify(results, null, 2), 'utf8');
  console.log(`\nMeasurement completed successfully. Saved to: ${outPath}`);

  app.quit();
});
