/**
 * Generator: Theme Compiler Orchestrator
 * True atomic staging, validation, and swap to guarantee zero corrupted/partial theme output.
 * Fully cut over to Haravan flat directory architecture (Audit Phase 05).
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import * as crypto from 'node:crypto';
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
import {
  BlueprintExtractor,
  ExtractedSectionBlueprint,
} from '../models/blueprint-extractor.js';

export interface ThemeCompilerOptions {
  targetContract?: HaravanTargetContract;
  settingsMode?: HaravanSettingsMode | string;
  emitLocales?: boolean;
  localizedLocales?: string[];
  mobileHtml?: string;
  inputPath?: string;
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

      // Update compiler ownership manifest with all localized and compiled files in tempStageDir
      const themeManifestRel = path.join('config', '.antifan-theme-manifest.json');
      const themeManifestStagingPath = path.join(tempStageDir, themeManifestRel);
      const stagedRelFiles = compileRes.filesWritten.map((f) =>
        path.relative(tempStageDir, f).replace(/\\/g, '/')
      );
      const manifestNormalizedRel = themeManifestRel.replace(/\\/g, '/');
      if (!stagedRelFiles.includes(manifestNormalizedRel)) {
        stagedRelFiles.push(manifestNormalizedRel);
      }
      fs.writeFileSync(
        themeManifestStagingPath,
        JSON.stringify(
          {
            version: '1.0.0',
            generator: 'AntiFan ThemeCompiler',
            generatedAt: new Date().toISOString(),
            generatedFiles: stagedRelFiles,
          },
          null,
          2
        ),
        'utf-8'
      );

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

      // Only fall back to disk inspection when ir.assets manifest is not provided
      if (allIrAssets.length === 0 && options?.assetsDir && fs.existsSync(options.assetsDir as string)) {
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
      if ((!ir.assets || ((ir.assets.stylesheets?.length || 0) === 0 && (ir.assets.javascripts?.length || 0) === 0)) && options?.assetsDir && fs.existsSync(options.assetsDir as string)) {
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
      fs.writeFileSync(
        layoutPath,
        this.layoutGen.generateThemeLiquid({
          stylesheets: layoutStylesheets,
          scripts: layoutScripts,
          htmlAttributes: ir.htmlAttributes,
          bodyAttributes: ir.bodyAttributes,
          includeHeader: true,
          includeFooter: true,
        }),
        'utf-8'
      );
      filesWritten.push(layoutPath);

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

      // 5. Detect and extract complete mobile surface for dual-surface preservation
      let mobileIndexPath = '';
      if (options?.assetsDir) {
        const cand1 = path.join(path.dirname(options.assetsDir as string), 'mobile', 'index.html');
        if (fs.existsSync(cand1)) {
          mobileIndexPath = cand1;
        }
      }
      if (!mobileIndexPath && typeof options?.inputPath === 'string' && options.inputPath) {
        const cand2 = path.join(path.dirname(options.inputPath), 'mobile', 'index.html');
        if (fs.existsSync(cand2)) {
          mobileIndexPath = cand2;
        }
      }
      const mobileHtmlContent =
        typeof options?.mobileHtml === 'string' && options.mobileHtml.trim().length > 0
          ? options.mobileHtml
          : mobileIndexPath && fs.existsSync(mobileIndexPath)
          ? fs.readFileSync(mobileIndexPath, 'utf-8')
          : '';
      const hasMobileSurface = Boolean(mobileHtmlContent && mobileHtmlContent.trim().length > 0);

      let mobileHeaderContent = '';
      let mobileFooterContent = '';
      const mobileBodySections: ExtractedSectionBlueprint[] = [];

      if (hasMobileSurface) {
        const mobileRoot = DomTreeParser.parse(mobileHtmlContent);
        const mobileHeaders = DomTreeParser.findByTag(mobileRoot, 'header');
        if (mobileHeaders.length > 0) {
          mobileHeaderContent = mobileHeaders[0].outerHtml;
          const drawers = DomTreeParser.findByClass(mobileRoot, 'category-navigation__block');
          if (drawers.length > 0 && !mobileHeaderContent.includes('category-navigation__block')) {
            mobileHeaderContent += '\n' + drawers[0].outerHtml;
          }
        }
        const mobileFooters = DomTreeParser.findByTag(mobileRoot, 'footer');
        if (mobileFooters.length > 0) {
          mobileFooterContent = mobileFooters[0].outerHtml;
        }

        // Extract all sections from the complete mobile document
        const mobileExtractor = new BlueprintExtractor();
        const extractedMobile = mobileExtractor.extractSections(mobileHtmlContent);
        for (const mSec of extractedMobile) {
          const isMHeader =
            mSec.type === 'header' ||
            mSec.id === 'header' ||
            mSec.id === 'site_header' ||
            /(?:^|\s)(?:site[-_]?)?header(?:$|\s)/i.test(mSec.className || '') ||
            /^(?:site\s+)?header$/i.test(mSec.name || '');
          const isMFooter =
            mSec.type === 'footer' ||
            mSec.id === 'footer' ||
            mSec.id === 'site_footer' ||
            /(?:^|\s)(?:site[-_]?)?footer(?:$|\s)/i.test(mSec.className || '') ||
            /^(?:site\s+)?footer$/i.test(mSec.name || '');
          if (!isMHeader && !isMFooter) {
            mobileBodySections.push(mSec);
          }
        }
      }

      // 5b. Generate snippets from IR sections
      for (const sec of sections) {
        let sectionLiquid = '';
        const sectionControllers =
          ir.storefrontRuntime?.controllers?.filter((c) => c.sectionId === sec.id) || [];

        if (sec.liquidTemplate && sec.liquidTemplate.trim().length > 0) {
          sectionLiquid = sec.liquidTemplate;
        } else if (sec.rawHtml && sec.rawHtml.trim().length > 0) {
          sectionLiquid = sec.rawHtml.trim();
        } else {
          const secCleanId = sanitizeSettingId(sec.id, 'sec');
          const headingMarkup = sec.heading
            ? `\n    {% if settings.${secCleanId}_heading != blank %}\n      <h2 class="title">{{ settings.${secCleanId}_heading | escape }}</h2>\n    {% endif %}`
            : '';
          sectionLiquid = `
<section class="${sec.className || sec.id}" id="${sec.id}">
  <div class="container">${headingMarkup}
    <div class="content"></div>
  </div>
</section>
          `.trim();
        }

        // Prefer authentic rawHtml if liquidTemplate carries synthetic section.blocks loop
        if (sectionLiquid.includes('section.blocks') && sec.rawHtml && sec.rawHtml.trim().length > 0) {
          sectionLiquid = sec.rawHtml.trim();
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

        // 5f. Controller injection (carousel, dropdown)
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
          }
        }

        // Modal controller and markup-driven modal dialog binding
        const explicitModalCtrl = sectionControllers.find((c) => c.type === 'modal');
        const markupModalMatch = sectionLiquid.match(
          /(?:<button\b[^>]*(?:class=["'][^"']*(?:modal-btn|popup-btn)[^"']*["']|data-target=["']#([^"']+)["'])|<a\b[^>]*data-target=["']#([^"']+)["'])/i
        );
        const inferredModalTarget = markupModalMatch
          ? (markupModalMatch[1] || markupModalMatch[2]
              ? `#${markupModalMatch[1] || markupModalMatch[2]}`
              : `#modal-${sec.id}`)
          : null;

        if (explicitModalCtrl || (inferredModalTarget && /(?:modal|popup|dialog)/i.test(sectionLiquid))) {
          const modalTarget = explicitModalCtrl
            ? (explicitModalCtrl.targetSelector && explicitModalCtrl.targetSelector.startsWith('#')
                ? explicitModalCtrl.targetSelector
                : `#modal-${sec.id}`)
            : inferredModalTarget!;
          const modalId = modalTarget.replace(/^#/, '');

          if (!sectionLiquid.includes('data-antifan-modal')) {
            sectionLiquid = sectionLiquid.replace(
              /(<button\b[^>]*class=["'][^"']*(?:modal-btn|popup-btn|item-cta)[^"']*["'])([^>]*>)/i,
              `$1 data-antifan-modal="${modalTarget}"$2`
            );
            if (!sectionLiquid.includes('data-antifan-modal') && sectionLiquid.includes('data-target=')) {
              sectionLiquid = sectionLiquid.replace(
                /(<(?:button|a)\b[^>]*data-target=["']#[^"']+["'])([^>]*>)/i,
                `$1 data-antifan-modal="${modalTarget}"$2`
              );
            }
          }
          if (!sectionLiquid.includes('data-antifan-modal-dialog')) {
            if (
              /(<div\b[^>]*class=["'][^"']*(?:modal|popup|dialog)[^"']*)/i.test(
                sectionLiquid
              )
            ) {
              sectionLiquid = sectionLiquid.replace(
                /(<div\b[^>]*class=["'][^"']*(?:modal|popup|dialog)[^"']*[^>]*>)/i,
                (fullTag) => {
                  if (fullTag.includes('data-antifan-modal-dialog')) return fullTag;
                  let tag = fullTag;
                  if (/\bid=["'][^"']*["']/i.test(tag)) {
                    tag = tag.replace(/\bid=["'][^"']*["']/i, `id="${modalId}"`);
                  } else {
                    tag = tag.replace(/^<div\b/i, `<div id="${modalId}"`);
                  }
                  return tag.replace(/>$/, ' data-antifan-modal-dialog aria-hidden="true">');
                }
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
        // Rewrite asset references into Haravan Liquid format and strip dynamic CSRF tokens
        sectionLiquid = rewriteLiquidAssets(sectionLiquid);
        sectionLiquid = sectionLiquid.replace(
          /<input\s+[^>]*name=["'](?:_token|authenticity_token|csrf[-_]token)["'][^>]*>/gi,
          ''
        );

        const isHeader =
          sec.archetype === 'header' ||
          sec.id === 'header' ||
          sec.id === 'site_header' ||
          /(?:^|\s)(?:site[-_]?)?header(?:$|\s)/i.test(sec.className || '') ||
          /^(?:site\s+)?header$/i.test(sec.name || '');
        const isFooter =
          sec.archetype === 'footer' ||
          sec.id === 'footer' ||
          sec.id === 'site_footer' ||
          /(?:^|\s)(?:site[-_]?)?footer(?:$|\s)/i.test(sec.className || '') ||
          /^(?:site\s+)?footer$/i.test(sec.name || '');

        if (isHeader) {
          let headerOutput = sectionLiquid;
          if (hasMobileSurface && mobileHeaderContent) {
            const rewrittenMobileHeader = rewriteLiquidAssets(mobileHeaderContent).replace(
              /<input\s+[^>]*name=["'](?:_token|authenticity_token|csrf[-_]token)["'][^>]*>/gi,
              ''
            );
            headerOutput = `<div class="theme-surface-desktop">\n${sectionLiquid}\n</div>\n<div class="theme-surface-mobile">\n${rewrittenMobileHeader}\n</div>`;
          }
          const headerSnippetPath = path.join(stagingDir, 'snippets', 'header.liquid');
          fs.writeFileSync(headerSnippetPath, headerOutput, 'utf-8');
          filesWritten.push(headerSnippetPath);
          emittedSnippetNames.add('header');
        } else if (isFooter) {
          let footerOutput = sectionLiquid;
          if (hasMobileSurface && mobileFooterContent) {
            const rewrittenMobileFooter = rewriteLiquidAssets(mobileFooterContent).replace(
              /<input\s+[^>]*name=["'](?:_token|authenticity_token|csrf[-_]token)["'][^>]*>/gi,
              ''
            );
            footerOutput = `<div class="theme-surface-desktop">\n${sectionLiquid}\n</div>\n<div class="theme-surface-mobile">\n${rewrittenMobileFooter}\n</div>`;
          }
          const footerSnippetPath = path.join(stagingDir, 'snippets', 'footer.liquid');
          fs.writeFileSync(footerSnippetPath, footerOutput, 'utf-8');
          filesWritten.push(footerSnippetPath);
          emittedSnippetNames.add('footer');
        } else {
          let snippetName = sanitizeSettingId(sec.id, 'sec');
          if (emittedSnippetNames.has(snippetName)) {
            let counter = 2;
            let candidate = `${snippetName}_${counter}`;
            while (emittedSnippetNames.has(candidate)) {
              counter++;
              candidate = `${snippetName}_${counter}`;
            }
            snippetName = candidate;
          }
          emittedSnippetNames.add(snippetName);

          const enabledId = `${snippetName}_enabled`;
          allReadSettingIds.add(enabledId);

          const snippetPath = path.join(stagingDir, 'snippets', `${snippetName}.liquid`);
          fs.writeFileSync(snippetPath, sectionLiquid, 'utf-8');
          filesWritten.push(snippetPath);

          pageSectionIncludes.push({
            snippetName,
            enabledSettingId: enabledId,
          });
        }
      }

      // Emit full mobile body sections if mobile surface is present
      const desktopSectionIds = new Set(sections.map((s) => s.id));
      const mobileSectionIncludes: string[] = [];

      if (hasMobileSurface && mobileBodySections.length > 0) {
        for (const mSec of mobileBodySections) {
          let mobileSnippetName = `mobile_${sanitizeSettingId(mSec.id, 'sec')}`;
          if (emittedSnippetNames.has(mobileSnippetName)) {
            let counter = 2;
            let candidate = `${mobileSnippetName}_${counter}`;
            while (emittedSnippetNames.has(candidate)) {
              counter++;
              candidate = `${mobileSnippetName}_${counter}`;
            }
            mobileSnippetName = candidate;
          }
          emittedSnippetNames.add(mobileSnippetName);
          let mContent = mSec.rawHtml || mSec.liquidTemplate || '';
          // Scope by container (.theme-surface-mobile) rather than renaming IDs,
          // preserving source CSS/JS selectors that target those IDs.
          mContent = rewriteLiquidAssets(mContent).replace(
            /<input\s+[^>]*name=["'](?:_token|authenticity_token|csrf[-_]token)["'][^>]*>/gi,
            ''
          );
          const mSnippetPath = path.join(stagingDir, 'snippets', `${mobileSnippetName}.liquid`);
          fs.writeFileSync(mSnippetPath, mContent, 'utf-8');
          filesWritten.push(mSnippetPath);
          mobileSectionIncludes.push(mobileSnippetName);
        }
      }

      // 6. Generate flat templates/index.liquid composed with {% include %}
      const indexLines: string[] = [];
      if (hasMobileSurface && mobileSectionIncludes.length > 0) {
        indexLines.push('<div class="theme-surface-desktop">');
        for (const item of pageSectionIncludes) {
          if (item.enabledSettingId) {
            indexLines.push(`  {% unless settings.${item.enabledSettingId} == false %}`);
            indexLines.push(`    {% include '${item.snippetName}' %}`);
            indexLines.push('  {% endunless %}');
          } else {
            indexLines.push(`  {% include '${item.snippetName}' %}`);
          }
        }
        indexLines.push('</div>');
        indexLines.push('<div class="theme-surface-mobile">');
        for (const mobSnippet of mobileSectionIncludes) {
          indexLines.push(`  {% include '${mobSnippet}' %}`);
        }
        indexLines.push('</div>');
      } else {
        for (const item of pageSectionIncludes) {
          if (item.enabledSettingId) {
            indexLines.push(`{% unless settings.${item.enabledSettingId} == false %}`);
            indexLines.push(`  {% include '${item.snippetName}' %}`);
            indexLines.push('{% endunless %}');
          } else {
            indexLines.push(`{% include '${item.snippetName}' %}`);
          }
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

      // Safely preserve existing destination merchant settings
      const destSettingsDataPath = path.join(outputDir, 'config', 'settings_data.json');
      if (fs.existsSync(destSettingsDataPath)) {
        try {
          const existingRaw = fs.readFileSync(destSettingsDataPath, 'utf-8');
          const existingData = JSON.parse(existingRaw);
          if (existingData && typeof existingData === 'object' && existingData.current) {
            for (const [k, v] of Object.entries(existingData.current)) {
              if (v !== undefined && v !== null && v !== '') {
                settingsDataMap[k] = v;
              }
            }
          }
        } catch {}
      }

      // Unambiguous merchant asset setting migration: strictly refuse ambiguous mappings
      if (ir.assets) {
        const allItems = [
          ...(ir.assets.stylesheets || []),
          ...(ir.assets.javascripts || []),
          ...(ir.assets.images || []),
          ...(ir.assets.fonts || []),
        ];

        // Track all targets per reference to detect any ambiguity across surfaces
        const refToTargets = new Map<string, Set<string>>();
        const registerRef = (ref: string, targetFilename: string): void => {
          if (!ref || !targetFilename) return;
          const trimmedRef = ref.trim();
          if (!refToTargets.has(trimmedRef)) {
            refToTargets.set(trimmedRef, new Set());
          }
          refToTargets.get(trimmedRef)!.add(targetFilename);
        };

        // Populate references from explicit assetMap if present
        if (ir.assets.assetMap && typeof ir.assets.assetMap === 'object') {
          for (const [ref, target] of Object.entries(ir.assets.assetMap)) {
            if (typeof ref === 'string' && typeof target === 'string') {
              registerRef(ref, target);
              registerRef(ref.replace(/^\//, ''), target);
              registerRef(`assets/${ref.replace(/^assets\//, '')}`, `assets/${target}`);
            }
          }
        }

        // Populate references from item.sourceUrl, item.rawSourceUrl, and item.originalFilename
        for (const it of allItems) {
          if (it.filename) {
            if (it.sourceUrl) registerRef(it.sourceUrl, it.filename);
            if (it.rawSourceUrl) registerRef(it.rawSourceUrl, it.filename);
            if (it.originalFilename) {
              registerRef(it.originalFilename, it.filename);
              registerRef(`assets/${it.originalFilename}`, `assets/${it.filename}`);
              registerRef(`/assets/${it.originalFilename}`, `/assets/${it.filename}`);
            }
          }
        }

        // Only references with EXACTLY 1 unique target are unambiguous.
        // Ambiguous references (targets.size > 1) MUST BE REFUSED (no guessed reassignment).
        const unambiguousMap = new Map<string, string>();
        for (const [ref, targets] of refToTargets.entries()) {
          if (targets.size === 1) {
            unambiguousMap.set(ref, Array.from(targets)[0]);
          }
        }

        // Apply only proven unambiguous mappings; preserve existing merchant values otherwise
        for (const [k, v] of Object.entries(settingsDataMap)) {
          if (typeof v === 'string') {
            const trimmed = v.trim();
            if (unambiguousMap.has(trimmed)) {
              settingsDataMap[k] = unambiguousMap.get(trimmed)!;
            }
          }
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
      let runtimeJs = this.stateSynth.generateDeclarativeRuntime();
      if (hasMobileSurface) {
        runtimeJs += `
/* AntiFan Dual-Surface ID & Inert Subtree Synchronizer:
   Ensures exactly one live instance per ID exists in the active DOM,
   preventing document.getElementById and label[for] collisions across desktop and mobile surfaces.
   Single source of truth: derives active surface from rendered layout (getComputedStyle)
   so JS always matches whatever the CSS cascade decided (media query or data-device). */
(function() {
  function syncDualSurfaceActiveIDs() {
    var mobileSurface = document.querySelector('.theme-surface-mobile');
    var desktopSurface = document.querySelector('.theme-surface-desktop');
    if (!mobileSurface || !desktopSurface) return;

    var isMobileActive = window.getComputedStyle(mobileSurface).display !== 'none';
    var activeSurface = isMobileActive ? mobileSurface : desktopSurface;
    var inactiveSurface = isMobileActive ? desktopSurface : mobileSurface;
    // Deactivate inactive surface elements: set inert and demote live IDs to data-inert-id
    inactiveSurface.setAttribute('inert', '');
    var inactiveEls = inactiveSurface.querySelectorAll('[id]');
    for (var i = 0; i < inactiveEls.length; i++) {
      var el = inactiveEls[i];
      el.setAttribute('data-inert-id', el.id);
      el.removeAttribute('id');
    }

    // Activate active surface elements: remove inert and restore live IDs from data-inert-id
    activeSurface.removeAttribute('inert');
    var activeEls = activeSurface.querySelectorAll('[data-inert-id]');
    for (var j = 0; j < activeEls.length; j++) {
      var aEl = activeEls[j];
      aEl.setAttribute('id', aEl.getAttribute('data-inert-id'));
      aEl.removeAttribute('data-inert-id');
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', syncDualSurfaceActiveIDs);
  } else {
    syncDualSurfaceActiveIDs();
  }
  var resizeTimer;
  window.addEventListener('resize', function() {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(syncDualSurfaceActiveIDs, 50);
  });
})();
`;
      }
      fs.writeFileSync(themeJsPath, runtimeJs, 'utf-8');
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

        const b = ir.layout.breakpoints;
        const desktopMin = b?.desktopMin;
        const tabletMin = b?.tabletMin;
        const tabletMax = b?.tabletMax;
        const mobileMax = b?.mobileMax;

        const responsiveCssLines = [
          '/* Generated Responsive Layout Constraints */',
          ':root {',
          `  --antifan-container-max: ${ir.layout.containerMaxWidth}px;`,
          `  --antifan-container-pad: ${ir.layout.containerPaddingPx}px;`,
          `  --antifan-grid-gap: ${gap}px;`,
          '}',
        ];
        if (desktopMin !== undefined) {
          responsiveCssLines.push(
            `@media (min-width: ${desktopMin}px) {`,
            `  .antifan-responsive-grid { display: grid; grid-template-columns: repeat(${desktopCols}, 1fr); gap: var(--antifan-grid-gap); }`,
            '}'
          );
        }
        if (tabletMin !== undefined && tabletMax !== undefined) {
          responsiveCssLines.push(
            `@media (min-width: ${tabletMin}px) and (max-width: ${tabletMax}px) {`,
            `  .antifan-responsive-grid { display: grid; grid-template-columns: repeat(${tabletCols}, 1fr); gap: var(--antifan-grid-gap); }`,
            '}'
          );
        }
        if (mobileMax !== undefined) {
          responsiveCssLines.push(
            `@media (max-width: ${mobileMax}px) {`,
            `  .antifan-responsive-grid { display: grid; grid-template-columns: repeat(${mobileCols}, 1fr); gap: var(--antifan-grid-gap); }`,
            '}'
          );
        }
        const responsiveCssContent = responsiveCssLines.join('\n');
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
      const mobileMax = ir.layout?.breakpoints?.mobileMax;
      const mobileMediaQuery = mobileMax !== undefined ? `@media (max-width: ${mobileMax}px)` : '';

      let dualSurfaceCss = '';
      if (hasMobileSurface) {
        if (mobileMax !== undefined) {
          dualSurfaceCss = `
/* Dual-surface responsive switching: viewport media query is the PRIMARY switch
   derived from source layout constraints (mobileMax=${mobileMax}px),
   guaranteeing mobile surface is reachable on real phone viewports regardless of static server data-device. */
@media (max-width: ${mobileMax}px) {
  .theme-surface-desktop {
    display: none !important;
  }
  .theme-surface-mobile {
    display: block !important;
  }
}
@media (min-width: ${mobileMax + 1}px) {
  .theme-surface-mobile {
    display: none !important;
  }
  .theme-surface-desktop {
    display: block !important;
  }
}

/* Extra signal if data-device is explicitly set or toggled by client runtime */
body[data-device="mobile"] .theme-surface-desktop {
  display: none !important;
}
body[data-device="mobile"] .theme-surface-mobile {
  display: block !important;
}
`;
        } else {
          dualSurfaceCss = `
/* Dual-surface responsive switching without proven source breakpoint:
   Keyed on client/adaptive data-device signal with desktop surface as default */
.theme-surface-mobile {
  display: none;
}
.theme-surface-desktop {
  display: block;
}
body[data-device="mobile"] .theme-surface-desktop {
  display: none !important;
}
body[data-device="mobile"] .theme-surface-mobile {
  display: block !important;
}
`;
        }
      }
      const customCssDefault = `/* Haravan Custom Overrides & Adaptive Parity */
/* Hero slider touch-action and scroll-snap alignment.
   Preserves native horizontal scrolling for touch and theme.js slider controllers. */
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
${dualSurfaceCss}
`;
      fs.writeFileSync(customCssPath, customCssDefault, 'utf-8');
      if (!filesWritten.includes(customCssPath)) filesWritten.push(customCssPath);
      // Copy IR harvested assets directly from manifest
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
              // Surface identity derived from actual provenance occurrences, never filename regex
              const isMobileOnly = Boolean(
                item.occurrences &&
                item.occurrences.length > 0 &&
                item.occurrences.every((o) => o.surface === 'mobile')
              );
              if (isMobileOnly && mobileMediaQuery) {
                const rawCss = fs.readFileSync(item.localPath, 'utf-8');
                const cleanCss = rawCss.replace(/^\s*@charset\s+["'][^"']+["'];\s*/i, '');
                const wrappedCss = cleanCss.trim().startsWith('@media')
                  ? rawCss
                  : `@charset "UTF-8";\n${mobileMediaQuery} {\n${cleanCss}\n}`;
                fs.writeFileSync(destAssetPath, wrappedCss, 'utf-8');
              } else {
                fs.copyFileSync(item.localPath, destAssetPath);
              }
            }
            if (!filesWritten.includes(destAssetPath)) filesWritten.push(destAssetPath);
          }
        }
      } else if (options?.assetsDir && fs.existsSync(options.assetsDir as string)) {
        // Fallback only when ir.assets manifest is not provided; no provenance -> copy as-is without guessing
        try {
          const diskFiles = fs.readdirSync(options.assetsDir as string);
          for (const diskFile of diskFiles) {
            if (isJunkOrThirdPartyAsset(diskFile)) continue;
            const srcPath = path.join(options.assetsDir as string, diskFile);
            const destPath = path.join(stagingDir, 'assets', diskFile);
            if (fs.statSync(srcPath).isFile() && !fs.existsSync(destPath)) {
              fs.copyFileSync(srcPath, destPath);
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

      // Record compiler ownership manifest with SHA-256 hash guard in staging directory
      const themeManifestRel = path.join('config', '.antifan-theme-manifest.json');
      const themeManifestStagingPath = path.join(stagingDir, themeManifestRel);
      const stagedRelFiles = filesWritten.map((f) =>
        path.relative(stagingDir, f).replace(/\\/g, '/')
      );
      const manifestNormalizedRel = themeManifestRel.replace(/\\/g, '/');
      if (!stagedRelFiles.includes(manifestNormalizedRel)) {
        stagedRelFiles.push(manifestNormalizedRel);
      }

      const fileHashes: Record<string, string> = {};
      for (const f of filesWritten) {
        if (fs.existsSync(f) && fs.statSync(f).isFile()) {
          const rel = path.relative(stagingDir, f).replace(/\\/g, '/');
          fileHashes[rel] = crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');
        }
      }

      fs.writeFileSync(
        themeManifestStagingPath,
        JSON.stringify(
          {
            version: '1.0.0',
            generator: 'AntiFan ThemeCompiler',
            generatedAt: new Date().toISOString(),
            generatedFiles: stagedRelFiles,
            fileHashes,
          },
          null,
          2
        ),
        'utf-8'
      );
      if (!filesWritten.includes(themeManifestStagingPath)) {
        filesWritten.push(themeManifestStagingPath);
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
    const COMPILER_MANAGED_CONFIG_FILES = new Set([
      'config/settings_data.json',
      'config/settings_schema.json',
      'config/settings.html',
      'config/.antifan-theme-manifest.json',
    ]);
    const themeManifestRel = path.join('config', '.antifan-theme-manifest.json');
    const destManifestPath = path.join(outputDir, themeManifestRel);
    let priorGeneratedFiles = new Set<string>();
    if (fs.existsSync(destManifestPath)) {
      try {
        const raw = fs.readFileSync(destManifestPath, 'utf-8');
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed?.generatedFiles)) {
          priorGeneratedFiles = new Set(
            parsed.generatedFiles.map((s: string) => s.replace(/\\/g, '/'))
          );
        }
      } catch {}
    }

    const collectFilesRecursive = (dir: string, base = ''): string[] => {
      if (!fs.existsSync(dir)) return [];
      const results: string[] = [];
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      for (const ent of entries) {
        const rel = base ? `${base}/${ent.name}` : ent.name;
        if (ent.isDirectory()) {
          results.push(...collectFilesRecursive(path.join(dir, ent.name), rel));
        } else if (ent.isFile()) {
          results.push(rel.replace(/\\/g, '/'));
        }
      }
      return results;
    };

    const newStagedFiles = new Set(
      collectFilesRecursive(stagingDir).map((f) => f.replace(/\\/g, '/'))
    );

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
        const srcSub = path.join(stagingDir, d);
        if (!fs.existsSync(srcSub)) continue;
        fs.mkdirSync(destSub, { recursive: true });

        // Examine existing files in destination directory
        const existingInDest = collectFilesRecursive(destSub);
        for (const rel of existingInDest) {
          const themeRelPath = `${d}/${rel}`.replace(/\\/g, '/');
          const isPriorGenerated = priorGeneratedFiles.has(themeRelPath);
          const isCompilerConfigFile = COMPILER_MANAGED_CONFIG_FILES.has(themeRelPath);

          if (isPriorGenerated || isCompilerConfigFile) {
            // It was generated by the previous compiler run or is a compiler-managed config file.
            // If the new run no longer generates it, it is a stale compiler artifact -> purge.
            if (!newStagedFiles.has(themeRelPath) && !isCompilerConfigFile) {
              const fullFilePath = path.join(destSub, rel);
              if (fs.existsSync(fullFilePath)) {
                fs.rmSync(fullFilePath, { force: true });
              }
            }
          } else {
            // It was NOT recorded in prior compiler manifest -> User-owned / unmanaged file!
            if (newStagedFiles.has(themeRelPath)) {
              throw new Error(
                `ThemeCompiler: overwrite conflict on user-owned file "${themeRelPath}". Compilation refused to overwrite unmanaged file.`
              );
            }
            // If newStagedFiles does not conflict, the user-owned file is PRESERVED!
          }
        }

        // Copy staged files into destination (overwriting prior generated files and new files)
        fs.cpSync(srcSub, destSub, { recursive: true, force: true });
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
