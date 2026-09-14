/**
 * Generator: Theme Compiler Orchestrator
 * True atomic staging, validation, and swap to guarantee zero corrupted/partial theme output.
 * Fully cut over to Haravan flat directory architecture (Audit Phase 05).
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import * as crypto from 'node:crypto';
import { pathToFileURL } from 'node:url';
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
import type { HarvestedAssetManifest, HarvestedAssetItem } from '../models/asset-harvester.js';
export interface ThemeCodeApproval {
  sha256: string;
  classification: 'THEME_REQUIRED' | 'EXTRACTED';
  usage: string;
  evidence: string;
}


export interface ThemeCompilerOptions {
  codeApprovals?: ThemeCodeApproval[];
  targetContract?: HaravanTargetContract;
  settingsMode?: HaravanSettingsMode | string;
  emitLocales?: boolean;
  localizedLocales?: string[];
  mobileHtml?: string;
  inputPath?: string;
  /**
   * The localization pipeline writes asset bytes into the stage *after* the
   * inner compile returns, so the inner reference gate would inspect a stage
   * whose assets are not yet localized. The outer boundary validates instead.
   */
  deferFinalAssetValidation?: boolean;
  [key: string]: unknown;
}
export interface ResolvedAsset {
  sourcePath: string;
  resolvedFilename: string;
}
export interface RouteHeadAssetsResult {
  desktopStylesheets: string[];
  mobileStylesheets: string[];
  sharedStylesheets: string[];
  desktopInlineStyles: string[];
  mobileInlineStyles: string[];
  liquidAssetTags: string;
}

export function computeFileSha256(filePath: string): string {
  const buf = fs.readFileSync(filePath);
  return crypto.createHash('sha256').update(buf).digest('hex');
}

export const THEME_STATIC_ASSET_EXTENSIONS = new Set([
  '.css', '.js', '.mjs',
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg', '.ico', '.avif', '.bmp',
  '.woff', '.woff2', '.ttf', '.otf', '.eot',
  '.mp4', '.webm', '.mp3', '.wav', '.pdf'
]);

export function isStaticThemeAsset(filename: string): boolean {
  const clean = path.basename(filename.split(/[?#]/)[0]);
  const ext = path.extname(clean).toLowerCase();
  return THEME_STATIC_ASSET_EXTENSIONS.has(ext);
}

export function isJunkOrThirdPartyAsset(filename: string): boolean {
  return /(?:twk-|tawk|1hiir|gtm\.js|googletagmanager|analytics\.js|facebook|clarity|subiz|vchat|zalo|hotjar|criteo|emojione|js_98b1fb9e|js\.js)/i.test(filename);
}

export function isBundlerHash(suffix: string): boolean {
  if (suffix.length < 6 || suffix.length > 20) return false;
  if (/^(?:header|footer|mobile|desktop|banner|nav|menu|icon|logo|thumb|modal|drawer|search|cart|arrow|bg|background)$/i.test(suffix)) {
    return false;
  }
  const hasDigit = /\d/.test(suffix);
  const isHex = /^[0-9a-fA-F]+$/.test(suffix);
  const isMixedCase = /[a-z]/.test(suffix) && /[A-Z]/.test(suffix);
  return hasDigit || isHex || isMixedCase;
}

export function resolveCanonicalAssetFilename(filename: string): string {
  if (!filename) return filename;
  const clean = path.basename(filename.split(/[?#]/)[0]);
  const ext = path.extname(clean);
  const base = clean.slice(0, clean.length - ext.length);
  if (base.length > 64) {
    const truncatedBase = base.slice(0, 64).replace(/-+$/, '');
    return `${truncatedBase}${ext}`;
  }
  return clean;
}

export function isAlreadyMediaWrapped(css: string): boolean {
  const stripped = css
    .replace(/^\s*@charset\s+["'][^"']+["'];\s*/i, '')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .trim();
  if (!stripped || !stripped.startsWith('@media')) return false;
  let depth = 0;
  let firstBraceFound = false;
  for (let i = 0; i < stripped.length; i++) {
    const char = stripped[i];
    if (char === '{') {
      depth++;
      firstBraceFound = true;
    } else if (char === '}') {
      depth--;
      if (depth === 0 && firstBraceFound) {
        const remainder = stripped.slice(i + 1).trim();
        if (remainder.length === 0) return true;
        if (remainder.startsWith('@media')) {
          firstBraceFound = false;
          continue;
        }
        return false;
      }
    }
  }
  return depth === 0 && firstBraceFound;
}

export function resolveRealAsset(
  refName: string,
  searchDirs: string[],
  cloneAssetMap: Record<string, string>,
  irAssets: Array<{ filename?: string; originalFilename?: string; sourceUrl?: string; localPath?: string }>
): ResolvedAsset | null {
  const cleanRef = path.basename(refName.split(/[?#]/)[0]);
  if (!cleanRef || isJunkOrThirdPartyAsset(cleanRef)) return null;
  const canonicalRef = resolveCanonicalAssetFilename(cleanRef);

  // 1. Direct exact match in searchDirs
  for (const dir of searchDirs) {
    if (!fs.existsSync(dir)) continue;
    const directPath = path.join(dir, cleanRef);
    if (fs.existsSync(directPath) && fs.statSync(directPath).isFile()) {
      return { sourcePath: directPath, resolvedFilename: canonicalRef };
    }
    if (canonicalRef !== cleanRef) {
      const canonPath = path.join(dir, canonicalRef);
      if (fs.existsSync(canonPath) && fs.statSync(canonPath).isFile()) {
        return { sourcePath: canonPath, resolvedFilename: canonicalRef };
      }
    }
  }

  // 2. Direct match in irAssets
  for (const item of irAssets) {
    if (item.localPath && fs.existsSync(item.localPath) && fs.statSync(item.localPath).isFile()) {
      if (
        item.filename === cleanRef ||
        item.originalFilename === cleanRef ||
        path.basename(item.sourceUrl?.split(/[?#]/)[0] || '') === cleanRef
      ) {
        return { sourcePath: item.localPath, resolvedFilename: item.filename || cleanRef };
      }
    }
  }

  // 3. Clone manifest assetMap lookups
  const manifestCandidates: string[] = [];
  if (cloneAssetMap[cleanRef]) manifestCandidates.push(cloneAssetMap[cleanRef]);
  if (cloneAssetMap[`assets/${cleanRef}`]) manifestCandidates.push(cloneAssetMap[`assets/${cleanRef}`]);
  if (cloneAssetMap[`/assets/${cleanRef}`]) manifestCandidates.push(cloneAssetMap[`/assets/${cleanRef}`]);
  for (const [key, val] of Object.entries(cloneAssetMap)) {
    const keyBase = path.basename(key.split(/[?#]/)[0]);
    if (keyBase === cleanRef || val === cleanRef) {
      manifestCandidates.push(val);
      manifestCandidates.push(keyBase);
    }
  }
  for (const cand of manifestCandidates) {
    const candClean = path.basename(cand.split(/[?#]/)[0]);
    for (const dir of searchDirs) {
      if (!fs.existsSync(dir)) continue;
      const p = path.join(dir, candClean);
      if (fs.existsSync(p) && fs.statSync(p).isFile()) {
        return { sourcePath: p, resolvedFilename: candClean };
      }
    }
  }

  // 4. Unambiguous stem match in searchDirs
  const ext = path.extname(cleanRef).toLowerCase();
  const stem = path.basename(cleanRef, ext);
  const normalizedStem = stem.replace(/[-_.]/g, '').toLowerCase();
  const stemLower = stem.toLowerCase();

  const foundCandidates: string[] = [];
  for (const dir of searchDirs) {
    if (!fs.existsSync(dir)) continue;
    try {
      const entries = fs.readdirSync(dir).sort();
      for (const entry of entries) {
        if (isJunkOrThirdPartyAsset(entry)) continue;
        const entryExt = path.extname(entry).toLowerCase();
        if (entryExt !== ext) continue;
        const entryStem = path.basename(entry, entryExt);
        const entryNorm = entryStem.replace(/[-_.]/g, '').toLowerCase();
        const entryLower = entryStem.toLowerCase();

        // Legitimate same-stem criteria:
        // a. Exact case-insensitive match
        const isExactStem = entryLower === stemLower;
        // b. Normalized stem match (only differing by punctuation -/./_)
        const isNormalizedStem = entryNorm === normalizedStem;
        // c. Minified variant
        const isMinVariant =
          entryLower === `${stemLower}.min` || `${entryLower}.min` === stemLower;
        // d. Surface-specific variant of the stem (e.g. logo-desktop vs logo, or vice versa)
        const isSurfaceVariant =
          entryLower === `${stemLower}-desktop` ||
          entryLower === `${stemLower}-mobile` ||
          entryLower === `${stemLower}_desktop` ||
          entryLower === `${stemLower}_mobile` ||
          `${entryLower}-desktop` === stemLower ||
          `${entryLower}-mobile` === stemLower ||
          `${entryLower}_desktop` === stemLower ||
          `${entryLower}_mobile` === stemLower;
        // e. Bundler hash variant (e.g. app-desktop-dcc2d3nb vs app-desktop)
        let isHashVariant = false;
        if (entryLower.startsWith(`${stemLower}-`) || entryLower.startsWith(`${stemLower}_`)) {
          const suffix = entryStem.slice(stem.length + 1);
          isHashVariant = isBundlerHash(suffix);
        }

        const matchesStem = isExactStem || isNormalizedStem || isMinVariant || isSurfaceVariant || isHashVariant;

        if (matchesStem) {
          const fullPath = path.join(dir, entry);
          if (fs.statSync(fullPath).isFile() && !foundCandidates.includes(fullPath)) {
            foundCandidates.push(fullPath);
          }
        }
      }
    } catch {}
  }

  if (foundCandidates.length === 1) {
    return {
      sourcePath: foundCandidates[0],
      resolvedFilename: path.basename(foundCandidates[0]),
    };
  }

  if (foundCandidates.length > 1) {
    // Deterministically sort candidates by basename
    foundCandidates.sort((a, b) => path.basename(a).localeCompare(path.basename(b)));

    // If an exact filename match exists, prefer it
    const exactMatch = foundCandidates.find(
      c => path.basename(c).toLowerCase() === cleanRef.toLowerCase()
    );
    if (exactMatch) {
      return {
        sourcePath: exactMatch,
        resolvedFilename: path.basename(exactMatch),
      };
    }

    const firstHash = computeFileSha256(foundCandidates[0]);
    const allSame = foundCandidates.every(c => computeFileSha256(c) === firstHash);
    if (allSame) {
      // Deterministically prefer surface-neutral name if available, else first sorted candidate
      const neutral = foundCandidates.find(
        c => !/(?:[-_](?:desktop|mobile))$/i.test(path.basename(c, path.extname(c)))
      );
      const chosen = neutral || foundCandidates[0];
      return {
        sourcePath: chosen,
        resolvedFilename: path.basename(chosen),
      };
    }

    // Conflicting candidate files with different hashes -> genuinely ambiguous match!
    // Fail closed with an explicit descriptive error instead of binding a lookalike.
    const candidateNames = foundCandidates.map(c => path.basename(c));
    throw new Error(
      `ThemeCompiler: ambiguous asset match for "${cleanRef}": multiple conflicting candidates with different contents found: [${candidateNames.join(', ')}]. Compilation refused to bind lookalike.`
    );
  }

  return null;
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
        deferFinalAssetValidation: true,
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
      this.validateFinalAssetReferences(tempStageDir);
      this.atomicSwap(tempStageDir, outputDir, dirs, options);
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
  public assertCodeOwnership(content: string, source: string, options?: ThemeCompilerOptions): void {
    if (!content.trim()) return;
    const sha256 = crypto.createHash('sha256').update(content).digest('hex');
    const approval = options?.codeApprovals?.find(item => item.sha256 === sha256);
    if (!approval || !['THEME_REQUIRED', 'EXTRACTED'].includes(approval.classification) ||
        !approval.usage?.trim() || !approval.evidence?.trim()) {
      throw new Error(`ThemeCompiler: UNRESOLVED_CODE_OWNERSHIP ${source} sha256=${sha256}; explicit usage and evidence approval required`);
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
    for (const item of [...(ir.assets?.stylesheets || []), ...(ir.assets?.javascripts || [])]) {
      if (!item.localPath || !fs.existsSync(item.localPath)) continue;
      this.assertCodeOwnership(fs.readFileSync(item.localPath, 'utf8'), item.sourceUrl, options);
    }
    for (const style of ir.headStyles || []) this.assertCodeOwnership(style, 'inline head stylesheet', options);
    const targetContract =
      options?.targetContract || createHaravanTargetContract(options);
    // Asset-context-scoped tolerance: without a caller-supplied asset source the compiler
    // never owns the referenced bytes, so the staged reference audit stays advisory there.
    let hasAssetContext = false;

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

      // Build searchDirs for asset discovery and manifest loading
      const searchDirs: string[] = [];
      if (options?.assetsDir && fs.existsSync(options.assetsDir as string)) {
        searchDirs.push(path.resolve(options.assetsDir as string));
      }
      if (typeof options?.inputPath === 'string' && options.inputPath) {
        const p1 = path.resolve(path.dirname(options.inputPath), 'assets');
        if (fs.existsSync(p1) && !searchDirs.includes(p1)) searchDirs.push(p1);
        const p2 = path.resolve(path.dirname(path.dirname(options.inputPath)), 'assets');
        if (fs.existsSync(p2) && !searchDirs.includes(p2)) searchDirs.push(p2);
      }

      let cloneAssetMap: Record<string, string> = {};
      for (const sDir of searchDirs) {
        const candManifest = path.join(path.dirname(sDir), 'clone-manifest.json');
        if (fs.existsSync(candManifest)) {
          try {
            const raw = fs.readFileSync(candManifest, 'utf-8');
            const parsed = JSON.parse(raw);
            if (parsed.assets?.assetMap && typeof parsed.assets.assetMap === 'object') {
              cloneAssetMap = { ...cloneAssetMap, ...parsed.assets.assetMap };
            }
          } catch {}
        }
      }

      // Build URL mapping for rewriting asset references into Haravan Liquid format {{ 'filename' | asset_url }}
      const liquidUrlMap = new Map<string, string>();
      const registerLiquidAsset = (rawName: string, targetFilename: string) => {
        if (!rawName || !targetFilename) return;
        if (rawName.includes('{{') || rawName.includes('{%') || rawName.includes('}}') || rawName.includes('%}')) return;
        if (isJunkOrThirdPartyAsset(rawName) || isJunkOrThirdPartyAsset(targetFilename)) return;
        const clean = resolveCanonicalAssetFilename(targetFilename);
        const ext = path.extname(clean).toLowerCase();
        if (!THEME_STATIC_ASSET_EXTENSIONS.has(ext)) return;
        const rawClean = resolveCanonicalAssetFilename(rawName);
        const rawExt = path.extname(rawClean).toLowerCase();
        if (rawExt && !THEME_STATIC_ASSET_EXTENSIONS.has(rawExt)) return;
        const rep = `{{ '${clean}' | asset_url }}`;
        liquidUrlMap.set(rawName, rep);
        liquidUrlMap.set(`assets/${rawName}`, rep);
        liquidUrlMap.set(`/assets/${rawName}`, rep);
        liquidUrlMap.set(`../assets/${rawName}`, rep);
        liquidUrlMap.set(`../../assets/${rawName}`, rep);
        liquidUrlMap.set(`./assets/${rawName}`, rep);
        if (clean !== targetFilename) {
          liquidUrlMap.set(clean, rep);
          liquidUrlMap.set(`assets/${clean}`, rep);
          liquidUrlMap.set(`/assets/${clean}`, rep);
          liquidUrlMap.set(`../assets/${clean}`, rep);
          liquidUrlMap.set(`../../assets/${clean}`, rep);
          liquidUrlMap.set(`./assets/${clean}`, rep);
        }
      };

      // 1. Register disk files from searchDirs
      for (const dir of searchDirs) {
        if (!fs.existsSync(dir)) continue;
        for (const name of fs.readdirSync(dir)) {
          const source = path.join(dir, name);
          if (/\.(?:css|m?js)$/i.test(name) && fs.statSync(source).isFile()) {
            this.assertCodeOwnership(fs.readFileSync(source, 'utf8'), source, options);
          }
        }
      }
      for (const sDir of searchDirs) {
        if (!fs.existsSync(sDir)) continue;
        try {
          const diskFiles = fs.readdirSync(sDir);
          for (const diskFile of diskFiles) {
            if (isJunkOrThirdPartyAsset(diskFile)) continue;
            registerLiquidAsset(diskFile, diskFile);
          }
        } catch {}
      }

      // 2. Register clone manifest mappings
      for (const [rawUrl, mappedFile] of Object.entries(cloneAssetMap)) {
        registerLiquidAsset(rawUrl, mappedFile);
        const uBase = path.basename(rawUrl.split(/[?#]/)[0]);
        if (uBase) registerLiquidAsset(uBase, mappedFile);
      }

      // 3. Register IR assets
      const allIrAssets = [
        ...(ir.assets?.stylesheets || []),
        ...(ir.assets?.javascripts || []),
        ...(ir.assets?.images || []),
        ...(ir.assets?.fonts || []),
      ];
      for (const item of allIrAssets) {
        if (item.filename) {
          registerLiquidAsset(item.filename, item.filename);
          if (item.sourceUrl) {
            registerLiquidAsset(item.sourceUrl, item.filename);
            const sBase = path.basename(item.sourceUrl.split(/[?#]/)[0]);
            if (sBase) registerLiquidAsset(sBase, item.filename);
          }
          if (item.originalFilename && item.originalFilename !== item.filename) {
            registerLiquidAsset(item.originalFilename, item.filename);
          }
        }
      }

      // 4. Detect and extract complete mobile surface for dual-surface preservation
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
      let desktopHtmlContent = '';
      if (typeof options?.inputPath === 'string' && options.inputPath && fs.existsSync(options.inputPath)) {
        try {
          desktopHtmlContent = fs.readFileSync(options.inputPath, 'utf-8');
        } catch {}
      }
      const mobileHtmlContent =
        typeof options?.mobileHtml === 'string' && options.mobileHtml.trim().length > 0
          ? options.mobileHtml
          : mobileIndexPath && fs.existsSync(mobileIndexPath)
          ? fs.readFileSync(mobileIndexPath, 'utf-8')
          : '';
      const hasMobileSurface = Boolean(mobileHtmlContent && mobileHtmlContent.trim().length > 0);
      if (mobileIndexPath) {
        const mobileAssets = path.join(path.dirname(mobileIndexPath), 'assets');
        if (fs.existsSync(mobileAssets)) {
          for (const name of fs.readdirSync(mobileAssets)) {
            const source = path.join(mobileAssets, name);
            if (/\.(?:css|m?js)$/i.test(name) && fs.statSync(source).isFile()) this.assertCodeOwnership(fs.readFileSync(source, 'utf8'), source, options);
          }
        }
      }
      for (const html of [desktopHtmlContent, mobileHtmlContent]) {
        for (const style of DomTreeParser.findByTag(DomTreeParser.parse(html), 'style')) {
          this.assertCodeOwnership(style.innerHtml, 'surface inline stylesheet', options);
        }
      }

      let mobileHeaderContent = '';
      let mobileFooterContent = '';
      let mobileBottomNavContent = '';
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
        const mobileBottomNavs = DomTreeParser.findByClass(mobileRoot, 'bottom-navigation');
        if (mobileBottomNavs.length > 0) {
          mobileBottomNavContent = mobileBottomNavs[0].outerHtml;
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

      // 5. Generate layout/theme.liquid with detected stylesheets and scripts
      // Identify stylesheets that will be bundled into theme.css so they are not linked twice
      const bundledStylesheets = new Set<string>();
      for (const s of ir.assets?.stylesheets || []) {
        if (s.localPath && fs.existsSync(s.localPath) && s.filename) {
          bundledStylesheets.add(s.filename);
        }
      }
      const mobileAssetsDir =
        typeof options?.inputPath === 'string' && options.inputPath
          ? path.join(path.dirname(options.inputPath), 'mobile', 'assets')
          : null;
      if (mobileAssetsDir && fs.existsSync(mobileAssetsDir)) {
        try {
          for (const f of fs.readdirSync(mobileAssetsDir)) {
            if (f.toLowerCase().endsWith('.css')) bundledStylesheets.add(f);
          }
        } catch {}
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
      if ((!ir.assets || ((ir.assets.stylesheets?.length || 0) === 0 && (ir.assets.javascripts?.length || 0) === 0)) && searchDirs.length > 0) {
        for (const sDir of searchDirs) {
          try {
            const diskFiles = fs.readdirSync(sDir);
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
      }

      // Also harvest mobile-specific stylesheets and scripts from mobile surface if present
      if (hasMobileSurface) {
        const mobileRoot = DomTreeParser.parse(mobileHtmlContent);
        const mobileLinks = DomTreeParser.findByTag(mobileRoot, 'link');
        for (const link of mobileLinks) {
          const rel = (link.attributes['rel'] || '').toLowerCase();
          const href = link.attributes['href'] || '';
          if (rel === 'stylesheet' && href && !href.startsWith('data:') && !/^(https?:)?\/\//i.test(href)) {
            const rawFile = path.basename(href.split(/[?#]/)[0]);
            if (rawFile && !isJunkOrThirdPartyAsset(rawFile) && !layoutStylesheets.includes(rawFile) && !bundledStylesheets.has(rawFile)) {
              layoutStylesheets.push(rawFile);
            }
          }
        }
        const mobileScripts = DomTreeParser.findByTag(mobileRoot, 'script');
        for (const scr of mobileScripts) {
          const src = scr.attributes['src'] || '';
          if (src && !src.startsWith('data:') && !/^(https?:)?\/\//i.test(src)) {
            const rawFile = path.basename(src.split(/[?#]/)[0]);
            if (rawFile && !isJunkOrThirdPartyAsset(rawFile) && !layoutScripts.includes(rawFile)) {
              layoutScripts.push(rawFile);
            }
          }
        }
      }

      layoutScripts.sort((a, b) => {
        if (a.includes('jquery')) return -1;
        if (b.includes('jquery')) return 1;
        if (a.includes('slick')) return -1;
        if (b.includes('slick')) return 1;
        return 0;
      });

      const hasBottomNav = Boolean(hasMobileSurface && mobileBottomNavContent);
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
          bottomNavigationSnippet: hasBottomNav ? 'bottom-navigation' : undefined,
        }),
        'utf-8'
      );
      filesWritten.push(layoutPath);

      const rewriteLiquidAssets = (content: string): string => {
        let res = rewriteHtmlContent(content, liquidUrlMap, { mode: 'liquid' }).content;

        // 1. Rewrite src, data-src, data-original, data-lazy, href referencing assets
        res = res.replace(
          /(^|\s)(src|data-src|data-original|data-lazy|href)=(?:"(?:\.{1,3}\/|\/)*(?:assets\/)?([^"?#\s]+(?:\.[a-zA-Z0-9_-]+))(?:\?[^"]*)?"|'(?:\.{1,3}\/|\/)*(?:assets\/)?([^'?#\s]+(?:\.[a-zA-Z0-9_-]+))(?:\?[^']*)?')/gi,
          (match, prefix, attr, doubleVal, singleVal) => {
            const rawVal = (doubleVal !== undefined ? doubleVal : singleVal) ?? '';
            if (
              rawVal.includes('asset_url') ||
              rawVal.startsWith('http:') ||
              rawVal.startsWith('https:') ||
              rawVal.startsWith('//') ||
              rawVal.startsWith('data:') ||
              rawVal.startsWith('#') ||
              rawVal.startsWith('javascript:') ||
              rawVal.startsWith('mailto:') ||
              rawVal.startsWith('tel:')
            ) {
              return match;
            }
            const cleanFilename = resolveCanonicalAssetFilename(rawVal);
            if (!cleanFilename || isJunkOrThirdPartyAsset(cleanFilename)) return match;
            // `href` also carries page links (…/bai-viet-2026.html): only a real asset extension
            // may become an asset_url reference.
            if (!/\.(?:css|js|mjs|json|png|jpe?g|webp|avif|gif|svg|ico|bmp|woff2?|ttf|otf|eot|mp4|webm|mp3|pdf)$/i.test(cleanFilename)) {
              return match;
            }
            return `${prefix}${attr}="{{ '${cleanFilename}' | asset_url }}"`;
          }
        );

        // 2. Rewrite onerror fallback
        res = res.replace(
          /(^|\s)onerror\s*=\s*(?:"([^"]*)"|'([^']*)')/gi,
          (match, prefix, doubleVal, singleVal) => {
            const val = (doubleVal !== undefined ? doubleVal : singleVal) ?? '';
            const fallbackMatch = val.match(/((?:this\.)?src\s*=\s*)(?:&quot;|['"])(?:\.{1,3}\/|\/)*(?:assets\/)?([^"'?#\s]+\.[a-zA-Z0-9_-]+)(?:\?[^"']*)?(?:&quot;|['"]);?/i);
            if (fallbackMatch) {
              const cleanFilename = resolveCanonicalAssetFilename(fallbackMatch[2]);
              const safeJs = `${fallbackMatch[1]}&quot;{{ '${cleanFilename}' | asset_url }}&quot;;`;
              const replaced = val.replace(fallbackMatch[0], safeJs);
              return `${prefix}onerror="${replaced}"`;
            }
            return match;
          }
        );

        // 3. Rewrite srcset and data-srcset
        res = res.replace(
          /(^|\s)(srcset|data-srcset)=(?:"([^"]*)"|'([^']*)')/gi,
          (match, prefix, attr, doubleVal, singleVal) => {
            const val = (doubleVal !== undefined ? doubleVal : singleVal) ?? '';
            const quote = doubleVal !== undefined ? '"' : "'";
            if (val.includes('asset_url')) return match;
            const replaced = val.replace(
              /(?:\.{1,3}\/|\/)*(?:assets\/)?([^,\s?#]+\.[a-zA-Z0-9_-]+)(?:\?[^,\s]*)?/gi,
              (_m: string, f: string) => {
                const clean = resolveCanonicalAssetFilename(f);
                if (!/\.(?:css|js|mjs|json|png|jpe?g|webp|avif|gif|svg|ico|bmp|woff2?|ttf|otf|eot|mp4|webm|mp3|pdf)$/i.test(clean)) {
                  return _m;
                }
                return `{{ '${clean}' | asset_url }}`;
              }
            );
            return `${prefix}${attr}=${quote}${replaced}${quote}`;
          }
        );

        // 4. Rewrite url(...) in styles
        res = res.replace(
          /url\(\s*(['"]?)(?:\.{1,3}\/|\/)*(?:assets\/)?([^'")?#\s]+\.[a-zA-Z0-9_-]+)(?:[?#][^'")]*)?\1\s*\)/gi,
          (match, _quote, filename) => {
            if (filename.includes('asset_url') || filename.startsWith('data:') || filename.startsWith('http')) {
              return match;
            }
            const clean = resolveCanonicalAssetFilename(filename);
            return `url({{ '${clean}' | asset_url }})`;
          }
        );

        // 5. Final sweep: sweep any remaining relative asset references so zero ../assets/ survive
        res = res.replace(
          /(?:\.{1,3}\/|\/)+assets\/([^"'?#\s<>\)]+\.[a-zA-Z0-9_-]+)/gi,
          (_match: string, filename: string) => {
            const clean = resolveCanonicalAssetFilename(filename);
            return `{{ '${clean}' | asset_url }}`;
          }
        );

        return res;
      };
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
            const innerDesktop = sectionLiquid.replace(/<\/?header\b[^>]*>/gi, '');
            const innerMobile = rewrittenMobileHeader.replace(/<\/?header\b[^>]*>/gi, '');
            headerOutput = `<header class="site-header">\n  <div class="site-header__desktop desktop-only">\n${innerDesktop}\n  </div>\n  <div class="site-header__mobile mobile-only">\n${innerMobile}\n  </div>\n</header>`;
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
            const innerDesktop = sectionLiquid.replace(/<\/?footer\b[^>]*>/gi, '');
            const innerMobile = rewrittenMobileFooter.replace(/<\/?footer\b[^>]*>/gi, '');
            footerOutput = `<footer class="site-footer">\n  <div class="site-footer__desktop desktop-only">\n${innerDesktop}\n  </div>\n  <div class="site-footer__mobile mobile-only">\n${innerMobile}\n  </div>\n</footer>`;
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
          let finalSectionLiquid = sectionLiquid;
          if (snippetName.includes('quote_form') || sectionLiquid.includes('home-form')) {
            if (!finalSectionLiquid.includes('desktop-only')) {
              finalSectionLiquid = `<div class="desktop-only">\n${finalSectionLiquid}\n</div>`;
            }
          }
          fs.writeFileSync(snippetPath, finalSectionLiquid, 'utf-8');
          filesWritten.push(snippetPath);
          pageSectionIncludes.push({
            snippetName,
            enabledSettingId: enabledId,
          });
        }
      }
      if (hasBottomNav && mobileBottomNavContent) {
        let bottomNavOutput = rewriteLiquidAssets(mobileBottomNavContent);
        if (!bottomNavOutput.includes('mobile-only')) {
          bottomNavOutput = bottomNavOutput.replace(/class="([^"]*)"/i, 'class="$1 mobile-only"');
        }
        const bottomNavSnippetPath = path.join(stagingDir, 'snippets', 'bottom-navigation.liquid');
        fs.writeFileSync(bottomNavSnippetPath, bottomNavOutput, 'utf-8');
        filesWritten.push(bottomNavSnippetPath);
        emittedSnippetNames.add('bottom-navigation');
      }

      // 6. Generate flat templates/index.liquid composed with {% include %}
      // 1-DOM Invariant: Canonical single sequence of sections. Zero dual-surface split containers.
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

      // Safely preserve existing destination merchant settings
      const destSettingsDataPath = path.join(outputDir, 'config', 'settings_data.json');
      if (fs.existsSync(destSettingsDataPath)) {
        try {
          const existingRaw = fs.readFileSync(destSettingsDataPath, 'utf-8');
          const existingData = JSON.parse(existingRaw);
          if (existingData && typeof existingData === 'object') {
            const sourceMap =
              existingData.current && typeof existingData.current === 'object'
                ? existingData.current
                : existingData.presets?.Default && typeof existingData.presets.Default === 'object'
                  ? existingData.presets.Default
                  : existingData;
            for (const [k, v] of Object.entries(sourceMap)) {
              if (v !== undefined && v !== null) {
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

      // 9. Generate assets/theme.js
      // The declarative data-antifan-* contract is owned by exactly one runtime per artifact. The
      // clone's own engine resolves a bare state id through [data-antifan-state="<id>"] and drives
      // open/close/toggle from it; the synthesized generic runtime resolves the same attributes and,
      // for a bare id, resolves nothing and falls back to the trigger's next sibling. Emitting both
      // binds every trigger to two handlers that disagree: the first flips the resolved element, the
      // second reads the flipped state and flips it back, so the click ends up doing nothing. The
      // clone engine wins whenever it is present (it is the runtime the clone is verified with); the
      // synthesized runtime stays as the fallback for spec-built themes that carry no clone engine.
      const themeJsPath = path.join(stagingDir, 'assets', 'theme.js');
      const interactivityMatch =
        (desktopHtmlContent && desktopHtmlContent.match(/<script\s+id=["']antifan-clone-interactivity["']>([\s\S]*?)<\/script>/i)) ||
        (hasMobileSurface && mobileHtmlContent.match(/<script\s+id=["']antifan-clone-interactivity["']>([\s\S]*?)<\/script>/i));
      let cloneEngineJs = interactivityMatch ? interactivityMatch[1].trim() : '';
      if (cloneEngineJs) this.assertCodeOwnership(cloneEngineJs, 'inline clone interactivity runtime', options);
      if (cloneEngineJs.includes('function updateSlideMetrics')) {
        cloneEngineJs = cloneEngineJs.replace(
          /function\s+updateSlideMetrics\s*\(\)\s*\{[\s\S]*?updateSlideMetrics\(\);/i,
          `function updateSlideMetrics() {
        // Multi-item carousels (partner logos, news articles, accessories, product grids)
        // must retain their native responsive widths and never be forced to 100% full width.
        var isMultiItem = slider.closest('.partner, .partner-list, .news, .news-content, .accessory, [class*="product"]') ||
                          slider.querySelector('.article-item, .accessory-content__item, [class*="product-"]') ||
                          (slides[0] && (slides[0].classList.contains('article-item') || slides[0].getAttribute('data-href') !== null)) ||
                          (slider.id && (slider.id.includes('partner') || slider.id.includes('news')));
        if (isMultiItem) return;

        var sliderWidth = slider.clientWidth || list.clientWidth || window.innerWidth;
        if (sliderWidth > 0 && (track.classList.contains('s-content') || slider.classList.contains('s-wrap'))) {
          if (slides[0]) {
            var firstItemStyle = window.getComputedStyle(slides[0]);
            var firstItemW = parseFloat(firstItemStyle.width);
            if (firstItemW > 0 && firstItemW < sliderWidth * 0.75) {
              return;
            }
          }
          slides.forEach(function(s) {
            s.style.width = sliderWidth + 'px';
            s.style.flex = '0 0 ' + sliderWidth + 'px';
            s.style.maxWidth = sliderWidth + 'px';
            s.style.minWidth = sliderWidth + 'px';
          });
        }
      }
      updateSlideMetrics();`
        );
      }
      if (cloneEngineJs.includes("document.body.style.overflow = 'hidden';")) {
        cloneEngineJs = cloneEngineJs.replace(
          /var\s+openDrawer\s*=\s*function\(drawer\)\s*\{[\s\S]*?document\.body\.style\.overflow\s*=\s*['"]hidden['"];\s*\};/i,
          `var openDrawer = function(drawer) {
      if (!drawer) return;
      var targetClass = drawer.getAttribute('data-antifan-class') || 'show';
      drawer.classList.add(targetClass, 'show', 'active');
      drawer.setAttribute('data-antifan-opened', 'true');
      if (drawer.hasAttribute('data-antifan-target')) {
        drawer.style.removeProperty('display');
        drawer.style.display = 'block';
      }
      var isFullscreenDrawerOrModal = drawer.classList.contains('category-navigation__block') ||
                                      drawer.hasAttribute('data-antifan-drawer') ||
                                      drawer.classList.contains('mobile-drawer') ||
                                      drawer.classList.contains('drawer') ||
                                      drawer.classList.contains('offcanvas');
      if (isFullscreenDrawerOrModal) {
        document.body.style.overflow = 'hidden';
      }
    };`
        );
      }
      if (cloneEngineJs.includes('toggleTriggers.forEach')) {
        cloneEngineJs = cloneEngineJs.replace(
          /var\s+toggleTriggers\s*=\s*document\.querySelectorAll\(['"]\[data-antifan-toggle\]['"]\);[\s\S]*?toggleTriggers\.forEach\(function\(btn\)\s*\{[\s\S]*?\}\);\s*\}\);/i,
          `var toggleTriggers = document.querySelectorAll('[data-antifan-toggle]');
    toggleTriggers.forEach(function(btn) {
      if (btn.classList.contains('info-more__button')) return;
      btn.addEventListener('click', function(e) {
        e.preventDefault();
        var prop = btn.getAttribute('data-antifan-toggle');
        var target = btn.closest('[data-antifan-state="' + prop + '"], [data-antifan-target="' + prop + '"]') ||
                     btn.querySelector('[data-antifan-state="' + prop + '"], [data-antifan-target="' + prop + '"]') ||
                     (btn.parentElement && btn.parentElement.querySelector('[data-antifan-state="' + prop + '"], [data-antifan-target="' + prop + '"]')) ||
                     document.querySelector('[data-antifan-state="' + prop + '"], [data-antifan-target="' + prop + '"]');
        if (target) {
          var isOverlay = target.classList.contains('category-navigation__block') || target.hasAttribute('data-antifan-drawer') || target.classList.contains('drawer') || target.classList.contains('mobile-drawer') || target.classList.contains('offcanvas');
          if (isOverlay) {
            var targetClass = target.getAttribute('data-antifan-class') || 'show';
            if (target.classList.contains(targetClass) || target.classList.contains('show') || target.classList.contains('active')) {
              closeDrawer(target);
            } else {
              openDrawer(target);
            }
          } else {
            var targetClass = target.getAttribute('data-antifan-class') || 'active';
            if (target.classList.contains(targetClass) || target.classList.contains('show') || target.classList.contains('active')) {
              target.classList.remove(targetClass, 'show', 'active');
              target.style.display = 'none';
            } else {
              target.classList.add(targetClass, 'show', 'active');
              target.style.removeProperty('display');
              target.style.display = 'block';
            }
          }
        }
      });
    });`
        );
      }
      const runtimeJs = cloneEngineJs
        ? `/* Antifan Clone Interactive Engine */\n${cloneEngineJs}\n`
        : this.stateSynth.generateDeclarativeRuntime();
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
      const mobileMax = ir.layout?.breakpoints?.mobileMax;
      const effectiveMobileMax = mobileMax || 991;
      const mobileMediaQuery = `@media (max-width: ${effectiveMobileMax}px)`;

      // Synthesize mobile stylesheets wrapped under @media (max-width: mobileMax)
      const loadedMobileCssFiles = new Set<string>();
      const mobileCandidateDirs = new Set<string>();
      if (mobileAssetsDir && fs.existsSync(mobileAssetsDir)) {
        mobileCandidateDirs.add(mobileAssetsDir);
      }
      for (const sDir of searchDirs) {
        if (!fs.existsSync(sDir)) continue;
        if (sDir.toLowerCase().includes('mobile') && sDir.toLowerCase().includes('assets')) {
          mobileCandidateDirs.add(sDir);
        }
        const subMobile = path.join(sDir, 'mobile', 'assets');
        if (fs.existsSync(subMobile)) {
          mobileCandidateDirs.add(subMobile);
        }
        const siblingMobile = path.join(path.dirname(sDir), 'mobile', 'assets');
        if (fs.existsSync(siblingMobile)) {
          mobileCandidateDirs.add(siblingMobile);
        }
      }

      for (const mDir of mobileCandidateDirs) {
        try {
          const files = fs.readdirSync(mDir);
          for (const file of files) {
            if (file.toLowerCase().endsWith('.css') && !isJunkOrThirdPartyAsset(file)) {
              const fullPath = path.join(mDir, file);
              if (fs.existsSync(fullPath) && fs.statSync(fullPath).isFile()) {
                const fileKey = `${file}:${fs.statSync(fullPath).size}`;
                if (loadedMobileCssFiles.has(fileKey)) continue;
                loadedMobileCssFiles.add(fileKey);
                try {
                  const content = fs.readFileSync(fullPath, 'utf-8');
                  const cleanContent = content.replace(/^\s*@charset\s+["'][^"']+["'];\s*/i, '');
                  if (cleanContent.trim().length > 0) {
                    themeCssParts.push(
                      `/* Mobile Stylesheet: ${file} */\n@media (max-width: ${effectiveMobileMax}px) {\n${cleanContent}\n}`
                    );
                  }
                } catch {}
              }
            }
          }
        } catch {}
      }

      // Check for mobile stylesheets directly in searchDirs
      for (const sDir of searchDirs) {
        if (!fs.existsSync(sDir)) continue;
        try {
          const files = fs.readdirSync(sDir);
          for (const file of files) {
            if (
              file.toLowerCase().endsWith('.css') &&
              /(?:^|[-_.])mobile(?:[-_.]|$)/i.test(file) &&
              !isJunkOrThirdPartyAsset(file)
            ) {
              const fullPath = path.join(sDir, file);
              if (fs.existsSync(fullPath) && fs.statSync(fullPath).isFile()) {
                const fileKey = `${file}:${fs.statSync(fullPath).size}`;
                if (loadedMobileCssFiles.has(fileKey)) continue;
                loadedMobileCssFiles.add(fileKey);
                try {
                  const content = fs.readFileSync(fullPath, 'utf-8');
                  const cleanContent = content.replace(/^\s*@charset\s+["'][^"']+["'];\s*/i, '');
                  if (cleanContent.trim().length > 0) {
                    themeCssParts.push(
                      `/* Mobile Stylesheet: ${file} */\n@media (max-width: ${effectiveMobileMax}px) {\n${cleanContent}\n}`
                    );
                  }
                } catch {}
              }
            }
          }
        } catch {}
      }

      // Add standard responsive utilities to theme.css
      const responsiveUtilitiesCss = `/* Standard Responsive Visibility Utilities */
@media (max-width: ${effectiveMobileMax}px) {
  .desktop-only, .site-header__desktop, .site-footer__desktop { display: none !important; }
  .mobile-only, .site-header__mobile, .site-footer__mobile { display: block !important; }
}
@media (min-width: ${effectiveMobileMax + 1}px) {
  .desktop-only, .site-header__desktop, .site-footer__desktop { display: block !important; }
  .mobile-only, .site-header__mobile, .site-footer__mobile { display: none !important; }
}
body[data-device="mobile"] .desktop-only,
body[data-device="mobile"] .site-header__desktop,
body[data-device="mobile"] .site-footer__desktop {
  display: none !important;
}
body[data-device="mobile"] .mobile-only,
body[data-device="mobile"] .site-header__mobile,
body[data-device="mobile"] .site-footer__mobile {
  display: block !important;
}`;
      themeCssParts.push(responsiveUtilitiesCss);

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
/* Swiper Container & Wrapper Unified Architecture */
.s-wrap.swiper {
  overflow: hidden !important;
  position: relative;
}
.s-wrap.swiper .s-content.swiper-wrapper {
  display: flex !important;
  flex-wrap: nowrap !important;
  overflow: visible !important;
  scroll-snap-type: none !important;
  box-sizing: content-box;
}
.swiper .swiper-wrapper > .swiper-slide,
.s-wrap.swiper .s-content.swiper-wrapper > .swiper-slide,
.s-wrap.swiper .s-content.swiper-wrapper > .item {
  flex: 0 0 auto !important;
  max-width: none !important;
  min-width: 0 !important;
  flex-shrink: 0 !important;
  scroll-snap-align: none !important;
  box-sizing: border-box;
}

/* News Slider Cards Height & Aspect Ratio */
.news-content #slide-1.swiper {
  width: 100%;
  overflow: hidden;
  position: relative;
}
.news-content #slide-1 .article-item {
  height: auto;
  display: flex;
  flex-direction: column;
}
.news-content #slide-1 .thumbnail-item {
  width: 100%;
  height: 190px;
  overflow: hidden;
  border-radius: 6px;
  background: #f0f2f5;
}
.news-content #slide-1 .thumbnail-item img {
  width: 100%;
  height: 100%;
  object-fit: cover;
  transition: transform .3s;
}
.news-content #slide-1 .article-item:hover .thumbnail-item img {
  transform: scale(1.05);
}

/* Navigation buttons for News and sliders */
.news-content__block {
  position: relative;
}
.news-content__block .nav-prev,
.news-content__block .nav-next,
#slide-1 .nav-prev,
#slide-1 .nav-next {
  position: absolute;
  top: 40%;
  transform: translateY(-50%);
  width: 40px;
  height: 40px;
  border-radius: 50%;
  background: #fff;
  box-shadow: 0 3px 10px rgba(0, 0, 0, 0.15);
  display: flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
  z-index: 20;
  transition: all .25s;
  color: #134374;
}
.news-content__block .nav-prev:hover,
.news-content__block .nav-next:hover,
#slide-1 .nav-prev:hover,
#slide-1 .nav-next:hover {
  background: #134374;
  color: #fff;
}
.news-content__block .nav-prev,
#slide-1 .nav-prev {
  left: -20px;
}
.news-content__block .nav-next,
#slide-1 .nav-next {
  right: -20px;
}
.news-content__block .swiper-button-disabled,
#slide-1 .swiper-button-disabled {
  opacity: 0 !important;
  pointer-events: none !important;
  cursor: default;
}

/* Form file upload tooltip popup (.info-more__button -> .detail) */
.form-block__content .form-row.row-file {
  position: relative;
}
.form-block__content .form-row.row-file .info-more__button {
  cursor: pointer;
}
.form-block__content .form-row.row-file .detail {
  z-index: 1002 !important;
  max-height: 85vh !important;
  overflow-y: auto !important;
  -webkit-overflow-scrolling: touch !important;
}
.form-block__content .form-row.row-file .detail.active {
  display: block !important;
  opacity: 1 !important;
  visibility: visible !important;
  pointer-events: auto !important;
}

${responsiveUtilitiesCss}

/* Mobile Touch Carousel & Zero Horizontal Overflow Rules */
@media (max-width: ${effectiveMobileMax}px) {
  .home-form { display: none !important; }
  .block-category__item.flex { flex-direction: column !important; }
  .block-category__left { width: 100% !important; margin-bottom: 15px !important; }
  .product-list.flex {
    display: flex !important;
    flex-wrap: nowrap !important;
    overflow-x: auto !important;
    -webkit-overflow-scrolling: touch !important;
    scroll-snap-type: x mandatory !important;
    gap: 12px !important;
    padding-bottom: 15px !important;
  }
  .product-list.flex .product-list__item {
    flex: 0 0 240px !important;
    max-width: 240px !important;
    scroll-snap-align: start !important;
  }
  .suggest, .search-popular, .category-navigation {
    max-width: 100vw !important;
    overflow-x: hidden !important;
  }
  body, html {
    overflow-x: hidden !important;
  }
}
`;
      fs.writeFileSync(customCssPath, customCssDefault, 'utf-8');
      if (!filesWritten.includes(customCssPath)) filesWritten.push(customCssPath);
      // 9b. Copy, resolve, and fail-closed audit of all referenced theme assets
      hasAssetContext = Boolean(
        (options?.assetsDir && fs.existsSync(options.assetsDir as string)) ||
        (typeof options?.inputPath === 'string' && options.inputPath) ||
        Boolean(options?.failClosedAssets)
      );

      if (hasAssetContext) {
        const mobileAssetFilenames = new Set<string>();
        const mobileAssetPaths = new Set<string>();
        for (const item of allIrAssets) {
          const rawItem = item as unknown as Record<string, unknown>;
          const isMobileOnly = Boolean(
            (item.occurrences && item.occurrences.length > 0 && item.occurrences.every((o) => o.surface === 'mobile')) ||
            rawItem.surface === 'mobile' ||
            rawItem.requestIdentity === 'mobile'
          );
          if (isMobileOnly) {
            if (item.filename) mobileAssetFilenames.add(item.filename.toLowerCase());
            if (item.localPath) mobileAssetPaths.add(path.resolve(item.localPath).toLowerCase());
          }
        }

        const isMobileAsset = (filename: string, filePath?: string): boolean => {
          const lowerName = filename.toLowerCase();
          if (mobileAssetFilenames.has(lowerName)) return true;
          if (filePath && mobileAssetPaths.has(path.resolve(filePath).toLowerCase())) return true;
          if (filePath) {
            const parts = path.resolve(filePath).toLowerCase().split(/[/\\]/);
            if (parts.includes('mobile')) return true;
          }
          if (lowerName.endsWith('.css') && /(?:^|[-_.])mobile(?:[-_.]|$)/i.test(lowerName)) {
            return true;
          }
          return false;
        };

        const wrapMobileCssIfNeeded = (rawCss: string): string => {
          if (!mobileMediaQuery) return rawCss;
          if (isAlreadyMediaWrapped(rawCss)) return rawCss;
          const cleanCss = rawCss.replace(/^\s*@charset\s+["'][^"']+["'];\s*/i, '');
          return `@charset "UTF-8";\n${mobileMediaQuery} {\n${cleanCss}\n}`;
        };
        const wrapMobileJsIfNeeded = (rawJs: string, filename: string): string => {
          const lower = filename.toLowerCase();
          if (lower === 'home.js' || (lower.endsWith('.js') && rawJs.includes('.slick(') && rawJs.includes('breakpoint:768'))) {
            if (rawJs.includes('window.innerWidth <= 768') || rawJs.includes('window.innerWidth < 768')) return rawJs;
            return `/* AntiFan Mobile-Gated Carousel Runtime */\nif (typeof window !== 'undefined' && window.innerWidth <= 768) {\n${rawJs}\n}`;
          }
          return rawJs;
        };

        // 1. Copy all real files from searchDirs into stagingDir/assets
        for (const sDir of searchDirs) {
          if (!fs.existsSync(sDir)) continue;
          try {
            const diskFiles = fs.readdirSync(sDir).sort();
            for (const diskFile of diskFiles) {
              if (isJunkOrThirdPartyAsset(diskFile)) continue;
              if (diskFile === 'theme.css' || diskFile === 'custom.css') continue;
              const srcPath = path.join(sDir, diskFile);
              if (!fs.statSync(srcPath).isFile()) continue;
              const destPath = path.join(stagingDir, 'assets', diskFile);
              const isCss = diskFile.toLowerCase().endsWith('.css');
              const mobileOnly = isCss && isMobileAsset(diskFile, srcPath);

              if (mobileOnly) {
                const rawCss = fs.readFileSync(srcPath, 'utf-8');
                const wrappedCss = wrapMobileCssIfNeeded(rawCss);
                if (fs.existsSync(destPath)) {
                  const existingContent = fs.readFileSync(destPath, 'utf-8');
                  if (existingContent !== wrappedCss) {
                    throw new Error(
                      `ThemeCompiler: asset collision for "${diskFile}": source file ${srcPath} collides with existing staged file ${destPath}`
                    );
                  }
                } else {
                  fs.writeFileSync(destPath, wrappedCss, 'utf-8');
                  if (!filesWritten.includes(destPath)) filesWritten.push(destPath);
                }
              } else {
                const isJs = diskFile.toLowerCase().endsWith('.js');
                if (isJs) {
                  const rawJs = fs.readFileSync(srcPath, 'utf-8');
                  const wrappedJs = wrapMobileJsIfNeeded(rawJs, diskFile);
                  if (fs.existsSync(destPath) && fs.readFileSync(destPath, 'utf8') !== wrappedJs) {
                    throw new Error(`ThemeCompiler: asset collision for "${diskFile}"`);
                  }
                  fs.writeFileSync(destPath, wrappedJs, 'utf-8');
                  if (!filesWritten.includes(destPath)) filesWritten.push(destPath);
                } else {
                  if (fs.existsSync(destPath)) {
                    const srcHash = computeFileSha256(srcPath);
                    const destHash = computeFileSha256(destPath);
                    if (srcHash !== destHash) {
                      throw new Error(
                        `ThemeCompiler: asset collision for "${diskFile}": source file ${srcPath} (${srcHash}) collides with existing staged file ${destPath} (${destHash})`
                      );
                    }
                  } else {
                    fs.copyFileSync(srcPath, destPath);
                    if (!filesWritten.includes(destPath)) filesWritten.push(destPath);
                  }
                }
              }
              const canonicalDiskFile = resolveCanonicalAssetFilename(diskFile);
              if (canonicalDiskFile !== diskFile) {
                const canonDestPath = path.join(stagingDir, 'assets', canonicalDiskFile);
                if (!fs.existsSync(canonDestPath)) {
                  fs.copyFileSync(srcPath, canonDestPath);
                  if (!filesWritten.includes(canonDestPath)) filesWritten.push(canonDestPath);
                }
              }
            }
          } catch (err: unknown) {
            if (err instanceof Error && err.message.startsWith('ThemeCompiler: asset collision')) throw err;
          }
        }

        // 2. Copy valid IR assets
        for (const item of allIrAssets) {
          if (item.filename && item.localPath && fs.existsSync(item.localPath) && fs.statSync(item.localPath).isFile()) {
            if (item.filename === 'theme.css' || item.filename === 'custom.css') continue;
            const destPath = path.join(stagingDir, 'assets', item.filename);
            const isCss = item.filename.toLowerCase().endsWith('.css');
            const mobileOnly = isCss && isMobileAsset(item.filename, item.localPath);

            if (mobileOnly) {
              const rawCss = fs.readFileSync(item.localPath, 'utf-8');
              const wrappedCss = wrapMobileCssIfNeeded(rawCss);
              if (fs.existsSync(destPath)) {
                const existingContent = fs.readFileSync(destPath, 'utf-8');
                if (existingContent !== wrappedCss) {
                  if (!isAlreadyMediaWrapped(existingContent) && isAlreadyMediaWrapped(wrappedCss)) {
                    fs.writeFileSync(destPath, wrappedCss, 'utf-8');
                  } else {
                    throw new Error(
                      `ThemeCompiler: asset collision for "${item.filename}": IR asset ${item.localPath} collides with existing staged file ${destPath}`
                    );
                  }
                }
              } else {
                fs.writeFileSync(destPath, wrappedCss, 'utf-8');
                if (!filesWritten.includes(destPath)) filesWritten.push(destPath);
              }
            } else {
              const isJs = item.filename.toLowerCase().endsWith('.js');
              if (isJs) {
                const rawJs = fs.readFileSync(item.localPath, 'utf-8');
                const wrappedJs = wrapMobileJsIfNeeded(rawJs, item.filename);
                if (fs.existsSync(destPath) && fs.readFileSync(destPath, 'utf8') !== wrappedJs) {
                  throw new Error(`ThemeCompiler: asset collision for "${item.filename}"`);
                }
                fs.writeFileSync(destPath, wrappedJs, 'utf-8');
                if (!filesWritten.includes(destPath)) filesWritten.push(destPath);
              } else {
                if (fs.existsSync(destPath)) {
                  const srcHash = computeFileSha256(item.localPath);
                  const destHash = computeFileSha256(destPath);
                  if (srcHash !== destHash) {
                    throw new Error(
                      `ThemeCompiler: asset collision for "${item.filename}": IR asset ${item.localPath} (${srcHash}) collides with existing staged file ${destPath} (${destHash})`
                    );
                  }
                } else {
                  fs.copyFileSync(item.localPath, destPath);
                  if (!filesWritten.includes(destPath)) filesWritten.push(destPath);
                }
              }
            }
            const canonicalItemFile = resolveCanonicalAssetFilename(item.filename);
            if (canonicalItemFile !== item.filename) {
              const canonDestPath = path.join(stagingDir, 'assets', canonicalItemFile);
              if (!fs.existsSync(canonDestPath)) {
                fs.copyFileSync(item.localPath, canonDestPath);
                if (!filesWritten.includes(canonDestPath)) filesWritten.push(canonDestPath);
              }
            }
          }
        }

        // 3. Recursively scan stagingDir for referenced assets
        const referencedAssets = new Set<string>();
        const scanDirForAssetRefs = (dir: string) => {
          if (!fs.existsSync(dir)) return;
          const entries = fs.readdirSync(dir, { withFileTypes: true });
          for (const entry of entries) {
            const fullPath = path.join(dir, entry.name);
            if (entry.isDirectory()) {
              scanDirForAssetRefs(fullPath);
            } else if (entry.isFile()) {
              const ext = path.extname(entry.name).toLowerCase();
              if (['.liquid', '.html', '.css', '.json'].includes(ext)) {
                try {
                  const text = fs.readFileSync(fullPath, 'utf-8');
                  const liquidAssetMatches = text.matchAll(/\{\{\s*['"]([^'"]+)['"]\s*\|\s*asset_url\b[^}]*\}\}/g);
                  for (const m of liquidAssetMatches) {
                    const ref = m[1].trim();
                    const cleanRef = resolveCanonicalAssetFilename(path.basename(ref.split(/[?#]/)[0]));
                    const refExt = path.extname(cleanRef).toLowerCase();
                    if (
                      ref &&
                      THEME_STATIC_ASSET_EXTENSIONS.has(refExt) &&
                      !ref.includes('{{') &&
                      !ref.includes('settings.') &&
                      !isJunkOrThirdPartyAsset(ref)
                    ) {
                      referencedAssets.add(ref);
                    }
                  }
                  const cssUrlMatches = text.matchAll(/url\(\s*['"]?(?:assets\/)?([^'"\)\?#]+)(?:[\?#][^'"]*)?['"]?\s*\)/g);
                  for (const m of cssUrlMatches) {
                    const raw = m[1].trim();
                    // Inline bytes and remote URLs are not theme asset filenames, and an inline SVG
                    // payload carries nested url(%23gradient-id) fragments. Test the raw capture:
                    // path.basename() mangles a data URI into "svg+xml;base64,…".
                    if (/^data:/i.test(raw) || raw.includes(',') || raw.includes(';') || /:\/\//.test(raw) || raw.startsWith('//')) {
                      continue;
                    }
                    const ref = path.basename(raw);
                    const refExt = path.extname(ref).toLowerCase();
                    if (ref && THEME_STATIC_ASSET_EXTENSIONS.has(refExt) && !ref.includes('{{') && !isJunkOrThirdPartyAsset(ref)) {
                      referencedAssets.add(ref);
                    }
                  }
                } catch {}
              }
            }
          }
        };
        scanDirForAssetRefs(stagingDir);

        // 4. Resolve each referenced asset against real files
        for (const ref of referencedAssets) {
          const stagedAssetPath = path.join(stagingDir, 'assets', ref);
          if (fs.existsSync(stagedAssetPath) && fs.statSync(stagedAssetPath).size > 0) {
            continue;
          }

          const resolved = resolveRealAsset(ref, searchDirs, cloneAssetMap, allIrAssets);
          if (resolved) {
            if (/\.(?:css|m?js)$/i.test(ref)) this.assertCodeOwnership(fs.readFileSync(resolved.sourcePath, 'utf8'), resolved.sourcePath, options);
            if (fs.existsSync(stagedAssetPath)) {
              const srcHash = computeFileSha256(resolved.sourcePath);
              const destHash = computeFileSha256(stagedAssetPath);
              if (srcHash !== destHash) {
                throw new Error(
                  `ThemeCompiler: asset collision for "${ref}": resolved source ${resolved.sourcePath} (${srcHash}) collides with existing staged file ${stagedAssetPath} (${destHash})`
                );
              }
            } else {
              fs.copyFileSync(resolved.sourcePath, stagedAssetPath);
              if (!filesWritten.includes(stagedAssetPath)) filesWritten.push(stagedAssetPath);
            }
          } else {
            throw new Error(
              `ThemeCompiler: fail-closed asset audit failed: referenced asset "${ref}" could not be resolved from search locations: [${searchDirs.join(', ')}]. Compilation refused to emit missing or stub asset.`
            );
          }
        }

        // 5. Strict fail-closed verification: every referenced asset must exist with >0 bytes
        for (const ref of referencedAssets) {
          const stagedAssetPath = path.join(stagingDir, 'assets', ref);
          if (!fs.existsSync(stagedAssetPath)) {
            throw new Error(
              `ThemeCompiler: fail-closed asset audit failed: referenced asset "${ref}" does not exist in staged assets.`
            );
          }
          if (fs.statSync(stagedAssetPath).size === 0) {
            throw new Error(
              `ThemeCompiler: fail-closed asset audit failed: referenced asset "${ref}" exists but is empty (0 bytes).`
            );
          }
        }
      }

      // 9c. Normalize undeclared settings without silent asset synthesis
      const normResult = SettingsAssetsNormalizer.normalizeTheme(
        stagingDir,
        targetContract.settingsMode,
        { allowSynthesis: false }
      );
      if (hasAssetContext && normResult.assetResult && normResult.assetResult.missingCount > 0) {
        throw new Error(
          `ThemeCompiler: fail-closed asset audit failed: ${normResult.assetResult.missingCount} theme assets missing: ${normResult.assetResult.missingAssets?.join(', ')}`
        );
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

      // 10. Validate staging integrity before swap. The localization pipeline defers the
      // asset-reference gate to its own promotion boundary, after localized bytes land.
      this.validateStagingTheme(stagingDir, targetContract);
      if (!options?.deferFinalAssetValidation && hasAssetContext) this.validateFinalAssetReferences(stagingDir);
      this.atomicSwap(stagingDir, outputDir, dirs, options);
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

  private atomicSwap(stagingDir: string, outputDir: string, dirs: string[], options?: ThemeCompilerOptions): void {
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
              if (!options?.force && !options?.clean && process.env.ANTIFAN_THEME_FORCE !== 'true') {
                throw new Error(
                  `ThemeCompiler: overwrite conflict on user-owned file "${themeRelPath}". Compilation refused to overwrite unmanaged file.`
                );
              }
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
          } else if (fs.existsSync(destSub)) {
            fs.rmSync(destSub, { recursive: true, force: true });
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

  public promoteStagedTheme(stagingDir: string, outputDir: string, options: ThemeCompilerOptions = {}): void {
    const contract = createHaravanTargetContract({ settingsMode: options.settingsMode as HaravanSettingsMode });
    this.validateStagingTheme(stagingDir, contract);
    const manifest: HarvestedAssetManifest = { stylesheets: [], javascripts: [], images: [], fonts: [], totalBytes: 0 };
    const assetsDir = path.join(stagingDir, 'assets');
    if (!fs.existsSync(assetsDir) || !fs.statSync(assetsDir).isDirectory()) {
      throw new Error('ThemeCompiler: staged theme has no assets/ directory to promote');
    }
    for (const filename of fs.readdirSync(assetsDir)) {
      const localPath = path.join(assetsDir, filename);
      if (!fs.statSync(localPath).isFile()) throw new Error(`ThemeCompiler: non-flat asset ${filename}`);
      const ext = path.extname(filename).toLowerCase();
      const type: HarvestedAssetItem['type'] = ext === '.css' ? 'css' : ['.js', '.mjs'].includes(ext) ? 'js' : ['.woff', '.woff2', '.ttf', '.otf', '.eot'].includes(ext) ? 'font' : 'image';
      const item: HarvestedAssetItem = { filename, localPath, type, sourceUrl: pathToFileURL(localPath).href };
      const bucket = type === 'css' ? manifest.stylesheets : type === 'js' ? manifest.javascripts : type === 'font' ? manifest.fonts : manifest.images;
      bucket.push(item);
    }
    const rewrittenFiles = ['layout', 'templates', 'snippets'].flatMap(dir => {
      const fullDir = path.join(stagingDir, dir);
      return fs.existsSync(fullDir) ? fs.readdirSync(fullDir).filter(file => file.endsWith('.liquid')).map(file => {
        const filePath = path.join(fullDir, file);
        const content = fs.readFileSync(filePath, 'utf8');
        return { path: filePath, originalContent: content, rewrittenContent: content, replacementCount: 0 };
      }) : [];
    });
    const audit = new AssetLocalizer().verifyAndAudit(manifest, { assetsDir, rewrittenFiles });
    if (!audit.passed) throw new Error(`ThemeCompiler: final asset audit failed: ${audit.findings.map(f => f.message).join('; ')}`);
    this.validateFinalAssetReferences(stagingDir);
    this.atomicSwap(stagingDir, outputDir, ['layout', 'templates', 'snippets', 'assets', 'config'], options);
  }

  private validateFinalAssetReferences(stagingDir: string): void {
    const assetsDir = path.join(stagingDir, 'assets');
    for (const d of ['layout', 'templates', 'snippets']) {
      const fullDirPath = path.join(stagingDir, d);
      if (!fs.existsSync(fullDirPath)) continue;
      for (const file of fs.readdirSync(fullDirPath)) {
        if (!file.endsWith('.liquid')) continue;
        const content = fs.readFileSync(path.join(fullDirPath, file), 'utf-8');
        for (const match of content.matchAll(/\{\{\s*['"]([^'"]+)['"]\s*\|\s*asset_url\b/g)) {
          const asset = match[1];
          if (path.basename(asset) !== asset || asset.includes('\\') || asset === '..') {
            throw new Error(`ThemeCompiler: invalid final asset reference ${asset} in ${d}/${file}`);
          }
          const assetPath = path.join(assetsDir, asset);
          if (!fs.existsSync(assetPath) || !fs.statSync(assetPath).isFile() || fs.statSync(assetPath).size === 0) {
            throw new Error(`ThemeCompiler: unresolved final asset reference ${asset} in ${d}/${file}`);
          }
        }
      }
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

  /**
   * Dynamically extracts page-specific head assets (stylesheets, media queries, inline styles)
   * from any route's Desktop and Mobile HTML documents, filtering out global stylesheets
   * already bundled into theme.css.
   */
  public extractRouteHeadAssets(
    desktopHtml?: string,
    mobileHtml?: string,
    globalBundledSheets?: Set<string>
  ): RouteHeadAssetsResult {
    const defaultGlobals = new Set([
      'theme.css',
      'custom.css',
      'app.css',
      'app-dcc2d3nb.css',
      'app-mobile-5wa_jy_a.css',
      'home.css',
      'home-desktop-cw7dk4ja.css',
      'home-mobile-1bp5y6oy.css',
    ]);
    const globals = globalBundledSheets
      ? new Set([...globalBundledSheets, ...defaultGlobals])
      : defaultGlobals;

    const parseSheets = (html?: string): string[] => {
      if (!html) return [];
      const headMatch = html.match(/<head\b[^>]*>([\s\S]*?)<\/head>/i);
      const scope = headMatch ? headMatch[1] : html;
      const links = scope.match(/<link[^>]*rel=["']stylesheet["'][^>]*>/gi) || [];
      const sheets: string[] = [];
      for (const link of links) {
        const m = link.match(/href=["']([^"']+)["']/i);
        if (m) {
          const clean = m[1].split('?')[0].split('#')[0];
          const filename = path.basename(clean);
          if (
            filename &&
            filename.toLowerCase().endsWith('.css') &&
            !isJunkOrThirdPartyAsset(filename) &&
            !globals.has(filename) &&
            !sheets.includes(filename)
          ) {
            sheets.push(filename);
          }
        }
      }
      return sheets;
    };

    const parseStyles = (html?: string): string[] => {
      if (!html) return [];
      const headMatch = html.match(/<head\b[^>]*>([\s\S]*?)<\/head>/i);
      const scope = headMatch ? headMatch[1] : html;
      const styles = scope.match(/<style\b[^>]*>([\s\S]*?)<\/style>/gi) || [];
      const res: string[] = [];
      for (const s of styles) {
        const cleaned = s
          .replace(/^<style\b[^>]*>/i, '')
          .replace(/<\/style>$/i, '')
          .trim();
        if (
          cleaned.length > 0 &&
          !cleaned.includes('wire:loading') &&
          !cleaned.includes('--livewire-progress') &&
          !cleaned.includes('antifan-clone-parity') &&
          !cleaned.includes('recaptcha') &&
          !cleaned.includes('wpcf7')
        ) {
          res.push(cleaned);
        }
      }
      return res;
    };

    const dSheets = parseSheets(desktopHtml);
    const mSheets = parseSheets(mobileHtml);

    const sharedStylesheets = dSheets.filter((s) => mSheets.includes(s));
    const desktopStylesheets = dSheets.filter((s) => !mSheets.includes(s));
    const mobileStylesheets = mSheets.filter((s) => !dSheets.includes(s));

    const desktopInlineStyles = parseStyles(desktopHtml);
    const mobileInlineStyles = parseStyles(mobileHtml);

    const tags: string[] = [];
    for (const s of sharedStylesheets) {
      tags.push(`{{ '${s}' | asset_url | stylesheet_tag }}`);
    }
    for (const s of desktopStylesheets) {
      tags.push(
        `<link rel="stylesheet" href="{{ '${s}' | asset_url }}" media="screen and (min-width: 992px)">`
      );
    }
    for (const s of mobileStylesheets) {
      tags.push(
        `<link rel="stylesheet" href="{{ '${s}' | asset_url }}" media="screen and (max-width: 991px)">`
      );
    }
    for (const inline of desktopInlineStyles) {
      tags.push(
        `<style media="screen and (min-width: 992px)">\n${inline}\n</style>`
      );
    }
    for (const inline of mobileInlineStyles) {
      tags.push(
        `<style media="screen and (max-width: 991px)">\n${inline}\n</style>`
      );
    }

    return {
      desktopStylesheets,
      mobileStylesheets,
      sharedStylesheets,
      desktopInlineStyles,
      mobileInlineStyles,
      liquidAssetTags: tags.join('\n'),
    };
  }
}
