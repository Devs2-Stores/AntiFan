/**
 * Generator: Independent HTML Clone Generator
 * Stitches authentic live rawHtml sections into a standalone, offline-renderable HTML bundle
 * with localized assets, representative data caps (12 products / 6 articles), and zero remote hotlinks.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import type { ComponentContractIR } from '../models/clone-ir.js';
import { AssetLocalizer, LocalizeAssetOptions } from '../models/asset-localizer.js';
import { DomTreeParser, ParsedElementNode } from '../models/dom-tree-parser.js';
export interface IndependentHtmlCloneOptions {
  outputDir: string;
  sourceBaseUrl?: string;
  maxProducts?: number;
  maxArticles?: number;
  skipDownload?: boolean;
}

export interface IndependentHtmlCloneResult {
  success: boolean;
  entryHtmlPath: string;
  filesWritten: string[];
  productCount: number;
  articleCount: number;
}

export class IndependentHtmlCloneGenerator {
  public async generateCloneBundle(
    ir: ComponentContractIR,
    options: IndependentHtmlCloneOptions
  ): Promise<IndependentHtmlCloneResult> {
    const outputDir = path.resolve(options.outputDir);
    const stageDir = fs.mkdtempSync(path.join(os.tmpdir(), 'antifan-clone-bundle-stage-'));
    const assetsDir = path.join(stageDir, 'assets');
    fs.mkdirSync(assetsDir, { recursive: true });
    const filesWritten: string[] = [];

    try {
      // 1. Enforce Representative Content Bounds on Metadata
      const maxProducts = options.maxProducts ?? 12;
      const maxArticles = options.maxArticles ?? 6;

      const products = (ir.normalizedData?.products || []).slice(0, maxProducts);
      const articles = (ir.normalizedData?.articles || []).slice(0, maxArticles);

      // 2. Extract and prune rawHtml sections to enforce global card cardinality bounds
      let remainingProducts = maxProducts;
      let remainingArticles = maxArticles;
      const sectionHtmls: string[] = [];
      for (const sec of ir.sections) {
        let contentHtml = '';
        if (sec.rawHtml && sec.rawHtml.trim().length > 0) {
          const isProduct = sec.archetype === 'product_grid';
          const isArticle = (sec.archetype === 'custom_section' || sec.archetype === 'rich_text') && /(?:blog|news|article|bai-viet|tin-tuc)/i.test(sec.rawHtml);
          const budget = isProduct ? remainingProducts : (isArticle ? remainingArticles : 0);
          const pruneRes = this.pruneSectionCards(sec.rawHtml, sec.archetype, budget);
          contentHtml = pruneRes.html;
          if (isProduct) {
            remainingProducts = Math.max(0, remainingProducts - pruneRes.retainedCount);
          } else if (isArticle) {
            remainingArticles = Math.max(0, remainingArticles - pruneRes.retainedCount);
          }
          // Sanitize Alpine-bound and standard load-capable video/embed attributes containing remote URLs
          contentHtml = contentHtml.replace(/(?::|x-bind:|v-bind:)?(src|data-src)\s*=\s*(?:"[^"]*(?:youtube\.com|vimeo\.com)[^"]*"|'[^']*(?:youtube\.com|vimeo\.com)[^']*')/gi, '$1=""');
          contentHtml = contentHtml.replace(/(?::|x-bind:|v-bind:)(src|data-src)\s*=\s*(?:"[^"]*(?:https?:)?\/\/[^"]*"|'[^']*(?:https?:)?\/\/[^']*')/gi, '');
        } else if (sec.liquidTemplate) {
          const stripped = sec.liquidTemplate
            .replace(/{%[\s\S]*?%}/g, '')
            .replace(/{{\s*['"]([^'"]+)['"]\s*\|\s*asset_url\s*}}/g, 'assets/$1')
            .replace(/{{\s*[^}]+\s*}}/g, '');
          contentHtml = stripped.trim();
        }

        if (contentHtml) {
          sectionHtmls.push(`<!-- Section: ${sec.id} (${sec.archetype}) -->\n${contentHtml}`);
        }
      }

      const title = ir.normalizedData?.siteSettings?.title || 'Independent Reconstructed Storefront';

      // 3. Assemble Complete Standalone HTML Document with linked stylesheets and scripts
      const stylesheetTags = (ir.assets?.stylesheets || [])
        .map(css => `  <link rel="stylesheet" href="${css.sourceUrl || `assets/${css.filename}`}">`)
        .join('\n');
      const javascriptTags = (ir.assets?.javascripts || [])
        .map(js => `  <script src="${js.sourceUrl || `assets/${js.filename}`}"></script>`)
        .join('\n');

      const rawIndexHtml = `<!DOCTYPE html>
<html lang="vi">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${title.replace(/</g, '&lt;')}</title>
  <style>
    *, *::before, *::after { box-sizing: border-box; }
    body { margin: 0; padding: 0; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif; }
    img { max-width: 100%; height: auto; display: block; }
  </style>
${stylesheetTags ? stylesheetTags + '\n' : ''}</head>
<body>
  <div id="antifan-storefront-root">
    ${sectionHtmls.join('\n\n    ')}
  </div>
${javascriptTags ? javascriptTags + '\n' : ''}</body>
</html>`;

      const indexHtmlPath = path.join(stageDir, 'index.html');
      filesWritten.push(indexHtmlPath);

      // 4. Localize Assets & Rewrite All URLs in index.html to Local Relative Paths
      if (ir.assets) {
        // If any asset item already specifies a localPath that exists on disk, pre-copy it into assetsDir so it is not re-downloaded
        const allItems = [
          ...(ir.assets.stylesheets || []),
          ...(ir.assets.javascripts || []),
          ...(ir.assets.images || []),
          ...(ir.assets.fonts || [])
        ];
        for (const item of allItems) {
          if (item.localPath && fs.existsSync(item.localPath)) {
            const dest = path.join(assetsDir, item.filename);
            if (!fs.existsSync(dest)) {
              fs.copyFileSync(item.localPath, dest);
            }
          }
        }

        const localizer = new AssetLocalizer();
        const pipelineRes = await localizer.localizePipeline(
          [{ path: indexHtmlPath, content: rawIndexHtml }],
          ir.assets,
          {
            assetsDir,
            mode: 'relative',
            sourceBaseUrl: options.sourceBaseUrl || ir.metadata.sourceUrl,
            skipDownload: options.skipDownload ?? false
          }
        );

        if (!pipelineRes.a3_audit.passed) {
          const findingSummary = pipelineRes.a3_audit.findings.map(f => `[${f.severity}] ${f.code}: ${f.message}`).join('\n');
          throw new Error(`IndependentHtmlCloneGenerator Asset Audit Failed (Fail-Closed):\n${findingSummary}`);
        }

        const rewrittenIndex = pipelineRes.a2_rewrite.files.find(f => f.path === indexHtmlPath);
        fs.writeFileSync(indexHtmlPath, rewrittenIndex ? rewrittenIndex.rewrittenContent : rawIndexHtml, 'utf-8');

        for (const vAsset of pipelineRes.a3_audit.verifiedAssets) {
          if (vAsset.exists) {
            filesWritten.push(vAsset.localPath);
          }
        }
      } else {
        fs.writeFileSync(indexHtmlPath, rawIndexHtml, 'utf-8');
      }

      // 5. Write manifest metadata
      const manifestPath = path.join(stageDir, 'manifest.json');
      fs.writeFileSync(manifestPath, JSON.stringify({
        version: ir.version,
        sourceUrl: ir.metadata.sourceUrl,
        generatedAt: new Date().toISOString(),
        representativeData: {
          productCount: products.length,
          articleCount: articles.length
        },
        sections: ir.sections.map(s => ({ id: s.id, archetype: s.archetype }))
      }, null, 2), 'utf-8');
      filesWritten.push(manifestPath);

      // 6. Atomically swap stageDir into outputDir only AFTER successful audit and generation
      fs.mkdirSync(outputDir, { recursive: true });
      const backupDir = fs.mkdtempSync(path.join(os.tmpdir(), 'antifan-clone-bundle-backup-'));
      try {
        const stageEntries = fs.readdirSync(stageDir);
        for (const entry of stageEntries) {
          const destEntry = path.join(outputDir, entry);
          if (fs.existsSync(destEntry)) {
            fs.cpSync(destEntry, path.join(backupDir, entry), { recursive: true });
            fs.rmSync(destEntry, { recursive: true, force: true });
          }
          fs.cpSync(path.join(stageDir, entry), destEntry, { recursive: true });
        }
      } catch (swapErr) {
        try {
          const backupEntries = fs.readdirSync(backupDir);
          for (const entry of backupEntries) {
            const destEntry = path.join(outputDir, entry);
            if (fs.existsSync(destEntry)) fs.rmSync(destEntry, { recursive: true, force: true });
            fs.cpSync(path.join(backupDir, entry), destEntry, { recursive: true });
          }
        } catch {}
        throw swapErr;
      } finally {
        try { fs.rmSync(backupDir, { recursive: true, force: true }); } catch {}
      }

      const finalEntryPath = path.join(outputDir, 'index.html');
      return {
        success: true,
        entryHtmlPath: finalEntryPath,
        filesWritten: filesWritten.map(f => path.join(outputDir, path.relative(stageDir, f))),
        productCount: products.length,
        articleCount: articles.length
      };
    } finally {
      try { fs.rmSync(stageDir, { recursive: true, force: true }); } catch {}
    }
  }

  private pruneSectionCards(rawHtml: string, archetype: string, limit: number): { html: string; retainedCount: number } {
    const isProduct = archetype === 'product_grid';
    const isArticle = (archetype === 'custom_section' || archetype === 'rich_text') && /(?:blog|news|article|bai-viet|tin-tuc)/i.test(rawHtml);
    if (!isProduct && !isArticle) {
      return { html: rawHtml.trim(), retainedCount: 0 };
    }

    try {
      const root = DomTreeParser.parse(rawHtml);
      const targetClassRegex = isProduct
        ? /(?:^|\s)(?:product-item|product-card|product-list__item)(?:\s|$)/i
        : /(?:^|\s)(?:article-item|article-card|news-item|post-item)(?:\s|$)/i;

      // Find all matching card nodes using DOM tree
      const cardNodes: ParsedElementNode[] = [];
      const traverse = (node: ParsedElementNode) => {
        const cls = node.attributes['class'] || '';
        if (targetClassRegex.test(cls)) {
          cardNodes.push(node);
          return; // Do not traverse inside card to avoid picking up nested child items
        }
        for (const child of node.children) {
          if (typeof child !== 'string') {
            traverse(child);
          }
        }
      };
      traverse(root);

      const totalCards = cardNodes.length;
      if (totalCards <= limit) {
        return { html: rawHtml.trim(), retainedCount: totalCards };
      }

      // Locate each excess card's exact outerHtml slice in document order and splice from end to start
      const cardRanges: { start: number; end: number }[] = [];
      let searchCursor = 0;
      for (const card of cardNodes) {
        const idx = rawHtml.indexOf(card.outerHtml, searchCursor);
        if (idx !== -1) {
          cardRanges.push({ start: idx, end: idx + card.outerHtml.length });
          searchCursor = idx + card.outerHtml.length;
        }
      }

      let resultHtml = rawHtml;
      const excessRanges = cardRanges.slice(limit).reverse();
      for (const range of excessRanges) {
        resultHtml = resultHtml.slice(0, range.start) + resultHtml.slice(range.end);
      }

      return { html: resultHtml.trim(), retainedCount: limit };
    } catch {
      return { html: rawHtml.trim(), retainedCount: 0 };
    }
  }
}
