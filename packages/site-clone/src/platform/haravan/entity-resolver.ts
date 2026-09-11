/**
 * Entity Resolver with EXISTING_DATA_FIRST Policy (v1.0.0)
 * Derived from AntiFan - Deep Haravan Platform & Codebase Audit (§12, §49 - §50, P0.4)
 *
 * Implements:
 * 1. Policy: EXISTING_DATA_FIRST (§12)
 *    - Step 1: Query inventory by exact handle. If matched, return action: 'REUSE_EXISTING', matchedId, entity.
 *    - Step 2: Query inventory by normalized title or tags. If matched, return action: 'REUSE_EXISTING'.
 *    - Step 3: If no match, generate minimal traceable fixture:
 *              action: 'CREATE_MINIMAL_FIXTURE'
 *              fixtureReceipt: { fixtureId, key, cleanupTag: 'antifan-canary-fixture', createdAt }
 *              with minimal valid fields required by Haravan schema.
 * 2. FixtureRegistry:
 *    - registerFixture(receipt: unknown): void
 *    - listFixtures(tag?: string): FixtureRecord[]
 *    - generateCleanupPlan(): Array<{ action: 'delete'; type: string; id: string | number }>
 */

import { EntityMatchResult } from './types.js';

export type EntityType = 'product' | 'collection' | 'article' | 'page';

export interface EntityRequirement {
  type: EntityType;
  handle?: string;
  title?: string;
  tags?: string[];
}

export interface FixtureReceipt {
  fixtureId: string;
  key: string;
  cleanupTag: string;
  createdAt: string;
}

export interface FixtureRecord extends FixtureReceipt {
  type: EntityType | string;
  id: string | number;
  entity?: unknown;
}

export interface CleanupAction {
  action: 'delete';
  type: string;
  id: string | number;
}

export interface HaravanProductVariant {
  id: number;
  product_id: number;
  title: string;
  price: string | number;
  sku: string;
  position: number;
  inventory_policy: string;
  compare_at_price: string | number;
  fulfillment_service: string;
  inventory_management: string | null;
  inventory_quantity: number;
  requires_shipping: boolean;
  taxable: boolean;
  barcode: string;
  grams: number;
  weight: number;
  weight_unit: string;
}

export interface HaravanProductFixture {
  id: number;
  title: string;
  handle: string;
  body_html: string;
  vendor: string;
  product_type: string;
  created_at: string;
  updated_at: string;
  published_at: string;
  published_scope: string;
  tags: string;
  status: string;
  variants: HaravanProductVariant[];
  options: Array<{
    id: number;
    product_id: number;
    name: string;
    position: number;
    values: string[];
  }>;
  images: Array<Record<string, unknown>>;
  image: Record<string, unknown> | null;
}

export interface HaravanCollectionFixture {
  id: number;
  title: string;
  handle: string;
  body_html: string;
  published_at: string;
  updated_at: string;
  sort_order: string;
  template_suffix: string;
  products_count: number;
  disjunctive: boolean;
  rules: Array<Record<string, unknown>>;
  image: Record<string, unknown> | null;
}

export interface HaravanArticleFixture {
  id: number;
  blog_id: number;
  title: string;
  handle: string;
  author: string;
  body_html: string;
  summary_html: string;
  tags: string;
  published_at: string;
  created_at: string;
  updated_at: string;
  image: Record<string, unknown> | null;
  user_id: number;
}

export interface HaravanPageFixture {
  id: number;
  title: string;
  handle: string;
  author: string;
  body_html: string;
  published_at: string;
  created_at: string;
  updated_at: string;
  template_suffix: string;
}

export type HaravanEntityFixture =
  | HaravanProductFixture
  | HaravanCollectionFixture
  | HaravanArticleFixture
  | HaravanPageFixture;

export interface EntityCandidateRecord {
  id?: string | number;
  handle?: string;
  slug?: string;
  title?: string;
  type?: string;
  url?: string;
  tags?: string[] | string;
  [key: string]: unknown;
}

// ============================================================================
// Normalization & String Helpers (§49, P0.4)
// ============================================================================

/**
 * Normalizes text for robust comparison, including Vietnamese diacritics removal,
 * case folding, and whitespace collapsing.
 */
export function normalizeText(str: string): string {
  if (!str || typeof str !== 'string') return '';
  return str
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[đĐ]/g, (m) => (m === 'đ' ? 'd' : 'D'))
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Normalizes an entity handle by removing protocols, query strings, leading/trailing slashes,
 * and canonical route prefixes (e.g. /products/abc -> abc).
 */
export function normalizeHandle(handle: string): string {
  if (!handle || typeof handle !== 'string') return '';
  return handle
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\/[^/]+/i, '')
    .replace(/[?#].*$/, '')
    .replace(/^\/+|\/+$/g, '')
    .replace(/^(products|collections|blogs\/[^/]+|articles|pages)\//i, '')
    .trim();
}

/**
 * Converts arbitrary text to a valid URL-friendly slug.
 */
export function slugify(text?: string): string {
  if (!text) return '';
  const normalized = normalizeText(text);
  return normalized
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
}

/**
 * Converts a slug into a human-readable title.
 */
export function titleize(slug?: string): string {
  if (!slug) return '';
  return slug
    .split(/[-_]/)
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
    .join(' ');
}

// ============================================================================
// Fixture Registry (§50)
// ============================================================================

/**
 * Central registry for tracking and generating cleanup plans for canary fixtures.
 */
export class FixtureRegistry {
  private fixtures: Map<string, FixtureRecord> = new Map();

  /**
   * Registers a fixture receipt or match result.
   * Tolerates receipts wrapped inside EntityMatchResult or raw receipt objects.
   */
  public registerFixture(receipt: unknown): void {
    if (!receipt || typeof receipt !== 'object') return;

    const receiptObj = receipt as Record<string, unknown>;
    const target = (
      receiptObj.fixtureReceipt && typeof receiptObj.fixtureReceipt === 'object'
        ? receiptObj.fixtureReceipt
        : receiptObj
    ) as Record<string, unknown>;

    const fixtureId =
      typeof target.fixtureId === 'string'
        ? target.fixtureId
        : String(target.id ?? target.matchedId ?? `canary-${Date.now()}`);

    const key = typeof target.key === 'string' ? target.key : (typeof receiptObj.key === 'string' ? receiptObj.key : '');
    const cleanupTag =
      typeof target.cleanupTag === 'string'
        ? target.cleanupTag
        : (typeof receiptObj.cleanupTag === 'string' ? receiptObj.cleanupTag : 'antifan-canary-fixture');

    const createdAt =
      typeof target.createdAt === 'string'
        ? target.createdAt
        : (typeof receiptObj.createdAt === 'string' ? receiptObj.createdAt : new Date().toISOString());

    // Determine entity type
    let type = typeof target.type === 'string' ? target.type : (typeof receiptObj.type === 'string' ? receiptObj.type : '');
    if (!type && key) {
      const parts = key.split(/[/:]/);
      if (parts[0]) type = parts[0];
    }
    if (!type && receiptObj.entity && typeof receiptObj.entity === 'object') {
      const entityObj = receiptObj.entity as Record<string, unknown>;
      if (typeof entityObj.type === 'string') {
        type = entityObj.type;
      }
    }
    type = type || 'product';

    // Determine entity id
    const candidateId = target.id ?? receiptObj.id ?? receiptObj.matchedId ?? target.fixtureId;
    const id = (typeof candidateId === 'number' || typeof candidateId === 'string') ? candidateId : fixtureId;

    this.fixtures.set(fixtureId, {
      fixtureId,
      key,
      cleanupTag,
      createdAt,
      type,
      id,
      entity: receiptObj.entity
    });
  }

  /**
   * Lists registered fixtures, optionally filtered by a specific cleanup tag.
   */
  public listFixtures(tag?: string): FixtureRecord[] {
    const list = Array.from(this.fixtures.values());
    if (tag) {
      return list.filter((f) => f.cleanupTag === tag);
    }
    return list;
  }

  /**
   * Generates a declarative cleanup plan to delete all canary fixtures from Haravan.
   */
  public generateCleanupPlan(tag?: string): CleanupAction[] {
    const targetFixtures = tag ? this.listFixtures(tag) : Array.from(this.fixtures.values());
    return targetFixtures.map((f) => ({
      action: 'delete' as const,
      type: f.type,
      id: f.id
    }));
  }

  /**
   * Clears the fixture registry.
   */
  public clear(): void {
    this.fixtures.clear();
  }

  /**
   * Returns current count of registered fixtures.
   */
  public get size(): number {
    return this.fixtures.size;
  }
}

// ============================================================================
// Entity Resolver (§12, §49 - §50, P0.4)
// ============================================================================

export class EntityResolver {
  private registry?: FixtureRegistry;
  private fixtureIdCounter: number = 990000000;

  constructor(registry?: FixtureRegistry) {
    this.registry = registry;
  }

  /**
   * Resolves a target entity against Haravan inventory using EXISTING_DATA_FIRST policy.
   *
   * Step 1: Query inventory by exact handle. If matched, returns REUSE_EXISTING.
   * Step 2: Query inventory by normalized title or tags. If matched, returns REUSE_EXISTING.
   * Step 3: If no match, generates minimal traceable fixture with CREATE_MINIMAL_FIXTURE.
   */
  public async resolveEntity<T = unknown>(
    requirement: {
      type: EntityType;
      handle?: string;
      title?: string;
      tags?: string[];
    },
    inventory: unknown
  ): Promise<EntityMatchResult<T>> {
    const candidates = this.extractCandidates(inventory, requirement.type);

    // ========================================================================
    // Step 1: Query inventory by exact handle (§12)
    // ========================================================================
    if (requirement.handle) {
      const targetHandle = normalizeHandle(requirement.handle);
      for (const candidate of candidates) {
        if (this.matchCandidateHandle(candidate, targetHandle)) {
          return {
            action: 'REUSE_EXISTING',
            matchedId: candidate.id ?? candidate.handle,
            // Cast through unknown to preserve generic return contract
            entity: candidate as unknown as T
          };
        }
      }
    }

    // ========================================================================
    // Step 2: Query inventory by normalized title or tags (§12, §49)
    // ========================================================================
    const MIN_REUSE_THRESHOLD = 30;
    const scoredCandidates: Array<{ candidate: EntityCandidateRecord; score: number }> = [];
    for (const candidate of candidates) {
      const score = this.calculateMatchScore(candidate, requirement.title, requirement.tags);
      if (score >= MIN_REUSE_THRESHOLD) {
        scoredCandidates.push({ candidate, score });
      }
    }

    if (scoredCandidates.length > 0) {
      // Pick best match by highest score
      scoredCandidates.sort((a, b) => b.score - a.score);
      const best = scoredCandidates[0].candidate;
      return {
        action: 'REUSE_EXISTING',
        matchedId: best.id ?? best.handle,
        // Cast through unknown to preserve generic return contract
        entity: best as unknown as T
      };
    }

    // ========================================================================
    // Step 3: Generate minimal traceable fixture (§12, §50, P0.4)
    // ========================================================================
    const now = new Date();
    const createdAt = now.toISOString();
    const fixtureId = `canary-${requirement.type}-${Date.now()}-${Math.floor(Math.random() * 100000)}`;

    const entity = this.generateMinimalFixture(requirement, createdAt);
    const key = `${requirement.type}/${entity.handle || requirement.handle || fixtureId}`;

    const fixtureReceipt: FixtureReceipt = {
      fixtureId,
      key,
      cleanupTag: 'antifan-canary-fixture',
      createdAt
    };

    // Auto-register with central registry if provided
    if (this.registry) {
      this.registry.registerFixture({
        ...fixtureReceipt,
        type: requirement.type,
        id: entity.id,
        entity
      });
    }

    return {
      action: 'CREATE_MINIMAL_FIXTURE',
      matchedId: entity.id,
      // Cast through unknown to preserve generic return contract
      entity: entity as unknown as T,
      fixtureCreated: true,
      fixtureReceipt
    };
  }

  // ==========================================================================
  // Internal Candidate Extraction & Matching
  // ==========================================================================

  private extractCandidates(inventory: unknown, type: EntityType): EntityCandidateRecord[] {
    if (!inventory) return [];

    // Array of candidates directly
    if (Array.isArray(inventory)) {
      return inventory
        .filter((item): item is EntityCandidateRecord => Boolean(item && typeof item === 'object'))
        .filter((item) => this.isCandidateCompatible(item, type));
    }

    // Set or Map
    if (inventory instanceof Map || inventory instanceof Set) {
      return this.extractCandidates(Array.from(inventory.values()), type);
    }

    // Object containing arrays (e.g. { products: [...], collections: [...] })
    if (typeof inventory === 'object') {
      const invObj = inventory as Record<string, unknown>;
      const typeKeyMapping: Record<EntityType, string[]> = {
        product: ['products', 'product', 'items', 'data'],
        collection: ['collections', 'collection', 'categories', 'category', 'items', 'data'],
        article: ['articles', 'article', 'blogs', 'blog', 'posts', 'post', 'items', 'data'],
        page: ['pages', 'page', 'items', 'data']
      };

      const candidateKeys = typeKeyMapping[type] || ['items', 'data'];
      for (const key of candidateKeys) {
        const potentialList = invObj[key];
        if (Array.isArray(potentialList)) {
          return potentialList
            .filter((item): item is EntityCandidateRecord => Boolean(item && typeof item === 'object'))
            .filter((item) => this.isCandidateCompatible(item, type));
        }
      }

      // If object values are entities
      const values = Object.values(invObj);
      if (values.length > 0 && typeof values[0] === 'object' && values[0] !== null) {
        return this.extractCandidates(values, type);
      }
    }

    return [];
  }

  private isCandidateCompatible(item: EntityCandidateRecord, type: EntityType): boolean {
    if (!item || typeof item !== 'object') return false;
    if (item.type && typeof item.type === 'string') {
      const itemType = item.type.toLowerCase();
      if (itemType !== type.toLowerCase()) {
        return false;
      }
    }
    return true;
  }

  private matchCandidateHandle(candidate: EntityCandidateRecord, targetHandle: string): boolean {
    if (!candidate || !targetHandle) return false;

    // Handle property
    if (candidate.handle && normalizeHandle(String(candidate.handle)) === targetHandle) {
      return true;
    }

    // Slug property
    if (candidate.slug && normalizeHandle(String(candidate.slug)) === targetHandle) {
      return true;
    }

    // URL path property (e.g. /products/ao-thun-nam)
    if (candidate.url && typeof candidate.url === 'string') {
      if (normalizeHandle(candidate.url) === targetHandle) {
        return true;
      }
    }

    return false;
  }

  private calculateMatchScore(candidate: EntityCandidateRecord, reqTitle?: string, reqTags?: string[]): number {
    let score = 0;

    // Title matching
    if (reqTitle && candidate.title && typeof candidate.title === 'string') {
      const normReq = normalizeText(reqTitle);
      const normCand = normalizeText(candidate.title);

      if (normReq && normCand) {
        if (normReq === normCand) {
          score += 100; // Exact normalized title match
        } else if (normCand.includes(normReq) || normReq.includes(normCand)) {
          score += 60; // Substring inclusion match
        } else {
          // Token overlap matching
          const reqTokens = normReq.split(' ').filter((t) => t.length > 1);
          const candTokens = new Set(normCand.split(' ').filter((t) => t.length > 1));
          let matched = 0;
          for (const token of reqTokens) {
            if (candTokens.has(token)) {
              matched++;
            }
          }
          if (reqTokens.length > 0 && matched > 0) {
            score += Math.round((matched / reqTokens.length) * 40);
          }
        }
      }
    }

    // Tag matching
    if (reqTags && reqTags.length > 0) {
      const candTags = this.extractCandidateTags(candidate);
      let matchedTags = 0;
      for (const tag of reqTags) {
        const normTag = normalizeText(tag);
        if (candTags.has(normTag)) {
          matchedTags++;
        }
      }
      if (matchedTags > 0) {
        score += Math.min(60, matchedTags * 25);
      }
    }

    return score;
  }

  private extractCandidateTags(candidate: EntityCandidateRecord): Set<string> {
    const result = new Set<string>();
    if (!candidate || !candidate.tags) return result;

    if (Array.isArray(candidate.tags)) {
      for (const t of candidate.tags) {
        const norm = normalizeText(String(t));
        if (norm) result.add(norm);
      }
    } else if (typeof candidate.tags === 'string') {
      const parts = candidate.tags.split(/[,;]/);
      for (const p of parts) {
        const norm = normalizeText(p);
        if (norm) result.add(norm);
      }
    }

    return result;
  }

  // ==========================================================================
  // Minimal Haravan Fixture Generation (§50, P0.4)
  // ==========================================================================

  private generateMinimalFixture(
    requirement: { type: EntityType; handle?: string; title?: string; tags?: string[] },
    createdAt: string
  ): HaravanEntityFixture {
    const nextId = ++this.fixtureIdCounter;
    const handle = requirement.handle || slugify(requirement.title) || `canary-${requirement.type}-${nextId}`;
    const title = requirement.title || titleize(handle);
    const tagString = requirement.tags && requirement.tags.length > 0
      ? requirement.tags.join(', ')
      : 'antifan-canary-fixture';

    switch (requirement.type) {
      case 'product': {
        const productFixture: HaravanProductFixture = {
          id: nextId,
          title,
          handle,
          body_html: `<p>Minimal Haravan product fixture for AntiFan verification.</p>`,
          vendor: 'AntiFan',
          product_type: 'Canary Fixture',
          created_at: createdAt,
          updated_at: createdAt,
          published_at: createdAt,
          published_scope: 'global',
          tags: tagString,
          status: 'active',
          variants: [
            {
              id: nextId + 1,
              product_id: nextId,
              title: 'Default Title',
              price: '100000',
              sku: `CANARY-${nextId}`,
              position: 1,
              inventory_policy: 'deny',
              compare_at_price: '0',
              fulfillment_service: 'manual',
              inventory_management: null,
              inventory_quantity: 100,
              requires_shipping: true,
              taxable: false,
              barcode: '',
              grams: 200,
              weight: 0.2,
              weight_unit: 'kg'
            }
          ],
          options: [
            {
              id: nextId + 2,
              product_id: nextId,
              name: 'Title',
              position: 1,
              values: ['Default Title']
            }
          ],
          images: [],
          image: null
        };
        return productFixture;
      }

      case 'collection': {
        const collectionFixture: HaravanCollectionFixture = {
          id: nextId,
          title,
          handle,
          body_html: `<p>Minimal Haravan collection fixture for AntiFan verification.</p>`,
          published_at: createdAt,
          updated_at: createdAt,
          sort_order: 'best-selling',
          template_suffix: '',
          products_count: 0,
          disjunctive: false,
          rules: [],
          image: null
        };
        return collectionFixture;
      }

      case 'article': {
        const articleFixture: HaravanArticleFixture = {
          id: nextId,
          blog_id: 1,
          title,
          handle,
          author: 'AntiFan Canary',
          body_html: `<p>Minimal Haravan article fixture for AntiFan verification.</p>`,
          summary_html: `<p>Canary article summary.</p>`,
          tags: tagString,
          published_at: createdAt,
          created_at: createdAt,
          updated_at: createdAt,
          image: null,
          user_id: 1
        };
        return articleFixture;
      }

      case 'page': {
        const pageFixture: HaravanPageFixture = {
          id: nextId,
          title,
          handle,
          author: 'AntiFan Canary',
          body_html: `<p>Minimal Haravan page fixture for AntiFan verification.</p>`,
          published_at: createdAt,
          created_at: createdAt,
          updated_at: createdAt,
          template_suffix: ''
        };
        return pageFixture;
      }
    }
  }
}
