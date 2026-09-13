/**
 * Generator: Theme Compiler Orchestrator
 * True atomic staging, validation, and swap to guarantee zero corrupted/partial theme output.
 * Fully cut over to Haravan flat directory architecture (Audit Phase 05).
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { ComponentContractIR } from '../models/clone-ir.js';
import { CloneIRBuilder } from '../models/clone-ir-builder.js';
import { HaravanLayoutGenerator } from './haravan-layout-generator.js';
import { HaravanSnippetGenerator } from './haravan-snippet-generator.js';
import {
  HaravanSchemaGenerator,
  sanitizeSettingId,
} from './haravan-schema-generator.js';
import {
  HaravanLegacySettingsGenerator,
} from './haravan-legacy-settings-generator.js';
import {
  HaravanTargetContract,
  HaravanSettingsMode,
  createHaravanTargetContract,
} from './haravan-target-contract.js';
import { StateSynthesizer } from '../models/state-synthesizer.js';
import {
  AssetLocalizer,
  LocalizeAssetOptions,
  AssetLocalizationPipelineResult,
  rewriteHtmlContent,
} from '../models/asset-localizer.js';
import { LiquidBindingEngine } from './liquid-binding-engine.js';
import { SettingsAssetsNormalizer } from './settings-assets-normalizer.js';
import { DomTreeParser } from '../models/dom-tree-parser.js';

export interface ThemeCompilerOptions {
  targetContract?: HaravanTargetContract;
  settingsMode?: HaravanSettingsMode | string;
  emitLocales?: boolean;
  localizedLocales?: string[];
  [key: string]: unknown;
}

export interface ThemeCompileResult {
  success: boolean;
  sectionCount: number;
  filesWritten: string[];
  targetContract: HaravanTargetContract;
  localization?: AssetLocalizationPipelineResult;
}

export class ThemeCompiler {
  private layoutGen = new HaravanLayoutGenerator();
  private snippetGen = new HaravanSnippetGenerator();
  private schemaGen = new HaravanSchemaGenerator();
  private legacySettingsGen = new HaravanLegacySettingsGenerator();
  private stateSynth = new StateSynthesizer();
  private irBuilder = new CloneIRBuilder();
  private liquidBindingEngine = new LiquidBindingEngine();

  public async compileThemeWithLocalizationAsync(
    outputDir: string,
    input: string | ComponentContractIR,
    options?: Partial<LocalizeAssetOptions> & ThemeCompilerOptions
  ): Promise<ThemeCompileResult> {
    if (!input) {
      throw new Error(
        'ThemeCompiler: input must be a valid non-empty string or ComponentContractIR'
      );
    }
    const ir: ComponentContractIR =
      typeof input === 'string'
        ? this.irBuilder.buildFromHtml(
            input,
            (options?.sourceUrl as string) || 'https://example.com',
            options?.assetsDir as string
          )
        : input;
    const targetContract =
      options?.targetContract || createHaravanTargetContract(options);

    // 1. Compile into an isolated temporary staging directory first
    const tempStageDir = fs.mkdtempSync(
      path.join(os.tmpdir(), 'antifan-theme-async-stage-')
    );
    try {
      const compileRes = this.compileThemeFromIR(tempStageDir, ir, {
        ...options,
        targetContract,
      });

      // 2. If assets exist, run AssetLocalizer.localizePipeline inside the temporary staging directory
      let pipelineRes: AssetLocalizationPipelineResult | undefined;
      if (ir.assets) {
        const assetsDir = path.join(tempStageDir, 'assets');
        fs.mkdirSync(assetsDir, { recursive: true });

        const themeFiles: Array<{ path: string; content: string }> = compileRes.filesWritten
          .filter((f) => /\.(liquid|json|css|js)$/i.test(f) && fs.existsSync(f))
          .map((f) => ({ path: f, content: fs.readFileSync(f, 'utf-8') }));

        const localizer = new AssetLocalizer();
        pipelineRes = await localizer.localizePipeline(themeFiles, ir.assets, {
          assetsDir,
          mode: 'liquid',
          skipDownload: false,
          ...options,
        });

        // Strict fail-closed gate: if audit fails, abort without touching outputDir
        if (!pipelineRes.a3_audit.passed) {
          const findingSummary = pipelineRes.a3_audit.findings
            .map((f) => `[${f.severity}] ${f.code}: ${f.message}`)
            .join('\n');
          throw new Error(
            `ThemeCompiler Asset Audit Failed (Fail-Closed):\n${findingSummary}`
          );
        }

        // Write back rewritten source files containing localized URLs in temp staging
        for (const rewritten of pipelineRes.a2_rewrite.files) {
          fs.writeFileSync(rewritten.path, rewritten.rewrittenContent, 'utf-8');
        }

        for (const assetItem of pipelineRes.a3_audit.verifiedAssets) {
          if (
            assetItem.exists &&
            !compileRes.filesWritten.includes(assetItem.localPath)
          ) {
            compileRes.filesWritten.push(assetItem.localPath);
          }
        }
      }

      // 3. Atomically swap tempStageDir into outputDir only AFTER localization and audit succeed 100%
      const dirs = ['layout', 'templates', 'snippets', 'assets', 'config'];
      if (targetContract.emitLocales) {
        dirs.push('locales');
      }
      this.atomicSwap(tempStageDir, outputDir, dirs);

      return {
        success: true,
        sectionCount: compileRes.sectionCount,
        filesWritten: compileRes.filesWritten.map((f) =>
          path.join(outputDir, path.relative(tempStageDir, f))
        ),
        targetContract,
        localization: pipelineRes,
      };
    } finally {
      try {
        fs.rmSync(tempStageDir, { recursive: true, force: true });
      } catch {}
    }
  }

  public compileTheme(
    outputDir: string,
    input: string | ComponentContractIR,
    options?: ThemeCompilerOptions
  ): ThemeCompileResult {
    if (!input) {
      throw new Error(
        'ThemeCompiler: input must be a valid non-empty string or ComponentContractIR'
      );
    }
    const sanitizedInput =
      typeof input === 'string'
        ? input.replace(
            /<input\s+[^>]*name=["'](?:_token|authenticity_token|csrf[-_]token)["'][^>]*>/gi,
            ''
          )
        : input;

    const ir: ComponentContractIR =
      typeof sanitizedInput === 'string'
        ? this.irBuilder.buildFromHtml(
            sanitizedInput,
            (options?.sourceUrl as string) || 'https://example.com',
            options?.assetsDir as string
          )
        : sanitizedInput;
    return this.compileThemeFromIR(outputDir, ir, options);
  }

  public compileThemeFromIR(
    outputDir: string,
    ir: ComponentContractIR,
    options?: ThemeCompilerOptions
  ): ThemeCompileResult {
    const targetContract =
      options?.targetContract || createHaravanTargetContract(options);

    // 1. Create temporary staging directory for atomic generation
    const stagingDir = fs.mkdtempSync(
      path.join(os.tmpdir(), 'antifan-theme-stage-')
    );
    const filesWritten: string[] = [];

    try {
      // 2. Prepare staging subdirectories: strictly flat Haravan (no sections)
      const dirs = ['layout', 'templates', 'snippets', 'assets', 'config'];
      if (targetContract.emitLocales) {
        dirs.push('locales');
      }

      for (const d of dirs) {
        fs.mkdirSync(path.join(stagingDir, d), { recursive: true });
      }

      // 3. Map sections from ComponentContractIR
      const sections = ir.sections || [];


      // Track all settings read in Liquid to ensure complete settings declaration
      const allReadSettingIds = new Set<string>();
      const emittedSnippetNames = new Set<string>();
      const pageSectionIncludes: Array<{ snippetName: string; enabledSettingId?: string }> = [];

      // Build URL mapping for rewriting asset references into Haravan Liquid format {{ 'filename' | asset_url }}
      const liquidUrlMap = new Map<string, string>();
      const allIrAssets = [
        ...(ir.assets?.stylesheets || []),
        ...(ir.assets?.javascripts || []),
        ...(ir.assets?.images || []),
        ...(ir.assets?.fonts || []),
      ];
      for (const item of allIrAssets) {
        if (item.filename) {
          const rep = `{{ '${item.filename}' | asset_url }}`;
          liquidUrlMap.set(`assets/${item.filename}`, rep);
          liquidUrlMap.set(`/assets/${item.filename}`, rep);
        }
      }
      const isJunkOrThirdPartyAsset = (filename: string): boolean =>
        /(?:twk-|tawk|1hiir|gtm\.js|googletagmanager|analytics\.js|facebook|clarity|subiz|vchat|zalo|hotjar|criteo|emojione|js_98b1fb9e|js\.js)/i.test(filename);

      if (options?.assetsDir && fs.existsSync(options.assetsDir as string)) {
        try {
          const diskFiles = fs.readdirSync(options.assetsDir as string);
          for (const diskFile of diskFiles) {
            if (isJunkOrThirdPartyAsset(diskFile)) continue;
            const rep = `{{ '${diskFile}' | asset_url }}`;
            liquidUrlMap.set(`assets/${diskFile}`, rep);
            liquidUrlMap.set(`/assets/${diskFile}`, rep);
          }
        } catch {}
      }

      // 4. Generate layout/theme.liquid with detected stylesheets and scripts
      // Identify stylesheets that will be bundled into theme.css so they are not linked twice
      const bundledStylesheets = new Set<string>();
      for (const s of ir.assets?.stylesheets || []) {
        if (s.localPath && fs.existsSync(s.localPath) && s.filename) {
          bundledStylesheets.add(s.filename);
        }
      }

      const layoutStylesheets: string[] = [];
      const layoutScripts: string[] = [];
      for (const s of ir.assets?.stylesheets || []) {
        if (s.filename && !isJunkOrThirdPartyAsset(s.filename) && !bundledStylesheets.has(s.filename) && !layoutStylesheets.includes(s.filename)) {
          layoutStylesheets.push(s.filename);
        }
      }
      for (const j of ir.assets?.javascripts || []) {
        if (j.filename && !isJunkOrThirdPartyAsset(j.filename) && !layoutScripts.includes(j.filename)) {
          layoutScripts.push(j.filename);
        }
      }
      if (options?.assetsDir && fs.existsSync(options.assetsDir as string)) {
        try {
          const diskFiles = fs.readdirSync(options.assetsDir as string);
          for (const diskFile of diskFiles) {
            if (isJunkOrThirdPartyAsset(diskFile)) continue;
            if (diskFile.endsWith('.css') && !bundledStylesheets.has(diskFile) && !layoutStylesheets.includes(diskFile)) {
              layoutStylesheets.push(diskFile);
            } else if (diskFile.endsWith('.js') && !layoutScripts.includes(diskFile)) {
              layoutScripts.push(diskFile);
            }
          }
        } catch {}
      }
      layoutScripts.sort((a, b) => {
        if (a.includes('jquery')) return -1;
        if (b.includes('jquery')) return 1;
        if (a.includes('slick')) return -1;
        if (b.includes('slick')) return 1;
        return 0;
      });

      const layoutPath = path.join(stagingDir, 'layout', 'theme.liquid');
      fs.writeFileSync(layoutPath, this.layoutGen.generateThemeLiquid({ stylesheets: layoutStylesheets, scripts: layoutScripts }), 'utf-8');
      filesWritten.push(layoutPath);
      // 5. Generate snippets from IR sections
      for (const sec of sections) {
        let sectionLiquid = '';
        const sectionControllers =
          ir.storefrontRuntime?.controllers?.filter((c) => c.sectionId === sec.id) || [];

        if (sec.liquidTemplate) {
          sectionLiquid = sec.liquidTemplate;
        } else {
          const secCleanId = sanitizeSettingId(sec.id, 'sec');
          const headingMarkup = sec.heading
            ? `\n    {% if settings.${secCleanId}_heading != blank %}\n      <h2 class="title">{{ settings.${secCleanId}_heading | escape }}</h2>\n    {% endif %}`
            : '';
          sectionLiquid = `
<section class="${sec.className || sec.id}" id="${sec.id}">
  <div class="container">${headingMarkup}
    <div class="content">
      <!-- Section Content -->
    </div>
  </div>
</section>
          `.trim();
        }

        // 5a. Strip pre-existing {% schema %}...{% endschema %} blocks
        sectionLiquid = sectionLiquid
          .replace(/\{%\s*schema\s*%\Block?[\s\S]*?\{%\s*endschema\s*%\}/gi, '')
          .trim();

        // 5b. Strip section/block haravan or shopify attributes
        sectionLiquid = sectionLiquid.replace(
          /\{\{\s*(?:block|section)\.(?:shopify|haravan)_attributes\s*\}\}/gi,
          ''
        );

        // 5c. Replace {{ section.id }} with static section identifier
        sectionLiquid = sectionLiquid.replace(
          /\{\{\s*section\.id\s*\}\}/gi,
          sec.id
        );

        // 5d. Replace {% render 'xyz' ... %} with {% include 'xyz' ... %}
        sectionLiquid = sectionLiquid.replace(
          /\{%\s*render\s+(['"][^'"]+['"])([\s\S]*?)%\}/gi,
          '{% include $1$2%}'
        );

        // 5e. Rewrite section.settings.<id> and block.settings.<id> to settings.<mapped_id>
        const secPrefix = sanitizeSettingId(sec.id, 'sec');
        sectionLiquid = sectionLiquid.replace(
          /(?:section|block)\.settings\.([a-zA-Z0-9_]+)/g,
          (_match, key: string) => {
            const mappedId = key.startsWith(secPrefix + '_')
              ? key
              : `${secPrefix}_${key}`;
            const cleanId = sanitizeSettingId(mappedId, 'setting');
            allReadSettingIds.add(cleanId);
            return `settings.${cleanId}`;
          }
        );

        // 5f. Controller injection (carousel, modal, dropdown)
        for (const ctrl of sectionControllers) {
          if (ctrl.type === 'carousel') {
            if (!sectionLiquid.includes('data-antifan-slider')) {
              sectionLiquid = sectionLiquid.replace(
                /<section\b([^>]*)>/i,
                '<section$1 data-antifan-slider data-antifan-autoplay="5000">'
              );
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
            const modalTarget =
              ctrl.targetSelector && ctrl.targetSelector.startsWith('#')
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
              if (
                /(<div\b[^>]*class=["'][^"']*(?:modal|popup|dialog)[^"']*["'])([^>]*>)/i.test(
                  sectionLiquid
                )
              ) {
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

        // 5g. Dynamic Liquid Binding via LiquidBindingEngine
        const sectionContext = `${sec.id} ${sec.name} ${sec.className || ''}`.toLowerCase();

        if (
          (sec.archetype === 'rich_text' && /(?:article|blog|post|news)/i.test(sectionContext)) ||
          /(?:article|blog|post|news)/i.test(sectionContext) ||
          /(?:article-content|post-content|entry-content|article__content|article-title|post-title|article__title)/i.test(
            sectionLiquid
          )
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
          /(?:product-detail|product-single|product-info|product-form|single-product)/i.test(
            sectionContext
          ) ||
          /(?:product-detail|product-single|product-info|btn-add-to-cart|add-to-cart)/i.test(
            sectionLiquid
          )
        ) {
          sectionLiquid = this.liquidBindingEngine.bindProductSection(sectionLiquid);
        }

        // Apply DotLiquid sanitization against .NET quirks
        sectionLiquid = this.liquidBindingEngine.sanitizeDotLiquid(sectionLiquid);

        // Collect any settings read in this snippet
        for (const match of sectionLiquid.matchAll(/settings\.([a-zA-Z0-9_]+)/g)) {
          allReadSettingIds.add(match[1]);
        }
        const rewriteLiquidAssets = (content: string): string => {
          let res = rewriteHtmlContent(content, liquidUrlMap, { mode: 'liquid' }).content;
          res = res.replace(
            /(^|\s)(src|data-src)=(?:"(?:\/?assets\/)?([-a-zA-Z0-9_.@]+\.(?:png|jpe?g|webp|gif|svg|avif|ico))(?:\?[^"]*)?"|'(?:\/?assets\/)?([-a-zA-Z0-9_.@]+\.(?:png|jpe?g|webp|gif|svg|avif|ico))(?:\?[^']*)?')/gi,
            (match, prefix, attr, doubleVal, singleVal) => {
              const filename = doubleVal !== undefined ? doubleVal : singleVal;
              return `${prefix}${attr}="{{ '${filename}' | asset_url }}"`;
            }
          );
          res = res.replace(
            /(^|\s)onerror\s*=\s*(?:"([^"]*)"|'([^']*)')/gi,
            (match, prefix, doubleVal, singleVal) => {
              const val = (doubleVal !== undefined ? doubleVal : singleVal) ?? '';
              const fallbackMatch = val.match(/((?:this\.)?src\s*=\s*)(?:&quot;|['"])(?:\/?assets\/)?([-a-zA-Z0-9_.@]+\.(?:png|jpe?g|webp|gif|svg|avif|ico))(?:\?[^"']*)?(?:&quot;|['"]);?/i);
              if (fallbackMatch) {
                const safeJs = `${fallbackMatch[1]}&quot;{{ '${fallbackMatch[2]}' | asset_url }}&quot;;`;
                const replaced = val.replace(fallbackMatch[0], safeJs);
                return `${prefix}onerror="${replaced}"`;
              }
              return match;
            }
          );
          res = res.replace(
            /(^|\s)(srcset|data-srcset)=(?:"([^"]*)"|'([^']*)')/gi,
            (match, prefix, attr, doubleVal, singleVal) => {
              const val = (doubleVal !== undefined ? doubleVal : singleVal) ?? '';
              const quote = doubleVal !== undefined ? '"' : "'";
              if (val.includes('asset_url')) return match;
              const replaced = val.replace(/(?:\/?assets\/)?([-a-zA-Z0-9_.@]+\.(?:png|jpe?g|webp|gif|svg|avif|ico))/gi, "{{ '$1' | asset_url }}");
              return `${prefix}${attr}=${quote}${replaced}${quote}`;
            }
          );
          return res;
        };

        // Rewrite asset references into Haravan Liquid format and strip dynamic CSRF tokens
        sectionLiquid = rewriteLiquidAssets(sectionLiquid);
        sectionLiquid = sectionLiquid.replace(
          /<input\s+[^>]*name=["'](?:_token|authenticity_token|csrf[-_]token)["'][^>]*>/gi,
          ''
        );

        // Determine destination snippet name
        const mobileIndexPath = options?.assetsDir
          ? path.join(path.dirname(options.assetsDir as string), 'mobile', 'index.html')
          : '';
        const hasMobileSurface = Boolean(mobileIndexPath && fs.existsSync(mobileIndexPath));

        if (sec.archetype === 'header') {
          let headerOutput = sectionLiquid;
          if (hasMobileSurface) {
            try {
              const mobileHtml = fs.readFileSync(mobileIndexPath, 'utf-8');
              const mobileRoot = DomTreeParser.parse(mobileHtml);
              const mobileHeaders = DomTreeParser.findByTag(mobileRoot, 'header');
              if (mobileHeaders.length > 0) {
                let mobileHeaderContent = mobileHeaders[0].outerHtml;
                if (!mobileHeaderContent.includes('category-navigation__block')) {
                  const drawers = DomTreeParser.findByClass(mobileRoot, 'category-navigation__block');
                  if (drawers.length > 0) {
                    mobileHeaderContent += '\n' + drawers[0].outerHtml;
                  }
                }
                // Strip CSRF token from mobile header
                mobileHeaderContent = mobileHeaderContent.replace(
                  /<input\s+[^>]*name=["'](?:_token|authenticity_token|csrf[-_]token)["'][^>]*>/gi,
                  ''
                );
                // Rewrite asset URLs with comprehensive liquid rewrite
                mobileHeaderContent = rewriteLiquidAssets(mobileHeaderContent);

                headerOutput = `<div class="desktop-only">\n${sectionLiquid}\n</div>\n<div class="mobile-only">\n${mobileHeaderContent}\n</div>`;
              }
            } catch {}
          }
          const headerSnippetPath = path.join(stagingDir, 'snippets', 'header.liquid');
          fs.writeFileSync(headerSnippetPath, headerOutput, 'utf-8');
          filesWritten.push(headerSnippetPath);
          emittedSnippetNames.add('header');
        } else if (sec.archetype === 'footer') {
          let footerOutput = sectionLiquid;
          if (hasMobileSurface) {
            try {
              const mobileHtml = fs.readFileSync(mobileIndexPath, 'utf-8');
              const mobileRoot = DomTreeParser.parse(mobileHtml);
              const bottomNavs = DomTreeParser.findByClass(mobileRoot, 'bottom-navigation');
              if (bottomNavs.length > 0) {
                let mobileExtra = bottomNavs[0].outerHtml;
                mobileExtra = mobileExtra.replace(
                  /<input\s+[^>]*name=["'](?:_token|authenticity_token|csrf[-_]token)["'][^>]*>/gi,
                  ''
                );
                mobileExtra = rewriteLiquidAssets(mobileExtra);

                footerOutput = `${sectionLiquid}\n<div class="mobile-only">\n${mobileExtra}\n</div>`;
              }
            } catch {}
          }
          const footerSnippetPath = path.join(stagingDir, 'snippets', 'footer.liquid');
          fs.writeFileSync(footerSnippetPath, footerOutput, 'utf-8');
          filesWritten.push(footerSnippetPath);
          emittedSnippetNames.add('footer');
        } else {
          let snippetName = sanitizeSettingId(sec.id, 'sec');
          if (emittedSnippetNames.has(snippetName)) {
            snippetName = `${snippetName}_${filesWritten.length}`;
          }
          emittedSnippetNames.add(snippetName);

          const enabledId = `${snippetName}_enabled`;
          allReadSettingIds.add(enabledId);

          if (
            hasMobileSurface &&
            (sec.id.includes('hero_slider') || sec.id.includes('slide') || sec.archetype === 'hero_slider')
          ) {
            try {
              const mobileHtml = fs.readFileSync(mobileIndexPath, 'utf-8');
              const mobileRoot = DomTreeParser.parse(mobileHtml);
              const mobileMenus = DomTreeParser.findByClass(mobileRoot, 'menu-header');
              if (mobileMenus.length > 0) {
                let menuContent = mobileMenus[0].outerHtml;
                menuContent = menuContent.replace(
                  /<input\s+[^>]*name=["'](?:_token|authenticity_token|csrf[-_]token)["'][^>]*>/gi,
                  ''
                );
                menuContent = rewriteLiquidAssets(menuContent);
                sectionLiquid += `\n<div class="mobile-only">\n${menuContent}\n</div>`;
              }
            } catch {}
          }
          const snippetPath = path.join(stagingDir, 'snippets', `${snippetName}.liquid`);
          fs.writeFileSync(snippetPath, sectionLiquid, 'utf-8');
          filesWritten.push(snippetPath);

          pageSectionIncludes.push({
            snippetName,
            enabledSettingId: enabledId,
          });
        }
      }

      // 6. Generate flat templates/index.liquid composed with {% include %}
      const indexLines: string[] = [];
      for (const item of pageSectionIncludes) {
        if (item.enabledSettingId) {
          indexLines.push(`{% unless settings.${item.enabledSettingId} == false %}`);
          indexLines.push(`  {% include '${item.snippetName}' %}`);
          indexLines.push('{% endunless %}');
        } else {
          indexLines.push(`{% include '${item.snippetName}' %}`);
        }
      }

      const indexLiquidContent =
        indexLines.length > 0 ? indexLines.join('\n') + '\n' : '<!-- Empty Index -->\n';
      const indexLiquidPath = path.join(stagingDir, 'templates', 'index.liquid');
      fs.writeFileSync(indexLiquidPath, indexLiquidContent, 'utf-8');
      filesWritten.push(indexLiquidPath);

      // 7. Generate standard modular snippets. Snippets already emitted from the
      // source IR (cloned header/footer chrome) are excluded: the generic stub
      // must not overwrite cloned markup.
      const standardSnippetFiles = this.snippetGen.generateSnippets(
        path.join(stagingDir, 'snippets'),
        emittedSnippetNames
      );
      for (const sf of standardSnippetFiles) {
        if (!filesWritten.includes(sf)) {
          filesWritten.push(sf);
        }
      }

      // Collect all settings reads from all emitted liquid files
      for (const f of filesWritten) {
        if (f.endsWith('.liquid') && fs.existsSync(f)) {
          const content = fs.readFileSync(f, 'utf-8');
          for (const m of content.matchAll(/settings\.([a-zA-Z0-9_]+)/g)) {
            allReadSettingIds.add(m[1]);
          }
        }
      }

      // 8. Generate config files based strictly on targetContract.settingsMode
      const settingsDataPath = path.join(stagingDir, 'config', 'settings_data.json');
      const settingsDataMap: Record<string, unknown> = {};

      if (targetContract.settingsMode === 'legacy-html') {
        // Mode 1: legacy-html -> config/settings.html + config/settings_data.json
        const legacyGroups = this.legacySettingsGen.buildGroupsFromIR(
          ir,
          allReadSettingIds
        );
        const settingsHtmlContent = this.legacySettingsGen.generateSettingsHtml(
          legacyGroups
        );
        const settingsHtmlPath = path.join(stagingDir, 'config', 'settings.html');
        fs.writeFileSync(settingsHtmlPath, settingsHtmlContent, 'utf-8');
        filesWritten.push(settingsHtmlPath);

        // Populate settings_data.json with default values from groups
        for (const g of legacyGroups) {
          if (g.isOptional && g.enabledSettingId) {
            settingsDataMap[g.enabledSettingId] = g.enabledDefault !== false;
          }
          for (const f of g.fields) {
            settingsDataMap[f.id] = f.default !== undefined ? f.default : '';
          }
        }
      } else {
        // Mode 2: f1genz-schema -> config/settings_schema.json + config/settings_data.json
        const schemaGroups = this.schemaGen.buildThemeSettingsGroupsFromIR(
          ir,
          undefined,
          allReadSettingIds
        );
        const schemaJsonContent = JSON.stringify(schemaGroups, null, 2);
        const schemaPath = path.join(stagingDir, 'config', 'settings_schema.json');
        fs.writeFileSync(schemaPath, schemaJsonContent, 'utf-8');
        filesWritten.push(schemaPath);

        // Populate settings_data.json with default values from schema groups
        for (const g of schemaGroups) {
          if (Array.isArray(g.settings)) {
            for (const s of g.settings) {
              if (s.id) {
                settingsDataMap[s.id] = s.default !== undefined ? s.default : '';
              }
            }
          }
        }
      }

      // Ensure every setting read by Liquid has an entry in settings_data.json
      for (const id of allReadSettingIds) {
        if (!(id in settingsDataMap)) {
          settingsDataMap[id] =
            id.includes('enable') || id.includes('show') || id.includes('active')
              ? true
              : '';
        }
      }

      const settingsData = {
        current: settingsDataMap,
        presets: {
          Default: settingsDataMap,
        },
      };
      fs.writeFileSync(
        settingsDataPath,
        JSON.stringify(settingsData, null, 2),
        'utf-8'
      );
      filesWritten.push(settingsDataPath);

      // 9. Generate assets/theme.js (universal declarative runtime)
      const themeJsPath = path.join(stagingDir, 'assets', 'theme.js');
      fs.writeFileSync(themeJsPath, this.stateSynth.generateDeclarativeRuntime(), 'utf-8');
      filesWritten.push(themeJsPath);

      // 9b. Generate assets/theme-responsive.css when layout relations are defined
      if (ir.layout?.relations && ir.layout.relations.length > 0) {
        const desktopCols =
          ir.layout.relations.find(
            (r) => r.viewport === 'desktop' && r.type === 'column-count'
          )?.value || 4;
        const tabletCols =
          ir.layout.relations.find(
            (r) => r.viewport === 'tablet' && r.type === 'column-count'
          )?.value || 2;
        const mobileCols =
          ir.layout.relations.find(
            (r) => r.viewport === 'mobile' && r.type === 'column-count'
          )?.value || 1;
        const gap =
          ir.layout.relations.find((r) => r.type === 'gap')?.value ||
          ir.layout.gridGapPx ||
          16;

        const responsiveCssContent = [
          '/* Generated Responsive Layout Constraints */',
          ':root {',
          `  --antifan-container-max: ${ir.layout.containerMaxWidth}px;`,
          `  --antifan-container-pad: ${ir.layout.containerPaddingPx}px;`,
          `  --antifan-grid-gap: ${gap}px;`,
          '}',
          '@media (min-width: 1025px) {',
          `  .antifan-responsive-grid { display: grid; grid-template-columns: repeat(${desktopCols}, 1fr); gap: var(--antifan-grid-gap); }`,
          '}',
          '@media (min-width: 768px) and (max-width: 1024px) {',
          `  .antifan-responsive-grid { display: grid; grid-template-columns: repeat(${tabletCols}, 1fr); gap: var(--antifan-grid-gap); }`,
          '}',
          '@media (max-width: 767px) {',
          `  .antifan-responsive-grid { display: grid; grid-template-columns: repeat(${mobileCols}, 1fr); gap: var(--antifan-grid-gap); }`,
          '}',
        ].join('\n');
        const responsiveCssPath = path.join(
          stagingDir,
          'assets',
          'theme-responsive.css'
        );
        fs.writeFileSync(responsiveCssPath, responsiveCssContent, 'utf-8');
        filesWritten.push(responsiveCssPath);
      }

      // Bundle site stylesheets and head styles into theme.css
      const themeCssParts: string[] = [];
      if (ir.assets?.stylesheets) {
        for (const sheet of ir.assets.stylesheets) {
          if (sheet.localPath && fs.existsSync(sheet.localPath)) {
            try {
              themeCssParts.push(`/* Source: ${sheet.filename} */\n` + fs.readFileSync(sheet.localPath, 'utf-8'));
            } catch {}
          }
        }
      }
      if (Array.isArray(ir.headStyles)) {
        for (const styleBlock of ir.headStyles) {
          const stripped = styleBlock.replace(/^<style\b[^>]*>/i, '').replace(/<\/style>$/i, '');
          if (stripped.trim().length > 0) {
            themeCssParts.push('/* Head Style Block */\n' + stripped.trim());
          }
        }
      }
      const themeCssPath = path.join(stagingDir, 'assets', 'theme.css');
      if (themeCssParts.length > 0) {
        let bundledCss = themeCssParts.join('\n\n');
        // Clean absolute or build/ assets paths in CSS urls to relative filename
        bundledCss = bundledCss.replace(/url\(\s*(['"]?)(?:\/build\/assets\/|\/assets\/|assets\/)?([-a-zA-Z0-9_.]+\.(?:ttf|woff2?|eot|otf|png|jpe?g|svg|webp|gif))\1\s*\)/gi, 'url("$2")');
        fs.writeFileSync(themeCssPath, bundledCss, 'utf-8');
      } else if (!fs.existsSync(themeCssPath)) {
        fs.writeFileSync(themeCssPath, '/* Haravan Theme CSS */\n', 'utf-8');
      }
      if (!filesWritten.includes(themeCssPath)) filesWritten.push(themeCssPath);

      const customCssPath = path.join(stagingDir, 'assets', 'custom.css');
      const customCssDefault = `/* Haravan Custom Overrides & Adaptive Parity */
/* Hero slider geometry. The compiler strips the pixel geometry the source slider
   measured at capture time, so slides size from the viewport and the track is a
   horizontal scroller for both theme.js and native touch. */
.s-wrap, .s-slide {
  overflow: hidden;
  position: relative;
}
.s-wrap .s-content, .s-slide .s-content {
  display: flex;
  flex-wrap: nowrap;
  overflow-x: auto;
  -webkit-overflow-scrolling: touch;
  scroll-snap-type: x mandatory;
  scrollbar-width: none;
  touch-action: pan-y;
}
.s-wrap .s-content::-webkit-scrollbar, .s-slide .s-content::-webkit-scrollbar {
  display: none;
}
.s-wrap .s-content > .item, .s-slide .s-content > .item {
  flex: 0 0 100%;
  max-width: 100%;
  scroll-snap-align: start;
}
.s-wrap .s-content > .item img, .s-slide .s-content > .item img {
  width: 100%;
  height: auto;
  display: block;
}
@media (min-width: 992px) {
  .mobile-only {
    display: none;
  }
}
@media (max-width: 991px) {
  .desktop-only {
    display: none;
  }
  .mobile-only {
    display: block;
  }
  .block-category .product-grid {
    display: grid;
    grid-template-columns: repeat(2, 1fr);
    gap: 12px;
  }
  .block-category .product-grid .product-card {
    width: 100%;
    max-width: 100%;
  }
  .accessory-content__list {
    display: flex;
    overflow-x: auto;
    -webkit-overflow-scrolling: touch;
    gap: 12px;
    padding-bottom: 10px;
  }
  .accessory-content__list > * {
    flex: 0 0 45%;
    max-width: 45%;
  }
  .news .s-content {
    display: flex;
    overflow-x: auto;
    -webkit-overflow-scrolling: touch;
    gap: 12px;
  }
  .news .s-content .item {
    flex: 0 0 75%;
    max-width: 75%;
  }
  .slide-content > .category-navigation {
    display: none;
  }
  .slide-content {
    flex-direction: column;
    padding: 10px 0;
  }
  .slide-content__detail {
    flex: 0 0 100%;
    max-width: 100%;
    margin-left: 0;
  }
  .slide .menu-header {
    width: 100%;
    overflow-x: auto;
    -webkit-overflow-scrolling: touch;
    padding: 10px 0;
  }
  .slide .menu-header .menu-list {
    display: flex;
    flex-wrap: nowrap;
    gap: 12px;
    padding: 0 15px;
    margin: 0;
    list-style: none;
  }
  .slide .menu-header .menu-list__item {
    flex: 0 0 auto;
    text-align: center;
  }
  .slide .menu-header .menu-link {
    display: flex;
    flex-direction: column;
    align-items: center;
    text-decoration: none;
  }
  .slide .menu-header .menu-link__icon {
    width: 44px;
    height: 44px;
    margin-bottom: 6px;
  }
  .slide .menu-header .menu-link__name {
    font-size: 11px;
    color: #333;
    white-space: nowrap;
  }
}
`;
      fs.writeFileSync(customCssPath, customCssDefault, 'utf-8');
      if (!filesWritten.includes(customCssPath)) filesWritten.push(customCssPath);

      // Copy IR harvested assets
      if (ir.assets) {
        const allAssets = [
          ...(ir.assets.stylesheets || []),
          ...(ir.assets.javascripts || []),
          ...(ir.assets.images || []),
          ...(ir.assets.fonts || []),
        ];
        for (const item of allAssets) {
          if (item.localPath && fs.existsSync(item.localPath)) {
            const destAssetPath = path.join(stagingDir, 'assets', item.filename);
            if (!fs.existsSync(destAssetPath)) {
              if (/(?:_2|mobile|-mobile)\.css$/i.test(item.filename)) {
                const rawCss = fs.readFileSync(item.localPath, 'utf-8');
                const cleanCss = rawCss.replace(/^\s*@charset\s+["'][^"']+["'];\s*/i, '');
                const wrappedCss = cleanCss.trim().startsWith('@media (max-width: 991px)')
                  ? rawCss
                  : `@charset "UTF-8";\n@media (max-width: 991px) {\n${cleanCss}\n}`;
                fs.writeFileSync(destAssetPath, wrappedCss, 'utf-8');
              } else {
                fs.copyFileSync(item.localPath, destAssetPath);
              }
            }
            if (!filesWritten.includes(destAssetPath)) filesWritten.push(destAssetPath);
          }
        }
      }
      if (options?.assetsDir && fs.existsSync(options.assetsDir as string)) {
        try {
          const diskFiles = fs.readdirSync(options.assetsDir as string);
          for (const diskFile of diskFiles) {
            if (isJunkOrThirdPartyAsset(diskFile)) continue;
            const srcPath = path.join(options.assetsDir as string, diskFile);
            const destPath = path.join(stagingDir, 'assets', diskFile);
            if (fs.statSync(srcPath).isFile() && !fs.existsSync(destPath)) {
              if (/(?:_2|mobile|-mobile)\.css$/i.test(diskFile)) {
                const rawCss = fs.readFileSync(srcPath, 'utf-8');
                const cleanCss = rawCss.replace(/^\s*@charset\s+["'][^"']+["'];\s*/i, '');
                const wrappedCss = cleanCss.trim().startsWith('@media (max-width: 991px)')
                  ? rawCss
                  : `@charset "UTF-8";\n@media (max-width: 991px) {\n${cleanCss}\n}`;
                fs.writeFileSync(destPath, wrappedCss, 'utf-8');
              } else {
                fs.copyFileSync(srcPath, destPath);
              }
              if (!filesWritten.includes(destPath)) filesWritten.push(destPath);
            }
          }
        } catch {}
      }
      // 9c. Normalize undeclared settings and synthesize missing assets before final commit
      const normResult = SettingsAssetsNormalizer.normalizeTheme(
        stagingDir,
        targetContract.settingsMode
      );
      if (
        normResult.assetResult &&
        Array.isArray(normResult.assetResult.synthesizedAssets)
      ) {
        for (const synthesized of normResult.assetResult.synthesizedAssets) {
          const synthesizedPath = path.join(
            stagingDir,
            'assets',
            path.basename(synthesized)
          );
          if (
            fs.existsSync(synthesizedPath) &&
            !filesWritten.includes(synthesizedPath)
          ) {
            filesWritten.push(synthesizedPath);
          }
        }
      }

      // 10. Validate staging integrity before swap
      this.validateStagingTheme(stagingDir, targetContract);
      this.atomicSwap(stagingDir, outputDir, dirs);

      return {
        success: true,
        sectionCount: sections.length,
        filesWritten: filesWritten.map((f) =>
          path.join(outputDir, path.relative(stagingDir, f))
        ),
        targetContract,
      };
    } finally {
      try {
        fs.rmSync(stagingDir, { recursive: true, force: true });
      } catch {}
    }
  }

  private atomicSwap(stagingDir: string, outputDir: string, dirs: string[]): void {
    fs.mkdirSync(outputDir, { recursive: true });
    // Directories a flat Haravan theme must never contain. A previous OS 2.0
    // build leaves `sections/` (and `locales/` when not emitted) behind; they
    // are backed up and removed so the output always matches the contract.
    const purgeDirs = ['sections', 'locales'].filter((d) => !dirs.includes(d));
    const swapDirs = [...dirs, ...purgeDirs];
    const backupDir = fs.mkdtempSync(
      path.join(os.tmpdir(), 'antifan-theme-backup-')
    );
    try {
      for (const d of swapDirs) {
        const destSub = path.join(outputDir, d);
        if (fs.existsSync(destSub)) {
          fs.cpSync(destSub, path.join(backupDir, d), { recursive: true });
        }
      }
      for (const d of dirs) {
        const destSub = path.join(outputDir, d);
        if (fs.existsSync(destSub)) {
          fs.rmSync(destSub, { recursive: true, force: true });
        }
        const srcSub = path.join(stagingDir, d);
        if (fs.existsSync(srcSub)) {
          fs.cpSync(srcSub, destSub, { recursive: true });
        }
      }
      for (const d of purgeDirs) {
        const destSub = path.join(outputDir, d);
        if (fs.existsSync(destSub)) {
          fs.rmSync(destSub, { recursive: true, force: true });
        }
      }
    } catch (swapErr) {
      try {
        for (const d of swapDirs) {
          const backupSub = path.join(backupDir, d);
          const destSub = path.join(outputDir, d);
          if (fs.existsSync(backupSub)) {
            if (fs.existsSync(destSub)) {
              fs.rmSync(destSub, { recursive: true, force: true });
            }
            fs.cpSync(backupSub, destSub, { recursive: true });
          }
        }
      } catch {}
      throw swapErr;
    } finally {
      try {
        fs.rmSync(backupDir, { recursive: true, force: true });
      } catch {}
    }
  }

  public validateStagingTheme(
    stagingDir: string,
    targetContract?: HaravanTargetContract
  ): void {
    const layout = path.join(stagingDir, 'layout', 'theme.liquid');
    if (!fs.existsSync(layout) || fs.statSync(layout).size === 0) {
      throw new Error('ThemeCompiler: layout/theme.liquid validation failed');
    }

    // Haravan must have flat templates/index.liquid
    const indexLiquid = path.join(stagingDir, 'templates', 'index.liquid');
    if (!fs.existsSync(indexLiquid) || fs.statSync(indexLiquid).size === 0) {
      throw new Error('ThemeCompiler: templates/index.liquid validation failed');
    }

    // Negative check: templates/*.json must NEVER exist
    const templatesDir = path.join(stagingDir, 'templates');
    if (fs.existsSync(templatesDir)) {
      const templateFiles = fs.readdirSync(templatesDir);
      for (const tf of templateFiles) {
        if (tf.endsWith('.json')) {
          throw new Error(
            `ThemeCompiler: forbidden JSON template detected: templates/${tf}. Haravan requires flat .liquid templates only.`
          );
        }
      }
    }

    // Negative check: sections/ directory must NEVER exist
    const sectionsDir = path.join(stagingDir, 'sections');
    if (fs.existsSync(sectionsDir)) {
      throw new Error(
        'ThemeCompiler: forbidden sections/ directory detected. Haravan architecture does not support OS 2.0 sections/.'
      );
    }

    // Settings mode check
    const settingsHtmlPath = path.join(stagingDir, 'config', 'settings.html');
    const settingsSchemaPath = path.join(stagingDir, 'config', 'settings_schema.json');
    const settingsDataPath = path.join(stagingDir, 'config', 'settings_data.json');

    if (!fs.existsSync(settingsDataPath) || fs.statSync(settingsDataPath).size === 0) {
      throw new Error('ThemeCompiler: config/settings_data.json validation failed');
    }

    const mode = targetContract?.settingsMode || 'legacy-html';
    if (mode === 'legacy-html') {
      if (!fs.existsSync(settingsHtmlPath) || fs.statSync(settingsHtmlPath).size === 0) {
        throw new Error(
          'ThemeCompiler: config/settings.html validation failed for legacy-html mode'
        );
      }
      if (fs.existsSync(settingsSchemaPath)) {
        throw new Error(
          'ThemeCompiler: forbidden config/settings_schema.json detected in legacy-html mode'
        );
      }

      // Check pure HTML (no Liquid tags)
      const settingsHtml = fs.readFileSync(settingsHtmlPath, 'utf-8');
      if (settingsHtml.includes('{%') || settingsHtml.includes('{{')) {
        throw new Error(
          'ThemeCompiler: config/settings.html contains forbidden Liquid tags. Pure HTML required.'
        );
      }
    } else if (mode === 'f1genz-schema') {
      if (!fs.existsSync(settingsSchemaPath) || fs.statSync(settingsSchemaPath).size === 0) {
        throw new Error(
          'ThemeCompiler: config/settings_schema.json validation failed for f1genz-schema mode'
        );
      }
      if (fs.existsSync(settingsHtmlPath)) {
        throw new Error(
          'ThemeCompiler: forbidden config/settings.html detected in f1genz-schema mode'
        );
      }

      try {
        JSON.parse(fs.readFileSync(settingsSchemaPath, 'utf-8'));
      } catch (err: unknown) {
        throw new Error(
          `ThemeCompiler: invalid config/settings_schema.json: ${err instanceof Error ? err.message : String(err)}`
        );
      }
    }

    // Include connectivity check: every {% include 'x' %} resolves to an emitted snippet
    const scanDirs = ['layout', 'templates', 'snippets'];
    const snippetNames = new Set<string>();
    const snippetsDir = path.join(stagingDir, 'snippets');
    if (fs.existsSync(snippetsDir)) {
      for (const sf of fs.readdirSync(snippetsDir)) {
        if (sf.endsWith('.liquid')) {
          snippetNames.add(sf.replace(/\.liquid$/, ''));
        }
      }
    }

    const includeRegex = /\{%-?\s*include\s+['"]([a-zA-Z0-9_/-]+)['"]/g;
    for (const d of scanDirs) {
      const fullDirPath = path.join(stagingDir, d);
      if (fs.existsSync(fullDirPath)) {
        for (const file of fs.readdirSync(fullDirPath)) {
          if (file.endsWith('.liquid')) {
            const filePath = path.join(fullDirPath, file);
            const content = fs.readFileSync(filePath, 'utf-8');

            // Check forbidden {% schema %}
            if (/\{%\s*schema\s*%\}/i.test(content)) {
              throw new Error(
                `ThemeCompiler: forbidden {% schema %} tag detected in ${d}/${file}`
              );
            }

            // Check forbidden {% render %}
            if (/\{%\s*render\b/i.test(content)) {
              throw new Error(
                `ThemeCompiler: forbidden {% render %} tag detected in ${d}/${file}. Use {% include %}.`
              );
            }

            // Check include connectivity
            for (const match of content.matchAll(includeRegex)) {
              const snippetTarget = match[1];
              if (!snippetNames.has(snippetTarget)) {
                throw new Error(
                  `ThemeCompiler: unresolved snippet include "${snippetTarget}" in ${d}/${file} - file snippets/${snippetTarget}.liquid not found`
                );
              }
            }
          }
        }
      }
    }
  }
}
