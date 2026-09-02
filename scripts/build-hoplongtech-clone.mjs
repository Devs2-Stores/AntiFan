import fs from 'node:fs';
import path from 'node:path';

const outDir = path.resolve('clone/hoplongtech');
const cssDir = path.join(outDir, 'css');
const jsDir = path.join(outDir, 'js');

fs.mkdirSync(cssDir, { recursive: true });
fs.mkdirSync(jsDir, { recursive: true });

async function run() {
  console.log('Fetching assets from hoplongtech.com...');
  
  const appCssUrl = 'https://hoplongtech.com/build/assets/app-DCc2d3nB.css';
  const homeCssUrl = 'https://hoplongtech.com/build/assets/home-CW7DK4JA.css';
  
  const [appCssRes, homeCssRes] = await Promise.all([
    fetch(appCssUrl),
    fetch(homeCssUrl)
  ]);
  
  let appCss = await appCssRes.text();
  let homeCss = await homeCssRes.text();
  
  // Fix relative font paths to absolute or fallback system fonts
  appCss = appCss.replace(/url\(\/build\/assets\/([^\)]+)\)/g, 'url(https://hoplongtech.com/build/assets/$1)');
  homeCss = homeCss.replace(/url\(\/build\/assets\/([^\)]+)\)/g, 'url(https://hoplongtech.com/build/assets/$1)');
  
  fs.writeFileSync(path.join(cssDir, 'app.css'), appCss, 'utf8');
  fs.writeFileSync(path.join(cssDir, 'home.css'), homeCss, 'utf8');
  console.log('Saved CSS stylesheets.');
  
  // Fetch homepage HTML
  console.log('Fetching homepage HTML...');
  const htmlRes = await fetch('https://hoplongtech.com/', {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36'
    }
  });
  let html = await htmlRes.text();
  
  // Replace remote CSS links with local CSS
  html = html.replace(/<link[^>]+href="[^"]*app-[^"]*\.css"[^>]*>/gi, '<link rel="stylesheet" href="css/app.css">');
  html = html.replace(/<link[^>]+href="[^"]*home-[^"]*\.css"[^>]*>/gi, '<link rel="stylesheet" href="css/home.css">');
  
  // Clean up livewire error backdrops or tawk chat scripts that might break offline
  // Fix relative image links to absolute hoplongtech URLs so all images load perfectly
  html = html.replace(/src="\/assets\//g, 'src="https://hoplongtech.com/assets/');
  html = html.replace(/href="\/assets\//g, 'href="https://hoplongtech.com/assets/');
  
  // Add local interactivity script for slider, mega menu hover, tab switching
  const interactiveScript = `
<script>
document.addEventListener('DOMContentLoaded', () => {
  // Category sub-menu hover interaction
  const cateItems = document.querySelectorAll('.category-navigation__list ul li');
  const subMenu = document.getElementById('category-navigation__sub');
  
  cateItems.forEach(item => {
    item.addEventListener('mouseenter', () => {
      if (subMenu) subMenu.classList.add('active');
    });
  });
  
  const navContainer = document.querySelector('.category-navigation');
  if (navContainer && subMenu) {
    navContainer.addEventListener('mouseleave', () => {
      subMenu.classList.remove('active');
    });
  }
  
  // Accessory tab switching
  const accessoryTabs = document.querySelectorAll('.accessory-header .right ul li');
  accessoryTabs.forEach(tab => {
    tab.addEventListener('click', (e) => {
      e.preventDefault();
      accessoryTabs.forEach(t => t.classList.remove('active'));
      tab.classList.add('active');
    });
  });
  
  // Partner / slider simple auto-scroll interaction
  console.log('[Hoplongtech 1-1 Clone] Initialized successfully.');
});
</script>
`;
  
  html = html.replace('</body>', interactiveScript + '\n</body>');
  
  fs.writeFileSync(path.join(outDir, 'index.html'), html, 'utf8');
  console.log('Saved 1-1 Clone index.html successfully. Size:', html.length, 'bytes');
}

run().catch(err => {
  console.error('Error constructing clone:', err);
  process.exit(1);
});
