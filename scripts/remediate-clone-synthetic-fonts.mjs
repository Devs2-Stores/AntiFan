import fs from 'node:fs';
import path from 'node:path';

function findHtmlFiles(dir, fileList = []) {
  if (!fs.existsSync(dir)) return fileList;
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      findHtmlFiles(full, fileList);
    } else if (entry.isFile() && entry.name === 'index.html') {
      fileList.push(full);
    }
  }
  return fileList;
}

const baseDir = '.canary/15-pages';
const allHtmlFiles = findHtmlFiles(baseDir);
console.log(`Found ${allHtmlFiles.length} index.html files to inspect and remediate.`);

let updatedCount = 0;

for (const f of allHtmlFiles) {
  let html = fs.readFileSync(f, 'utf8');
  let changed = false;

  // 1. Remove synthetic font-family override
  const badFontRegex = /body\s*\{\s*margin:\s*0;\s*padding:\s*0;\s*font-family:\s*-apple-system,[^}]+\}/g;
  if (badFontRegex.test(html)) {
    html = html.replace(badFontRegex, 'body { margin: 0; padding: 0; }');
    changed = true;
  }

  // 2. Add scrollbar suppression universally to prevent horizontal/vertical 15px gutter shifts
  if (!html.includes('scrollbar-width: none !important')) {
    const scrollbarRule = `\n<style id="antifan-remedy-scrollbar">html, * { scrollbar-width: none !important; } *::-webkit-scrollbar { display: none !important; }</style>\n`;
    html = html.replace('</head>', `${scrollbarRule}</head>`);
    changed = true;
  }

  // 3. P12 specific remediation: Banner height lock
  if (f.includes('page-12-gioi-thieu') && !html.includes('antifan-remedy-p12')) {
    const p12Rule = `\n<style id="antifan-remedy-p12">#section_2054157689 { min-height: 371px !important; max-height: 371px !important; padding-top: 300px !important; margin: 0 !important; }</style>\n`;
    html = html.replace('</head>', `${p12Rule}</head>`);
    changed = true;
  }

  // 4. P13 specific remediation: Timeline typography & sticky transition freeze
  if (f.includes('page-13-lich-su') && !html.includes('antifan-remedy-p13')) {
    const p13Rule = `\n<style id="antifan-remedy-p13">
.rotate-text .text-years { font-family: "Inter", -apple-system, sans-serif !important; writing-mode: vertical-lr !important; font-size: 5.5em !important; font-weight: 700 !important; color: #dddddd !important; letter-spacing: normal !important; }
.timeline__nav .col-inner { transition: none !important; }
.img-inner.image-cover img { position: absolute !important; top: 0 !important; left: 0 !important; width: 100% !important; height: 100% !important; object-fit: cover !important; }
</style>\n`;
    html = html.replace('</head>', `${p13Rule}</head>`);
    changed = true;
  }

  // 5. P14 specific remediation: Recruitment tab & active state
  if (f.includes('page-14-tuyen-dung') && !html.includes('antifan-remedy-p14')) {
    const p14Rule = `\n<style id="antifan-remedy-p14">
.tabbed-content .tab-panel:not(.active) { display: none !important; }
.tab-jobs .nav-tabs > li.active > a { border-bottom: 2px solid #3092ce !important; color: #3092ce !important; font-weight: 700 !important; }
.job.job-ta .new-jobs { background-color: #e53935; color: #fff; font-size: 0.75rem; padding: 2px 6px; border-radius: 4px; }
</style>\n`;
    html = html.replace('</head>', `${p14Rule}</head>`);
    changed = true;
  }

  if (changed) {
    fs.writeFileSync(f, html, 'utf8');
    updatedCount++;
  }
}

console.log(`Remediation complete: updated ${updatedCount} files.`);
