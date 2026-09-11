/**
 * Multi-Page Manifest & ThemeBundleIR Models & Engine (Audit §53)
 *
 * Grounded in Haravan OS 2.0 multi-surface storefront compilation:
 * - Multi-Page Surface Catalog & Route Mapping
 * - ThemeBundle Intermediate Representation (ThemeBundleIR)
 * - Global Asset Bundling (CSS, JS, Images, Fonts)
 * - Staged Settings & Canaries (Fixtures & Cleanups)
 * - Bundle Integrity Validation & Fail-Closed Serialization
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { RouteResolver } from '../platform/haravan/route-resolver.js';
import type { HaravanRouteIdentity, ReferenceRouteIdentity } from '../platform/haravan/types.js';

// ============================================================================
// Core Interfaces & Models (§53, P0.1)
// ============================================================================
export interface PageSurface {
  id: string;
  name: string;
  route: any;
  template: string;
  entities: any[];
  sections: string[];
  viewports: string[];
}

export interface GlobalAssetsManifest {
  stylesheets: string[];
  scripts: string[];
  images: string[];
  fonts: string[];
}

export interface ThemeSettingsManifest {
  schema: any[];
  data: Record<string, any>;
}

export interface ThemeFixtureManifest {
  id: string;
  type: string;
  cleanupTag: string;
  [key: string]: any;
}

export interface ThemeBundleMetadata {
  version: string;
  generatedAt: string;
  sourceStore?: string;
  targetThemeId: string | number;
  [key: string]: any;
}

export interface ThemeBundleIR {
  surfaces: PageSurface[];
  globalAssets: GlobalAssetsManifest;
  settings: ThemeSettingsManifest;
  fixtures: ThemeFixtureManifest[];
  metadata: ThemeBundleMetadata;
  [key: string]: any;
}

export interface PageManifest extends ThemeBundleIR {}

export interface BundleIntegrityValidationResult {
  valid: boolean;
  missingSurfaces: string[];
  errors: string[];
}

export interface BuildBundleIROptions {
  surfaces?: Array<Partial<PageSurface> | any>;
  globalAssets?: Partial<GlobalAssetsManifest>;
  settings?: Partial<ThemeSettingsManifest>;
  fixtures?: Array<Partial<ThemeFixtureManifest> | any>;
  metadata?: Partial<ThemeBundleMetadata>;
  sourceStore?: string;
  targetThemeId?: string | number;
  version?: string;
  [key: string]: any;
}

export interface BundleValidationOptions {
  requiredSurfaces?: string[];
  allowCustomSurfaces?: boolean;
}

// ============================================================================
// Constants & Defaults
// ============================================================================

export const DEFAULT_VIEWPORTS = ['desktop', 'tablet', 'mobile'];
export const MANIFEST_FILENAME = 'page-manifest.json';
export const LEGACY_MANIFEST_FILENAMES = ['page-manifest.json', 'theme-bundle-ir.json', 'manifest.json'];

// ============================================================================
// Page Manifest Engine (§53, P0.2)
// ============================================================================

export class PageManifestEngine {
  private routeResolver: RouteResolver;

  constructor(routeResolver?: RouteResolver) {
    this.routeResolver = routeResolver || new RouteResolver();
  }

  /**
   * Constructs a fully normalized ThemeBundleIR from loose options or raw inputs.
   * Applies fail-safe defaults, deduplication, and schema validation.
   */
  public buildBundleIR(options: BuildBundleIROptions = {}): ThemeBundleIR {
    const rawSurfaces = Array.isArray(options.surfaces) ? options.surfaces : [];
    const surfaces: PageSurface[] = rawSurfaces.map((s, idx) => this.normalizeSurface(s, idx));

    const rawAssets = options.globalAssets || {};
    const globalAssets: GlobalAssetsManifest = {
      stylesheets: this.deduplicateStrings(rawAssets.stylesheets),
      scripts: this.deduplicateStrings(rawAssets.scripts),
      images: this.deduplicateStrings(rawAssets.images),
      fonts: this.deduplicateStrings(rawAssets.fonts),
    };

    const rawSettings = options.settings || { schema: [], data: {} };
    const settings: ThemeSettingsManifest = {
      schema: Array.isArray(rawSettings.schema) ? rawSettings.schema : [],
      data: rawSettings.data && typeof rawSettings.data === 'object' && !Array.isArray(rawSettings.data)
        ? { ...rawSettings.data }
        : {},
    };

    const rawFixtures = Array.isArray(options.fixtures) ? options.fixtures : [];
    const fixtures: ThemeFixtureManifest[] = rawFixtures.map((f, idx) => this.normalizeFixture(f, idx));

    const metadata: ThemeBundleMetadata = {
      version: options.metadata?.version || options.version || '1.0.0',
      generatedAt: options.metadata?.generatedAt || new Date().toISOString(),
      ...(options.metadata?.sourceStore || options.sourceStore
        ? { sourceStore: options.metadata?.sourceStore || options.sourceStore }
        : {}),
      targetThemeId: options.metadata?.targetThemeId ?? options.targetThemeId ?? 0,
      ...(options.metadata ? { ...options.metadata } : {}),
    };

    // Ensure core fields override any residual metadata spread anomalies
    metadata.version = options.metadata?.version || options.version || '1.0.0';
    metadata.generatedAt = options.metadata?.generatedAt || metadata.generatedAt || new Date().toISOString();
    metadata.targetThemeId = options.metadata?.targetThemeId ?? options.targetThemeId ?? 0;
    if (options.sourceStore || options.metadata?.sourceStore) {
      metadata.sourceStore = options.sourceStore || options.metadata?.sourceStore;
    }

    const bundle: ThemeBundleIR = {
      surfaces,
      globalAssets,
      settings,
      fixtures,
      metadata,
    };

    // Retain any additional properties passed in options (e.g. componentIRs, themeFiles)
    for (const [key, value] of Object.entries(options)) {
      if (!['surfaces', 'globalAssets', 'settings', 'fixtures', 'metadata', 'sourceStore', 'targetThemeId', 'version'].includes(key)) {
        bundle[key] = value;
      }
    }

    return bundle;
  }

  /**
   * Serializes and exports the ThemeBundleIR manifest to the target directory.
   * Returns the written manifest file path.
   */
  public async exportManifest(bundle: ThemeBundleIR, targetDir: string): Promise<string> {
    if (!bundle || typeof bundle !== 'object') {
      throw new Error('PageManifestEngine.exportManifest: bundle must be a valid ThemeBundleIR object');
    }
    if (!targetDir || typeof targetDir !== 'string') {
      throw new Error('PageManifestEngine.exportManifest: targetDir must be a non-empty string');
    }

    await fs.mkdir(targetDir, { recursive: true });
    const manifestPath = path.join(targetDir, MANIFEST_FILENAME);
    const jsonContent = JSON.stringify(bundle, null, 2);

    await fs.writeFile(manifestPath, jsonContent, 'utf-8');
    return manifestPath;
  }

  /**
   * Loads and parses a ThemeBundleIR manifest from a source directory or file path.
   */
  public async loadManifest(sourceDir: string): Promise<ThemeBundleIR> {
    if (!sourceDir || typeof sourceDir !== 'string') {
      throw new Error('PageManifestEngine.loadManifest: sourceDir must be a non-empty string');
    }

    let filePath = sourceDir;
    try {
      const stats = await fs.stat(sourceDir);
      if (stats.isDirectory()) {
        let foundPath: string | null = null;
        for (const candidateName of LEGACY_MANIFEST_FILENAMES) {
          const testPath = path.join(sourceDir, candidateName);
          try {
            const testStat = await fs.stat(testPath);
            if (testStat.isFile()) {
              foundPath = testPath;
              break;
            }
          } catch {
            // Check next candidate
          }
        }
        if (!foundPath) {
          throw new Error(
            `PageManifestEngine.loadManifest: No manifest file found in directory "${sourceDir}". Expected one of: ${LEGACY_MANIFEST_FILENAMES.join(', ')}`
          );
        }
        filePath = foundPath;
      }
    } catch (err: any) {
      if (err.code === 'ENOENT') {
        throw new Error(`PageManifestEngine.loadManifest: path does not exist: "${sourceDir}"`);
      }
      throw err;
    }

    const content = await fs.readFile(filePath, 'utf-8');
    let parsed: any;
    try {
      parsed = JSON.parse(content);
    } catch (parseErr: any) {
      throw new Error(`PageManifestEngine.loadManifest: Failed to parse JSON in "${filePath}": ${parseErr.message}`);
    }

    return this.buildBundleIR(parsed);
  }

  /**
   * Validates bundle integrity against Haravan OS 2.0 theme requirements.
   * Checks for surface completeness (at least home/index), structural integrity,
   * asset references, fixture tracking, and schema definitions.
   */
  public validateBundleIntegrity(
    bundle: ThemeBundleIR,
    options: BundleValidationOptions = {}
  ): BundleIntegrityValidationResult {
    const missingSurfaces: string[] = [];
    const errors: string[] = [];

    if (!bundle || typeof bundle !== 'object') {
      return {
        valid: false,
        missingSurfaces: ['home'],
        errors: ['Bundle must be a non-null ThemeBundleIR object'],
      };
    }

    // 1. Surfaces validation
    if (!Array.isArray(bundle.surfaces)) {
      errors.push('bundle.surfaces must be an array');
      missingSurfaces.push('home');
    } else if (bundle.surfaces.length === 0) {
      missingSurfaces.push('home');
      errors.push('Bundle contains zero page surfaces');
    } else {
      const seenSurfaceIds = new Set<string>();
      const presentTemplates = new Set<string>();
      const presentKinds = new Set<string>();

      for (let i = 0; i < bundle.surfaces.length; i++) {
        const surface = bundle.surfaces[i];
        const prefix = `Surface[${i}]`;

        if (!surface || typeof surface !== 'object') {
          errors.push(`${prefix}: surface entry must be an object`);
          continue;
        }

        // Check id
        if (!surface.id || typeof surface.id !== 'string' || surface.id.trim() === '') {
          errors.push(`${prefix}: missing or empty id`);
        } else {
          if (seenSurfaceIds.has(surface.id)) {
            errors.push(`Duplicate surface ID: "${surface.id}"`);
          }
          seenSurfaceIds.add(surface.id);
        }

        // Check name
        if (!surface.name || typeof surface.name !== 'string' || surface.name.trim() === '') {
          errors.push(`${prefix} (${surface.id || 'unknown'}): missing or empty name`);
        }

        // Check template
        if (!surface.template || typeof surface.template !== 'string' || surface.template.trim() === '') {
          errors.push(`${prefix} (${surface.id || 'unknown'}): missing or empty template`);
        } else {
          presentTemplates.add(surface.template.toLowerCase());
        }

        // Check route
        if (!surface.route || typeof surface.route !== 'object') {
          errors.push(`${prefix} (${surface.id || 'unknown'}): route must be an object`);
        } else {
          const routeObj = surface.route as Record<string, unknown>;
          const routeKind = routeObj.kind || routeObj.inferredKind;
          if (routeKind) {
            presentKinds.add(String(routeKind).toLowerCase());
          }
        }

        // Check sections
        if (!Array.isArray(surface.sections)) {
          errors.push(`${prefix} (${surface.id || 'unknown'}): sections must be an array`);
        }

        // Check viewports
        if (!Array.isArray(surface.viewports)) {
          errors.push(`${prefix} (${surface.id || 'unknown'}): viewports must be an array`);
        } else if (surface.viewports.length === 0) {
          errors.push(`${prefix} (${surface.id || 'unknown'}): must specify at least one viewport`);
        }

        // Check entities
        if (!Array.isArray(surface.entities)) {
          errors.push(`${prefix} (${surface.id || 'unknown'}): entities must be an array`);
        }
      }

      // Check required surfaces
      const requiredList = options.requiredSurfaces || ['home'];
      for (const req of requiredList) {
        const isPresent = this.isSurfacePresent(req, bundle.surfaces, presentTemplates, presentKinds);
        if (!isPresent) {
          missingSurfaces.push(req);
          errors.push(`Missing required surface: "${req}"`);
        }
      }
    }

    // 2. Global Assets validation
    if (!bundle.globalAssets || typeof bundle.globalAssets !== 'object') {
      errors.push('Missing or invalid globalAssets manifest');
    } else {
      const assetKeys: Array<keyof GlobalAssetsManifest> = ['stylesheets', 'scripts', 'images', 'fonts'];
      for (const key of assetKeys) {
        if (!Array.isArray(bundle.globalAssets[key])) {
          errors.push(`globalAssets.${key} must be an array`);
        } else {
          for (const item of bundle.globalAssets[key]) {
            if (typeof item !== 'string' || item.trim() === '') {
              errors.push(`globalAssets.${key} contains empty or non-string item`);
            } else if (item.includes('..') || item.includes('\0')) {
              errors.push(`globalAssets.${key} contains invalid path traversal: "${item}"`);
            }
          }
        }
      }
    }

    // 3. Settings validation
    if (!bundle.settings || typeof bundle.settings !== 'object') {
      errors.push('Missing or invalid settings manifest');
    } else {
      if (!Array.isArray(bundle.settings.schema)) {
        errors.push('settings.schema must be an array');
      }
      if (
        !bundle.settings.data ||
        typeof bundle.settings.data !== 'object' ||
        Array.isArray(bundle.settings.data)
      ) {
        errors.push('settings.data must be an object');
      }
    }

    // 4. Fixtures validation
    if (!Array.isArray(bundle.fixtures)) {
      errors.push('fixtures must be an array');
    } else {
      const seenFixtureIds = new Set<string>();
      for (let i = 0; i < bundle.fixtures.length; i++) {
        const fixture = bundle.fixtures[i];
        const prefix = `Fixture[${i}]`;

        if (!fixture || typeof fixture !== 'object') {
          errors.push(`${prefix}: fixture must be an object`);
          continue;
        }

        if (!fixture.id || typeof fixture.id !== 'string' || fixture.id.trim() === '') {
          errors.push(`${prefix}: missing or empty id`);
        } else {
          if (seenFixtureIds.has(fixture.id)) {
            errors.push(`Duplicate fixture ID: "${fixture.id}"`);
          }
          seenFixtureIds.add(fixture.id);
        }

        if (!fixture.type || typeof fixture.type !== 'string' || fixture.type.trim() === '') {
          errors.push(`${prefix} (${fixture.id || 'unknown'}): missing or empty type`);
        }

        if (!fixture.cleanupTag || typeof fixture.cleanupTag !== 'string' || fixture.cleanupTag.trim() === '') {
          errors.push(`${prefix} (${fixture.id || 'unknown'}): missing or empty cleanupTag`);
        }
      }
    }

    // 5. Metadata validation
    if (!bundle.metadata || typeof bundle.metadata !== 'object') {
      errors.push('Missing or invalid metadata');
    } else {
      if (!bundle.metadata.version || typeof bundle.metadata.version !== 'string') {
        errors.push('metadata.version must be a non-empty string');
      }
      if (!bundle.metadata.generatedAt || typeof bundle.metadata.generatedAt !== 'string') {
        errors.push('metadata.generatedAt must be a non-empty string');
      } else if (isNaN(Date.parse(bundle.metadata.generatedAt))) {
        errors.push(`metadata.generatedAt is not a valid ISO date string: "${bundle.metadata.generatedAt}"`);
      }
      if (bundle.metadata.targetThemeId === undefined || bundle.metadata.targetThemeId === null) {
        errors.push('metadata.targetThemeId must be defined');
      }
    }

    return {
      valid: missingSurfaces.length === 0 && errors.length === 0,
      missingSurfaces,
      errors,
    };
  }

  // ============================================================================
  // Static Helper Delegates
  // ============================================================================

  public static buildBundleIR(options?: BuildBundleIROptions): ThemeBundleIR {
    return new PageManifestEngine().buildBundleIR(options);
  }

  public static async exportManifest(bundle: ThemeBundleIR, targetDir: string): Promise<string> {
    return new PageManifestEngine().exportManifest(bundle, targetDir);
  }

  public static async loadManifest(sourceDir: string): Promise<ThemeBundleIR> {
    return new PageManifestEngine().loadManifest(sourceDir);
  }

  public static validateBundleIntegrity(
    bundle: ThemeBundleIR,
    options?: BundleValidationOptions
  ): BundleIntegrityValidationResult {
    return new PageManifestEngine().validateBundleIntegrity(bundle, options);
  }

  // ============================================================================
  // Internal Normalization Helpers
  // ============================================================================

  private normalizeSurface(surface: any, index: number): PageSurface {
    if (!surface || typeof surface !== 'object') {
      const template = 'index';
      return {
        id: `surface-${template}-${index}`,
        name: `Surface ${index + 1}`,
        route: { kind: 'home', pattern: '/', template: 'index', canonicalUrl: '/' },
        template,
        entities: [],
        sections: [],
        viewports: [...DEFAULT_VIEWPORTS],
      };
    }

    let route = surface.route;
    if (typeof route === 'string') {
      const refRoute = this.routeResolver.resolveReferenceUrl(route);
      route = this.routeResolver.mapToHaravanRoute(refRoute);
    }

    const rawTemplate = String(
      surface.template ||
      (typeof route === 'object' && route?.template) ||
      (typeof route === 'object' && route?.kind && route.kind !== 'home' ? route.kind : '') ||
      (surface.id && surface.id.includes('product') ? 'product' : '') ||
      (surface.id && surface.id.includes('collection') ? 'collection' : '') ||
      'index'
    ).trim();
    const template = rawTemplate.replace(/\.liquid$/i, '');
    const id = String(
      surface.id ||
      `surface-${template || 'page'}-${index}`
    ).trim();

    const name = String(
      surface.name ||
      (id ? id.replace(/[-_]/g, ' ') : `Surface ${index + 1}`)
    ).trim();

    if (!route || typeof route !== 'object') {
      const kind = template === 'index' ? 'home' : template;
      route = {
        kind,
        pattern: kind === 'home' ? '/' : `/${kind}`,
        template,
        canonicalUrl: kind === 'home' ? '/' : `/${kind}`,
      };
    }

    const entities = Array.isArray(surface.entities) ? [...surface.entities] : [];
    const sections = Array.isArray(surface.sections) ? [...surface.sections] : [];
    const viewports = Array.isArray(surface.viewports) && surface.viewports.length > 0
      ? [...surface.viewports]
      : [...DEFAULT_VIEWPORTS];

    return {
      id,
      name,
      route,
      template,
      entities,
      sections,
      viewports,
    };
  }

  private normalizeFixture(fixture: any, index: number): ThemeFixtureManifest {
    if (!fixture || typeof fixture !== 'object') {
      return {
        id: `fixture-${index}`,
        type: 'product',
        cleanupTag: `CANARY_FIXTURE_${index}`,
      };
    }

    const id = String(fixture.id || `fixture-${fixture.type || 'entity'}-${index}`).trim();
    const type = String(fixture.type || 'product').trim();
    const cleanupTag = String(fixture.cleanupTag || `CANARY_FIXTURE_${id}`).trim();

    return {
      ...fixture,
      id,
      type,
      cleanupTag,
    };
  }

  private deduplicateStrings(list?: any): string[] {
    if (!Array.isArray(list)) return [];
    const set = new Set<string>();
    for (const item of list) {
      if (typeof item === 'string') {
        const trimmed = item.trim();
        if (trimmed) {
          set.add(trimmed);
        }
      }
    }
    return Array.from(set);
  }

  private isSurfacePresent(
    required: string,
    surfaces: PageSurface[],
    templates: Set<string>,
    kinds: Set<string>
  ): boolean {
    const req = required.toLowerCase().trim();

    // Direct template match
    if (templates.has(req)) return true;
    if (kinds.has(req)) return true;

    // Semantic aliases
    if (req === 'home' || req === 'index') {
      return templates.has('index') || templates.has('home') || kinds.has('home') ||
        surfaces.some(s => s.id === 'home' || s.id === 'surface-home' || s.template === 'index' || s.template === 'home');
    }

    if (req === 'product' || req === 'product-standard') {
      return templates.has('product') || kinds.has('product') ||
        surfaces.some(s => s.template === 'product' || s.id.startsWith('product'));
    }

    if (req === 'collection' || req === 'collection-grid') {
      return templates.has('collection') || kinds.has('collection') ||
        surfaces.some(s => s.template === 'collection' || s.id.startsWith('collection'));
    }

    if (req === 'cart' || req === 'cart-active') {
      return templates.has('cart') || kinds.has('cart') ||
        surfaces.some(s => s.template === 'cart' || s.id.startsWith('cart'));
    }

    return surfaces.some(
      s => s.id.toLowerCase() === req ||
           s.name.toLowerCase() === req ||
           s.template.toLowerCase() === req
    );
  }
}
