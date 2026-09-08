import * as fs from 'node:fs';
import * as path from 'node:path';
import { AssetLocalizer } from '../packages/site-clone/dist/models/asset-localizer.js';

const targetDir = path.resolve('E:/Work/apps/AntiFan/clone/hoplongtech');
const indexHtmlPath = path.join(targetDir, 'index.html');
const rawHtml = fs.readFileSync(indexHtmlPath, 'utf-8');

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
  rewrittenFiles: [{
    path: 'index.html',
    replacementCount: 0,
    originalContent: rawHtml,
    rewrittenContent: rawHtml
  }]
});

console.log('--- A3 Static Audit Result for clone/hoplongtech ---');
console.log('Passed:', auditResult.passed);
console.log('Findings Count:', auditResult.findings.length);
console.log('Unlocalized URLs Count:', auditResult.unlocalizedUrls.length);
console.log('Top 10 Unlocalized URLs:', auditResult.unlocalizedUrls.slice(0, 10));

if (auditResult.findings.length > 0) {
  console.log('\nTop 5 Error Findings:');
  auditResult.findings.slice(0, 5).forEach(f => {
    console.log(`[${f.severity}] ${f.code}: ${f.message}`);
  });
}
