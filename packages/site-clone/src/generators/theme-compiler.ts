/**
 * Generator: Theme Compiler Orchestrator
 * True atomic staging, validation, and swap to guarantee zero corrupted/partial theme output
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { ComponentContractIR } from '../models/clone-ir.js';
import { CloneIRBuilder } from '../models/clone-ir-builder.js';
import { HaravanLayoutGenerator } from './haravan-layout-generator.js';
import { HaravanSectionGenerator } from './haravan-section-generator.js';
import { HaravanSchemaGenerator, type HaravanBlockDefinition } from './haravan-schema-generator.js';
import { HaravanSnippetGenerator } from './haravan-snippet-generator.js';
import { StateSynthesizer } from '../models/state-synthesizer.js';
import { AssetLocalizer, LocalizeAssetOptions, AssetLocalizationPipelineResult } from '../models/asset-localizer.js';
import { LiquidBindingEngine } from './liquid-binding-engine.js';
import { SettingsAssetsNormalizer } from './settings-assets-normalizer.js';
export class ThemeCompiler {
  private layoutGen = new HaravanLayoutGenerator();
  private sectionGen = new HaravanSectionGenerator();
  private schemaGen = new HaravanSchemaGenerator();
  private snippetGen = new HaravanSnippetGenerator();
  private stateSynth = new StateSynthesizer();
  private irBuilder = new CloneIRBuilder();
  private liquidBindingEngine = new LiquidBindingEngine();
  private settingsNormalizer = new SettingsAssetsNormalizer();
  public async compileThemeWithLocalizationAsync(
    outputDir: string,
    input: string | ComponentContractIR,
    options?: Partial<LocalizeAssetOptions>
  ): Promise<{ success: boolean; sectionCount: number; filesWritten: string[]; localization?: AssetLocalizationPipelineResult }> {
    if (!input) {
      throw new Error('ThemeCompiler: input must be a valid non-empty string or ComponentContractIR');
    }
    const ir: ComponentContractIR = typeof input === 'string' ? this.irBuilder.buildFromHtml(input) : input;
    
    // 1. Compile into an isolated temporary staging directory first
    const tempStageDir = fs.mkdtempSync(path.join(os.tmpdir(), 'antifan-theme-async-stage-'));
    try {
      const compileRes = this.compileThemeFromIR(tempStageDir, ir);

      // 2. If assets exist, run AssetLocalizer.localizePipeline inside the temporary staging directory
      let pipelineRes: AssetLocalizationPipelineResult | undefined;
      if (ir.assets) {
        const assetsDir = path.join(tempStageDir, 'assets');
        fs.mkdirSync(assetsDir, { recursive: true });

        const themeFiles: Array<{ path: string; content: string }> = compileRes.filesWritten
          .filter(f => /\.(liquid|json|css|js)$/i.test(f) && fs.existsSync(f))
          .map(f => ({ path: f, content: fs.readFileSync(f, 'utf-8') }));

        const localizer = new AssetLocalizer();
        pipelineRes = await localizer.localizePipeline(themeFiles, ir.assets, {
          assetsDir,
          mode: 'liquid',
          skipDownload: false,
          ...options
        });

        // Strict fail-closed gate: if audit fails, abort without touching outputDir
        if (!pipelineRes.a3_audit.passed) {
          const findingSummary = pipelineRes.a3_audit.findings
            .map(f => `[${f.severity}] ${f.code}: ${f.message}`)
            .join('\n');
          throw new Error(`ThemeCompiler Asset Audit Failed (Fail-Closed):\n${findingSummary}`);
        }

        // Write back rewritten source files containing localized URLs in temp staging
        for (const rewritten of pipelineRes.a2_rewrite.files) {
          fs.writeFileSync(rewritten.path, rewritten.rewrittenContent, 'utf-8');
        }

        for (const assetItem of pipelineRes.a3_audit.verifiedAssets) {
          if (assetItem.exists && !compileRes.filesWritten.includes(assetItem.localPath)) {
            compileRes.filesWritten.push(assetItem.localPath);
          }
        }
      }

      // 3. Atomically swap tempStageDir into outputDir only AFTER localization and audit succeed 100%
      const dirs = ['layout', 'templates', 'sections', 'snippets', 'assets', 'config', 'locales'];
      this.atomicSwap(tempStageDir, outputDir, dirs);

      return {
        success: true,
        sectionCount: compileRes.sectionCount,
        filesWritten: compileRes.filesWritten.map(f => path.join(outputDir, path.relative(tempStageDir, f))),
        localization: pipelineRes
      };
    } finally {
      try { fs.rmSync(tempStageDir, { recursive: true, force: true }); } catch {}
    }
  }

  public compileTheme(outputDir: string, input: string | ComponentContractIR): { success: boolean; sectionCount: number; filesWritten: string[] } {
    if (!input) {
      throw new Error('ThemeCompiler: input must be a valid non-empty string or ComponentContractIR');
    }

    const ir: ComponentContractIR = typeof input === 'string' ? this.irBuilder.buildFromHtml(input) : input;
    return this.compileThemeFromIR(outputDir, ir);
  }
  public compileThemeFromIR(outputDir: string, ir: ComponentContractIR): { success: boolean; sectionCount: number; filesWritten: string[] } {
    // 1. Create temporary staging directory for atomic generation
    const stagingDir = fs.mkdtempSync(path.join(os.tmpdir(), 'antifan-theme-stage-'));
    const filesWritten: string[] = [];

    try {
      // 2. Prepare staging subdirectories
      const dirs = [
        'layout',
        'templates',
        'sections',
        'snippets',
        'assets',
        'config',
        'locales'
      ];

      for (const d of dirs) {
        fs.mkdirSync(path.join(stagingDir, d), { recursive: true });
      }

      // 3. Map sections from ComponentContractIR
      const sections = ir.sections;

      // 4. Generate layout/theme.liquid
      const layoutPath = path.join(stagingDir, 'layout', 'theme.liquid');
      fs.writeFileSync(layoutPath, this.layoutGen.generateThemeLiquid(), 'utf-8');
      filesWritten.push(layoutPath);

      // 5. Generate dynamic templates/index.json from non-header/footer sections
      const templateSections: Record<string, {
        type: string;
        settings: Record<string, unknown>;
        blocks?: Record<string, { type: string; settings: Record<string, unknown> }>;
        block_order?: string[];
      }> = {};
      const sectionOrder: string[] = [];

      for (const sec of sections) {
        if (sec.archetype !== 'header' && sec.archetype !== 'footer') {
          const key = sec.id.replace(/[^a-zA-Z0-9_-]/g, '_');
          const secEntry: {
            type: string;
            settings: Record<string, unknown>;
            blocks?: Record<string, { type: string; settings: Record<string, unknown> }>;
            block_order?: string[];
          } = {
            type: sec.id,
            settings: {
              heading: sec.heading || sec.name
            }
          };

          if (sec.blocks && sec.blocks.length > 0) {
            const blocksObj: Record<string, { type: string; settings: Record<string, unknown> }> = {};
            const blockOrder: string[] = [];

            let bIdx = 1;
            for (const b of sec.blocks) {
              const bKey = b.id || `${b.type}_${bIdx}`;
              blocksObj[bKey] = {
                type: b.type,
                settings: b.settings
              };
              blockOrder.push(bKey);
              bIdx++;
            }

            secEntry.blocks = blocksObj;
            secEntry.block_order = blockOrder;
          }

          templateSections[key] = secEntry;
          sectionOrder.push(key);
        }
      }

      const indexJsonContent = JSON.stringify({
        sections: templateSections,
        order: sectionOrder
      }, null, 2);

      const indexJsonPath = path.join(stagingDir, 'templates', 'index.json');
      fs.writeFileSync(indexJsonPath, indexJsonContent, 'utf-8');
      filesWritten.push(indexJsonPath);

      // 6. Generate sections/*.liquid from IR
      for (const sec of sections) {
        let sectionLiquid = '';
        const sectionControllers = ir.storefrontRuntime?.controllers?.filter((c) => c.sectionId === sec.id) || [];

        if (sec.liquidTemplate) {
          sectionLiquid = sec.liquidTemplate;
        } else {
          sectionLiquid = `
<section class="${sec.className || sec.id}" id="{{ section.id }}">
  <div class="container container-fluid">
    {% if section.settings.heading != blank %}
      <h2 class="title">{{ section.settings.heading }}</h2>
    {% endif %}
    <div class="content">
      {% for block in section.blocks %}
        <div class="block" {{ block.haravan_attributes }}>
          {{ block.settings.title }}
        </div>
      {% endfor %}
    </div>
  </div>
</section>
          `.trim();
        }

        // Strip any pre-existing schema block so schemaGen can wrap dynamically
        sectionLiquid = sectionLiquid.replace(/\{%\s*schema\s*%\Block?[\s\S]*?\{%\s*endschema\s*%\}/gi, '').trim();

        // 6a. Controller injection (carousel, modal, dropdown)
        for (const ctrl of sectionControllers) {
          if (ctrl.type === 'carousel') {
            if (!sectionLiquid.includes('data-antifan-slider')) {
              sectionLiquid = sectionLiquid.replace(/<section\b([^>]*)>/i, '<section$1 data-antifan-slider data-antifan-autoplay="5000">');
            }
            if (!sectionLiquid.includes('data-antifan-slider-track')) {
              sectionLiquid = sectionLiquid.replace(
                /(<div\b[^>]*class=["'][^"']*(?:product-grid|slider|s-content)[^"']*["'])([^>]*>)/i,
                '$1 data-antifan-slider-track$2'
              );
            }
          } else if (ctrl.type === 'dropdown') {
            if (!sectionLiquid.includes('data-antifan-hover')) {
              sectionLiquid = sectionLiquid.replace(
                /(<li\b[^>]*class=["'][^"']*(?:menu-item-has-children|dropdown|has-sub)[^"']*["'])([^>]*>)/i,
                '$1 data-antifan-hover$2'
              );
            }
          } else if (ctrl.type === 'modal') {
            const modalTarget = (ctrl.targetSelector && ctrl.targetSelector.startsWith('#'))
              ? ctrl.targetSelector
              : `#modal-${sec.id}`;
            const modalId = modalTarget.replace(/^#/, '');

            if (!sectionLiquid.includes('data-antifan-modal')) {
              sectionLiquid = sectionLiquid.replace(
                /(<button\b[^>]*class=["'][^"']*(?:modal-btn|popup-btn|item-cta)[^"']*["'])([^>]*>)/i,
                `$1 data-antifan-modal="${modalTarget}"$2`
              );
            }
            if (!sectionLiquid.includes('data-antifan-modal-dialog')) {
              if (/(<div\b[^>]*class=["'][^"']*(?:modal|popup|dialog)[^"']*["'])([^>]*>)/i.test(sectionLiquid)) {
                sectionLiquid = sectionLiquid.replace(
                  /(<div\b[^>]*class=["'][^"']*(?:modal|popup|dialog)[^"']*["'])([^>]*>)/i,
                  `$1 id="${modalId}" data-antifan-modal-dialog aria-hidden="true"$2`
                );
              } else {
                sectionLiquid += `\n<div id="${modalId}" class="modal popup" data-antifan-modal-dialog aria-hidden="true"><div class="modal-content"><button class="close-btn" data-antifan-modal-close aria-label="Đóng">&times;</button><div class="modal-body"></div></div></div>`;
              }
            }
            if (!sectionLiquid.includes('data-antifan-modal-close')) {
              sectionLiquid = sectionLiquid.replace(
                /(<button\b[^>]*class=["'][^"']*(?:close|modal-close|btn-close)[^"']*["'])([^>]*>)/i,
                `$1 data-antifan-modal-close$2`
              );
            }
          }
        }

        // 6b. Dynamic Liquid Binding via LiquidBindingEngine
        const sectionContext = `${sec.id} ${sec.name} ${sec.className || ''}`.toLowerCase();

        if (
          (sec.archetype === 'rich_text' && /(?:article|blog|post|news)/i.test(sectionContext)) ||
          /(?:article|blog|post|news)/i.test(sectionContext) ||
          /(?:article-content|post-content|entry-content|article__content|article-title|post-title|article__title)/i.test(sectionLiquid)
        ) {
          sectionLiquid = this.liquidBindingEngine.bindArticleSection(sectionLiquid);
        } else if (
          sec.archetype === 'product_grid' ||
          sec.archetype === 'collection_list' ||
          /(?:product-grid|product-list|collection|featured-products)/i.test(sectionContext) ||
          /(?:product-grid|product-list|collection-products)/i.test(sectionLiquid)
        ) {
          sectionLiquid = this.liquidBindingEngine.bindCollectionSection(sectionLiquid);
        } else if (
          /(?:product-detail|product-single|product-info|product-form|single-product)/i.test(sectionContext) ||
          /(?:product-detail|product-single|product-info|btn-add-to-cart|add-to-cart)/i.test(sectionLiquid)
        ) {
          sectionLiquid = this.liquidBindingEngine.bindProductSection(sectionLiquid);
        }

        // Apply DotLiquid sanitization against .NET quirks
        sectionLiquid = this.liquidBindingEngine.sanitizeDotLiquid(sectionLiquid);

        // 6c. Dynamic Schema Wrapping via HaravanSchemaGenerator
        const sectionSchema = this.schemaGen.extractSectionSchema({
          id: sec.id,
          name: sec.name,
          tag: 'section',
          className: sec.className || `section-${sec.id}`,
          archetype: sec.archetype,
          layoutType: sec.layoutType,
          heading: sec.heading,
          rawHtml: sec.rawHtml,
          schemaSettings: sec.schemaSettings,
          blockDefinitions: sec.blockDefinitions as unknown as HaravanBlockDefinition[],
          blocks: sec.blocks as unknown as Array<{ id?: string; type: string; settings?: Record<string, unknown> }>,
          settings: sec.settings
        });

        if (!Array.isArray(sectionSchema.blocks)) {
          sectionSchema.blocks = [];
        }

        const sectionContent = this.schemaGen.generateSectionLiquidWithSchema(sectionLiquid, sectionSchema);

        const sectionPath = path.join(stagingDir, 'sections', `${sec.id}.liquid`);
        fs.writeFileSync(sectionPath, sectionContent, 'utf-8');
        filesWritten.push(sectionPath);
      }
      // 7. Generate snippets
      const snippetFiles = this.snippetGen.generateSnippets(path.join(stagingDir, 'snippets'));
      filesWritten.push(...snippetFiles);
      // 8. Generate config/settings_schema.json
      const siteSettings = ir.normalizedData?.siteSettings;
      const themeTitle = (typeof siteSettings?.title === 'string' && siteSettings.title) || 'Storefront Pro';
      const hotline = (typeof siteSettings?.hotline === 'string' && siteSettings.hotline) || '';
      const email = (typeof siteSettings?.email === 'string' && siteSettings.email) || '';
      const schemaPath = path.join(stagingDir, 'config', 'settings_schema.json');
      fs.writeFileSync(schemaPath, this.schemaGen.generateSettingsSchema(themeTitle, hotline, email), 'utf-8');
      filesWritten.push(schemaPath);

      // 8b. Generate config/settings_data.json
      const settingsDataPath = path.join(stagingDir, 'config', 'settings_data.json');
      const settingsData = {
        current: {
          theme_title: themeTitle,
          hotline,
          email
        },
        presets: {
          Default: {
            theme_title: themeTitle,
            hotline,
            email
          }
        }
      };
      fs.writeFileSync(settingsDataPath, JSON.stringify(settingsData, null, 2), 'utf-8');
      filesWritten.push(settingsDataPath);

      // 9. Generate assets/theme.js (universal declarative runtime)
      const themeJsPath = path.join(stagingDir, 'assets', 'theme.js');
      fs.writeFileSync(themeJsPath, this.stateSynth.generateDeclarativeRuntime(), 'utf-8');
      filesWritten.push(themeJsPath);
      // 9b. Generate assets/theme-responsive.css when layout relations are defined
      if (ir.layout?.relations && ir.layout.relations.length > 0) {
        const desktopCols = ir.layout.relations.find(r => r.viewport === 'desktop' && r.type === 'column-count')?.value || 4;
        const tabletCols = ir.layout.relations.find(r => r.viewport === 'tablet' && r.type === 'column-count')?.value || 2;
        const mobileCols = ir.layout.relations.find(r => r.viewport === 'mobile' && r.type === 'column-count')?.value || 1;
        const gap = ir.layout.relations.find(r => r.type === 'gap')?.value || ir.layout.gridGapPx || 16;
        
        const responsiveCssContent = [
          `/* Generated Responsive Layout Constraints */`,
          `:root {`,
          `  --antifan-container-max: ${ir.layout.containerMaxWidth}px;`,
          `  --antifan-container-pad: ${ir.layout.containerPaddingPx}px;`,
          `  --antifan-grid-gap: ${gap}px;`,
          `}`,
          `@media (min-width: 1025px) {`,
          `  .antifan-responsive-grid { display: grid; grid-template-columns: repeat(${desktopCols}, 1fr); gap: var(--antifan-grid-gap); }`,
          `}`,
          `@media (min-width: 768px) and (max-width: 1024px) {`,
          `  .antifan-responsive-grid { display: grid; grid-template-columns: repeat(${tabletCols}, 1fr); gap: var(--antifan-grid-gap); }`,
          `}`,
          `@media (max-width: 767px) {`,
          `  .antifan-responsive-grid { display: grid; grid-template-columns: repeat(${mobileCols}, 1fr); gap: var(--antifan-grid-gap); }`,
          `}`
        ].join('\n');
        const responsiveCssPath = path.join(stagingDir, 'assets', 'theme-responsive.css');
        fs.writeFileSync(responsiveCssPath, responsiveCssContent, 'utf-8');
        filesWritten.push(responsiveCssPath);
      }
      if (ir.assets) {
        const allAssets = [
          ...(ir.assets.stylesheets || []),
          ...(ir.assets.javascripts || []),
          ...(ir.assets.images || []),
          ...(ir.assets.fonts || [])
        ];
        for (const item of allAssets) {
          if (item.localPath && fs.existsSync(item.localPath)) {
            const destAssetPath = path.join(stagingDir, 'assets', item.filename);
            fs.copyFileSync(item.localPath, destAssetPath);
            filesWritten.push(destAssetPath);
          }
        }
      }
      // 9c. Normalize undeclared settings and synthesize missing assets before final commit
      const normResult = SettingsAssetsNormalizer.normalizeTheme(stagingDir);
      if (normResult.assetResult && Array.isArray(normResult.assetResult.synthesizedAssets)) {
        for (const synthesized of normResult.assetResult.synthesizedAssets) {
          const synthesizedPath = path.join(stagingDir, 'assets', path.basename(synthesized));
          if (fs.existsSync(synthesizedPath) && !filesWritten.includes(synthesizedPath)) {
            filesWritten.push(synthesizedPath);
          }
        }
      }
      // 10. Validate staging integrity before swap
      this.validateStagingTheme(stagingDir);
      this.atomicSwap(stagingDir, outputDir, dirs);
      return {
        success: true,
        sectionCount: sections.length,
        filesWritten: filesWritten.map(f => path.join(outputDir, path.relative(stagingDir, f)))
      };
    } finally {
      try { fs.rmSync(stagingDir, { recursive: true, force: true }); } catch {}
    }
  }

  private atomicSwap(stagingDir: string, outputDir: string, dirs: string[]): void {
    fs.mkdirSync(outputDir, { recursive: true });
    const backupDir = fs.mkdtempSync(path.join(os.tmpdir(), 'antifan-theme-backup-'));
    try {
      for (const d of dirs) {
        const destSub = path.join(outputDir, d);
        if (fs.existsSync(destSub)) fs.cpSync(destSub, path.join(backupDir, d), { recursive: true });
      }
      for (const d of dirs) {
        const destSub = path.join(outputDir, d);
        if (fs.existsSync(destSub)) fs.rmSync(destSub, { recursive: true, force: true });
        const srcSub = path.join(stagingDir, d);
        if (fs.existsSync(srcSub)) fs.cpSync(srcSub, destSub, { recursive: true });
      }
    } catch (swapErr) {
      try {
        for (const d of dirs) {
          const backupSub = path.join(backupDir, d);
          const destSub = path.join(outputDir, d);
          if (fs.existsSync(backupSub)) {
            if (fs.existsSync(destSub)) fs.rmSync(destSub, { recursive: true, force: true });
            fs.cpSync(backupSub, destSub, { recursive: true });
          }
        }
      } catch {}
      throw swapErr;
    } finally {
      try { fs.rmSync(backupDir, { recursive: true, force: true }); } catch {}
    }
  }


  private validateStagingTheme(stagingDir: string): void {
    const layout = path.join(stagingDir, 'layout', 'theme.liquid');
    if (!fs.existsSync(layout) || fs.statSync(layout).size === 0) {
      throw new Error('ThemeCompiler: layout/theme.liquid validation failed');
    }

    const indexJson = path.join(stagingDir, 'templates', 'index.json');
    if (!fs.existsSync(indexJson) || fs.statSync(indexJson).size === 0) {
      throw new Error('ThemeCompiler: templates/index.json validation failed');
    }

    // Verify valid JSON and theme graph connectivity
    try {
      const parsedIndex = JSON.parse(fs.readFileSync(indexJson, 'utf-8'));
      if (parsedIndex.sections && typeof parsedIndex.sections === 'object') {
        for (const [secKey, secObj] of Object.entries(parsedIndex.sections)) {
          const secType = (secObj as any)?.type || secKey;
          const secPath = path.join(stagingDir, 'sections', `${secType}.liquid`);
          if (!fs.existsSync(secPath)) {
            throw new Error(`ThemeCompiler: orphaned section reference "${secKey}" (type: "${secType}") - file "${secType}.liquid" not found`);
          }
        }
      }
    } catch (err: unknown) {
      if (err instanceof Error && err.message.startsWith('ThemeCompiler:')) throw err;
      throw new Error(`ThemeCompiler: invalid templates/index.json: ${err instanceof Error ? err.message : String(err)}`);
    }
    const settingsSchema = path.join(stagingDir, 'config', 'settings_schema.json');
    if (!fs.existsSync(settingsSchema) || fs.statSync(settingsSchema).size === 0) {
      throw new Error('ThemeCompiler: config/settings_schema.json validation failed');
    }
  }
}

