import fs from 'node:fs';
import path from 'node:path';

const SNIPPETS_DIR = path.resolve('themes/phukienmaymoc-copy/snippets');

const files = fs.readdirSync(SNIPPETS_DIR).filter(f => f.endsWith('.liquid'));

let totalReplacements = 0;

for (const file of files) {
  const filePath = path.join(SNIPPETS_DIR, file);
  let content = fs.readFileSync(filePath, 'utf8');
  let changed = false;

  // 1. Replace broken /assets/images/default_image.png.webp
  if (content.includes('/assets/images/default_image.png.webp')) {
    content = content.replaceAll(
      "/assets/images/default_image.png.webp",
      "{{ 'default_image.png.webp' | asset_url }}"
    );
    changed = true;
    totalReplacements++;
  }

  // 2. Replace broken /assets/images/bocongthuong.png in footer
  if (content.includes('/assets/images/bocongthuong.png')) {
    content = content.replaceAll(
      "/assets/images/bocongthuong.png",
      "{{ 'default_image.png.webp' | asset_url }}"
    );
    changed = true;
    totalReplacements++;
  }

  // 3. Remove Laravel CSRF tokens
  if (content.includes('name="_token"')) {
    content = content.replace(/<input\s+type="hidden"\s+name="_token"[^>]*>/gi, '');
    changed = true;
    totalReplacements++;
  }

  if (changed) {
    fs.writeFileSync(filePath, content, 'utf8');
    console.log(`[SANITIZED] ${file}`);
  }
}

console.log(`[DONE] Total sanitized files processed: ${totalReplacements}`);
