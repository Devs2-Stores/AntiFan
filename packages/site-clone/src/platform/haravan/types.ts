/**
 * Shared Haravan Platform Interfaces (v1.0.0)
 * Derived from AntiFan - Deep Haravan Platform & Codebase Audit (§7 - §12, §47 - §50)
 */

export interface StoreContext {
  store: string;
  domain: string;
  organization?: string;
  theme?: string;
  themeId: number | string;
  environment: 'production' | 'staging' | 'development' | 'canary';
  adminOrigin: string;
}

export interface ThemeAsset {
  key: string;
  value?: string;
  attachment?: string;
  contentType?: string;
  size?: number;
  updatedAt?: string;
}

export interface ThemeTransactionPolicy {
  allowedFiles?: string[];
  forbiddenFiles?: string[];
  diffBudget?: {
    maxFilesChanged?: number;
    maxBytesDelta?: number;
  };
}

export interface ThemeTransaction {
  id: string;
  themeId: number | string;
  policy: ThemeTransactionPolicy;
  operations: Array<{
    type: 'create' | 'update' | 'delete';
    key: string;
    value?: string;
    previousValue?: string;
  }>;
  status: 'pending' | 'committed' | 'rolled_back';
  createdAt: string;
  committedAt?: string;
}

export interface HaravanRouteIdentity {
  kind: 'home' | 'product' | 'collection' | 'article' | 'blog' | 'page' | 'cart' | 'search' | '404' | 'custom';
  pattern: string;
  template: string;
  objectType: 'root' | 'product' | 'collection' | 'article' | 'blog' | 'page' | 'cart' | 'search' | null;
  handle?: string;
  canonicalUrl: string;
}

export interface ReferenceRouteIdentity {
  url: string;
  pathname: string;
  inferredKind: HaravanRouteIdentity['kind'];
  extractedHandle?: string;
}

export interface EntityMatchResult<T = any> {
  action: 'REUSE_EXISTING' | 'CREATE_MINIMAL_FIXTURE';
  matchedId?: number | string;
  entity?: T;
  fixtureCreated?: boolean;
  fixtureReceipt?: {
    fixtureId: string;
    key: string;
    cleanupTag: string;
    createdAt: string;
  };
}
