import fs from 'node:fs';
import path from 'node:path';

const THEME_DIR = path.resolve('themes/phukienmaymoc-copy');

function sanitizeFile(filePath) {
  let content = fs.readFileSync(filePath, 'utf8');
  let changed = false;

  // 1. Remove wire:* attributes
  const wireRegex = /\s*wire:[a-zA-Z0-9_\-\.:]+(=("[^"]*"|'[^']*'|[^\s>]+))?/g;
  if (wireRegex.test(content)) {
    content = content.replace(wireRegex, '');
    changed = true;
  }

  // 2. Remove Livewire snapshot comments/directives
  const livewireComment = /<!--\s*\[if\s+BLOCK\]><!\[endif\]\s*-->|<!--\s*\[if\s+ENDBLOCK\]><!\[endif\]\s*-->/g;
  if (livewireComment.test(content)) {
    content = content.replace(livewireComment, '');
    changed = true;
  }

  // 3. Rewrite hoplongtech.com URLs to relative Haravan paths
  const hoplongUrlRegex = /https?:\/\/(www\.)?hoplongtech\.com(\/[a-zA-Z0-9_\-\.\/\?=&%#]*)?/g;
  if (hoplongUrlRegex.test(content)) {
    content = content.replace(hoplongUrlRegex, (match, p1, p2) => {
      if (!p2 || p2 === '/') return '/';
      if (p2.startsWith('/category')) {
        return p2.replace('/category', '/collections');
      }
      if (p2.startsWith('/brands/')) {
        const brand = p2.replace('/brands/', '');
        return `/collections/vendors?q=${encodeURIComponent(brand)}`;
      }
      if (p2 === '/brands') return '/pages/brands';
      if (p2.startsWith('/products/')) return p2;
      if (p2.startsWith('/cart')) return '/cart';
      if (p2.startsWith('/bao-gia')) return '/pages/bao-gia';
      if (p2.startsWith('/tai-lieu-ky-thuat')) return '/pages/tai-lieu-ky-thuat';
      if (p2.startsWith('/tin-tuc')) return p2.replace('/tin-tuc', '/blogs/news');
      if (p2.startsWith('/gioi-thieu')) return '/pages/gioi-thieu';
      if (p2.startsWith('/lich-su')) return '/pages/lich-su-phat-trien';
      if (p2.startsWith('/tuyen-dung') || p2.startsWith('/tuyendung')) return '/pages/tuyen-dung';
      return p2;
    });
    changed = true;
  }

  // 4. Rewrite hoplong.com URLs to relative Haravan paths
  const hoplongComRegex = /https?:\/\/(www\.)?hoplong\.com(\/[a-zA-Z0-9_\-\.\/\?=&%#]*)?/g;
  if (hoplongComRegex.test(content)) {
    content = content.replace(hoplongComRegex, (match, p1, p2) => {
      if (!p2 || p2 === '/') return '/pages/gioi-thieu';
      if (p2.includes('gioi-thieu')) return '/pages/gioi-thieu';
      if (p2.includes('lich-su')) return '/pages/lich-su-phat-trien';
      if (p2.includes('tuyen-dung') || p2.includes('tuyendung')) return '/pages/tuyen-dung';
      return '/';
    });
    changed = true;
  }

  // 5. Replace img.hoplongtech.com fallback onerror
  const imgHoplongRegex = /https?:\/\/img\.hoplongtech\.com\/[^\s"'>]+/g;
  if (imgHoplongRegex.test(content)) {
    // Replace with canonical placeholder or clean fallback
    content = content.replace(imgHoplongRegex, '{{ "logo.png" | asset_url }}');
    changed = true;
  }

  if (changed) {
    fs.writeFileSync(filePath, content, 'utf8');
    return true;
  }
  return false;
}

function walkDir(dir) {
  let count = 0;
  for (const item of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, item.name);
    if (item.isDirectory()) {
      count += walkDir(full);
    } else if (item.name.endsWith('.liquid') || item.name.endsWith('.js') || item.name.endsWith('.css')) {
      if (sanitizeFile(full)) count++;
    }
  }
  return count;
}

console.log('[1] Sanitizing theme files in', THEME_DIR);
const updatedFiles = walkDir(THEME_DIR);
console.log(`[DONE] Sanitized ${updatedFiles} files across copy theme.`);
