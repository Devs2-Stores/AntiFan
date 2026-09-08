import * as fs from 'node:fs';
import * as path from 'node:path';
import { AssetLocalizer } from '../packages/site-clone/dist/models/asset-localizer.js';

const targetDir = path.resolve('E:/Work/apps/AntiFan/clone/hoplongtech');

// Collect all html, css, and js files in clone/hoplongtech
const filesToAudit = [];

function walk(dir) {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      walk(full);
    } else {
      const ext = path.extname(e.name).toLowerCase();
      if (['.html', '.css', '.js'].includes(ext)) {
        filesToAudit.push(full);
      }
    }
  }
}

walk(targetDir);

const rewrittenFiles = filesToAudit.map(f => {
  const rel = path.relative(targetDir, f).replace(/\\/g, '/');
  const content = fs.readFileSync(f, 'utf-8');
  return {
    path: rel,
    replacementCount: 0,
    originalContent: content,
    rewrittenContent: content
  };
});

const localizer = new AssetLocalizer();
const dummyManifest = {
  stylesheets: [],
  javascripts: [],
  images: [],
  fonts: [],
  totalBytes: 0
};

const auditResult = localizer.verifyAndAudit(dummyManifest, {
  assetsDir: targetDir,
  rewrittenFiles
});

console.log('=== Comprehensive A3 Audit (HTML + CSS + JS) ===');
console.log('Total files audited:', filesToAudit.length);
console.log('Passed:', auditResult.passed);
console.log('Total Findings:', auditResult.findings.length);
console.log('Total Unlocalized URLs:', auditResult.unlocalizedUrls.length);

// 2. Local disk reference audit (verify relative url() and src paths exist on disk)
console.log('\n=== Local Disk Asset Resolution Audit ===');
const missingLocalReferences = [];

for (const file of rewrittenFiles) {
  // Regex for relative paths: /build/assets/..., css/..., js/..., etc.
  const localRefRegex = /(?:src|href)=["']([^"':]+)["']|url\(\s*["']?([^"'()]+)["']?\s*\)/gi;
  let match;
  while ((match = localRefRegex.exec(file.rewrittenContent)) !== null) {
    const ref = (match[1] || match[2] || '').trim();
    if (!ref || ref.startsWith('data:') || ref.startsWith('#') || ref.startsWith('javascript:')) continue;
    if (ref.includes('//')) continue; // remote URL already caught by A3

    // Resolve path relative to targetDir
    let diskPath;
    if (ref.startsWith('/')) {
      diskPath = path.join(targetDir, ref.slice(1));
    } else {
      const fileDir = path.dirname(path.join(targetDir, file.path));
      diskPath = path.resolve(fileDir, ref);
    }

    if (!fs.existsSync(diskPath)) {
      missingLocalReferences.push({
        file: file.path,
        reference: ref,
        resolvedPath: path.relative(targetDir, diskPath).replace(/\\/g, '/')
      });
    }
  }
}

console.log('Total Missing Local Disk References:', missingLocalReferences.length);
if (missingLocalReferences.length > 0) {
  console.log('\nTop 10 Missing Disk References:');
  missingLocalReferences.slice(0, 10).forEach(m => {
    console.log(`[MISSING_FILE] ${m.file} -> "${m.reference}" (expected at: ${m.resolvedPath})`);
  });
}
