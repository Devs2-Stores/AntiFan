/**
 * Haravan Route Mapping & Route Identity Engine (Audit §10 - §11, P0.3)
 *
 * Resolves reference storefront URLs (Shopify, Sapo, WooCommerce, Custom) into
 * Haravan-compliant route identities, Liquid template targets, and expected runtime objects.
 */

import type { HaravanRouteIdentity, ReferenceRouteIdentity } from './types.js';

export interface RouteMatchResult {
  matches: boolean;
  reason?: string;
}

export class RouteResolver {
  /**
   * Resolves a reference URL into a structured ReferenceRouteIdentity.
   * Handles absolute URLs, relative paths, trailing slashes, pagination segments,
   * query parameters, hash fragments, and multi-platform aliases.
   */
  public resolveReferenceUrl(url: string): ReferenceRouteIdentity {
    if (!url || typeof url !== 'string' || url.trim() === '') {
      return {
        url: url ?? '',
        pathname: '/',
        inferredKind: 'home',
      };
    }

    const trimmedUrl = url.trim();
    const pathname = this.normalizePathname(trimmedUrl);

    // 1. Home route
    if (pathname === '/' || pathname === '') {
      return {
        url: trimmedUrl,
        pathname: '/',
        inferredKind: 'home',
      };
    }

    const segments = pathname.split('/').filter(Boolean);

    // 2. 404 route
    if (pathname === '/404') {
      return {
        url: trimmedUrl,
        pathname: '/404',
        inferredKind: '404',
      };
    }

    // 3. Cart route (/cart, /gio-hang)
    if (segments.length === 1 && (segments[0].toLowerCase() === 'cart' || segments[0].toLowerCase() === 'gio-hang')) {
      return {
        url: trimmedUrl,
        pathname,
        inferredKind: 'cart',
      };
    }

    // 4. Search route (/search, /tim-kiem)
    if (segments.length === 1 && (segments[0].toLowerCase() === 'search' || segments[0].toLowerCase() === 'tim-kiem')) {
      return {
        url: trimmedUrl,
        pathname,
        inferredKind: 'search',
      };
    }

    // Extract potential path pagination (e.g. /page/2) from tail segments
    const cleanSegments = [...segments];
    if (
      cleanSegments.length >= 2 &&
      cleanSegments[cleanSegments.length - 2].toLowerCase() === 'page' &&
      /^\d+$/.test(cleanSegments[cleanSegments.length - 1])
    ) {
      cleanSegments.splice(cleanSegments.length - 2, 2);
    }

    // If pagination stripping leaves empty segments (e.g. /page/2 on root), it's the home page
    if (cleanSegments.length === 0) {
      return {
        url: trimmedUrl,
        pathname,
        inferredKind: 'home',
      };
    }
    // 5. Product routes:
    // Case A: Nested collection-product URL (e.g. /collections/:collection/products/:handle)
    // Case B: Direct product URL (e.g. /products/:handle, /product/:handle, /san-pham/:handle)
    const productIdx = cleanSegments.findIndex(
      s => s.toLowerCase() === 'products' || s.toLowerCase() === 'product' || s.toLowerCase() === 'san-pham'
    );

    if (productIdx !== -1 && productIdx < cleanSegments.length - 1) {
      const handle = cleanSegments[productIdx + 1];
      return {
        url: trimmedUrl,
        pathname,
        inferredKind: 'product',
        extractedHandle: handle,
      };
    }

    const firstSegment = cleanSegments[0].toLowerCase();

    // 6. Collection routes (/collections/:handle, /collection/:handle, /danh-muc/:handle)
    if (firstSegment === 'collections' || firstSegment === 'collection' || firstSegment === 'danh-muc') {
      if (cleanSegments.length === 1) {
        return {
          url: trimmedUrl,
          pathname,
          inferredKind: 'collection',
          extractedHandle: 'all',
        };
      }

      // Handle nested collections (e.g. /collections/men/shoes) or single (e.g. /collections/shoes)
      const handle = cleanSegments.slice(1).join('/');
      return {
        url: trimmedUrl,
        pathname,
        inferredKind: 'collection',
        extractedHandle: handle,
      };
    }

    // 7. Blog & Article routes
    // Articles: /blogs/:blog/:article, /blogs/:blog/articles/:article, /bai-viet/:article
    // Blog listings: /blogs/:handle, /blog/:handle, /tin-tuc/:handle
    if (firstSegment === 'bai-viet' && cleanSegments.length > 1) {
      return {
        url: trimmedUrl,
        pathname,
        inferredKind: 'article',
        extractedHandle: cleanSegments.slice(1).join('/'),
      };
    }

    if (firstSegment === 'blogs' || firstSegment === 'blog' || firstSegment === 'tin-tuc') {
      if (cleanSegments.length === 1) {
        return {
          url: trimmedUrl,
          pathname,
          inferredKind: 'blog',
        };
      }

      if (cleanSegments.length === 2) {
        // Blog listing route (/blogs/news)
        return {
          url: trimmedUrl,
          pathname,
          inferredKind: 'blog',
          extractedHandle: cleanSegments[1],
        };
      }

      // Article route: /blogs/:blog/:article or /blogs/:blog/articles/:article
      const blogHandle = cleanSegments[1];
      let articleHandle: string;
      if (cleanSegments[2].toLowerCase() === 'articles' && cleanSegments.length > 3) {
        articleHandle = cleanSegments.slice(3).join('/');
      } else {
        articleHandle = cleanSegments.slice(2).join('/');
      }

      return {
        url: trimmedUrl,
        pathname,
        inferredKind: 'article',
        extractedHandle: `${blogHandle}/${articleHandle}`,
      };
    }

    // 8. Page routes (/pages/:handle, /page/:handle, /trang/:handle)
    if (firstSegment === 'pages' || firstSegment === 'page' || firstSegment === 'trang') {
      const handle = cleanSegments.length > 1 ? cleanSegments.slice(1).join('/') : undefined;
      return {
        url: trimmedUrl,
        pathname,
        inferredKind: 'page',
        ...(handle ? { extractedHandle: handle } : {}),
      };
    }

    // 9. Custom route fallback
    const customHandle = cleanSegments.join('/');
    return {
      url: trimmedUrl,
      pathname,
      inferredKind: 'custom',
      ...(customHandle ? { extractedHandle: customHandle } : {}),
    };
  }

  /**
   * Maps a ReferenceRouteIdentity to Haravan route template, pattern, canonical URL,
   * and expected Liquid data object type.
   */
  public mapToHaravanRoute(reference: ReferenceRouteIdentity): HaravanRouteIdentity {
    const kind = reference.inferredKind;
    const handle = reference.extractedHandle;

    switch (kind) {
      case 'home':
        return {
          kind: 'home',
          pattern: '/',
          template: 'index.liquid',
          objectType: 'root',
          canonicalUrl: '/',
        };

      case 'product':
        return {
          kind: 'product',
          pattern: '/products/:handle',
          template: 'product.liquid',
          objectType: 'product',
          ...(handle ? { handle } : {}),
          canonicalUrl: handle ? `/products/${handle}` : '/products',
        };

      case 'collection':
        return {
          kind: 'collection',
          pattern: '/collections/:handle',
          template: 'collection.liquid',
          objectType: 'collection',
          ...(handle ? { handle } : {}),
          canonicalUrl: handle ? `/collections/${handle}` : '/collections',
        };

      case 'article': {
        let blog = 'news';
        let article = '';
        if (handle) {
          if (handle.includes('/')) {
            const parts = handle.split('/');
            blog = parts[0];
            article = parts.slice(1).join('/');
          } else {
            article = handle;
          }
        }
        const canonicalUrl = handle
          ? (handle.includes('/') ? `/blogs/${handle}` : `/blogs/${blog}/${article}`)
          : '/blogs';

        return {
          kind: 'article',
          pattern: '/blogs/:blog/:article',
          template: 'article.liquid',
          objectType: 'article',
          ...(handle ? { handle } : {}),
          canonicalUrl,
        };
      }

      case 'blog':
        return {
          kind: 'blog',
          pattern: '/blogs/:handle',
          template: 'blog.liquid',
          objectType: 'blog',
          ...(handle ? { handle } : {}),
          canonicalUrl: handle ? `/blogs/${handle}` : '/blogs',
        };

      case 'page':
        return {
          kind: 'page',
          pattern: '/pages/:handle',
          template: 'page.liquid',
          objectType: 'page',
          ...(handle ? { handle } : {}),
          canonicalUrl: handle ? `/pages/${handle}` : '/pages',
        };

      case 'cart':
        return {
          kind: 'cart',
          pattern: '/cart',
          template: 'cart.liquid',
          objectType: 'cart',
          canonicalUrl: '/cart',
        };

      case 'search':
        return {
          kind: 'search',
          pattern: '/search',
          template: 'search.liquid',
          objectType: 'search',
          canonicalUrl: '/search',
        };

      case '404':
        return {
          kind: '404',
          pattern: '/404',
          template: '404.liquid',
          objectType: null,
          canonicalUrl: '/404',
        };

      case 'custom':
      default: {
        const canonicalUrl = reference.pathname || '/';
        return {
          kind: 'custom',
          pattern: canonicalUrl,
          template: 'page.liquid',
          objectType: null,
          ...(handle ? { handle } : {}),
          canonicalUrl,
        };
      }
    }
  }

  /**
   * Verifies that a reference URL and a Haravan target URL share the same semantic kind
   * and entity handle.
   */
  public verifyRouteMatch(refUrl: string, haravanUrl: string): RouteMatchResult {
    const ref = this.resolveReferenceUrl(refUrl);
    const haravan = this.resolveReferenceUrl(haravanUrl);

    if (ref.inferredKind !== haravan.inferredKind) {
      return {
        matches: false,
        reason: `Route kind mismatch: reference "${ref.inferredKind}" does not match haravan "${haravan.inferredKind}"`,
      };
    }

    if (ref.extractedHandle && !haravan.extractedHandle) {
      return {
        matches: false,
        reason: `Handle mismatch: reference has handle "${ref.extractedHandle}" but haravan has no handle`,
      };
    }

    if (!ref.extractedHandle && haravan.extractedHandle) {
      return {
        matches: false,
        reason: `Handle mismatch: reference has no handle but haravan has handle "${haravan.extractedHandle}"`,
      };
    }

    if (ref.extractedHandle && haravan.extractedHandle) {
      const refHandle = ref.extractedHandle.toLowerCase();
      const haravanHandle = haravan.extractedHandle.toLowerCase();

      // 1. Direct equality
      if (refHandle === haravanHandle) {
        return { matches: true };
      }

      // 2. Leaf slug match for nested handles (e.g. "men/shoes" vs "shoes", or "news/launch" vs "launch")
      const refLeaf = refHandle.includes('/') ? refHandle.split('/').pop() : refHandle;
      const haravanLeaf = haravanHandle.includes('/') ? haravanHandle.split('/').pop() : haravanHandle;

      if (refLeaf && haravanLeaf && refLeaf === haravanLeaf) {
        return { matches: true };
      }

      // 3. Suffix / prefix hierarchical containment
      if (refHandle.endsWith(`/${haravanHandle}`) || haravanHandle.endsWith(`/${refHandle}`)) {
        return { matches: true };
      }

      return {
        matches: false,
        reason: `Handle mismatch: reference handle "${ref.extractedHandle}" does not match haravan handle "${haravan.extractedHandle}"`,
      };
    }

    return { matches: true };
  }

  /**
   * Normalizes an arbitrary URL/path string to a clean, lowercase-safe, unencoded pathname.
   */
  private normalizePathname(url: string): string {
    let rawPathname = '';

    try {
      let toParse = url;
      if (toParse.startsWith('//')) {
        toParse = `https:${toParse}`;
      } else if (!toParse.startsWith('http://') && !toParse.startsWith('https://')) {
        toParse = toParse.startsWith('/') ? `http://localhost${toParse}` : `http://localhost/${toParse}`;
      }
      const parsed = new URL(toParse);
      rawPathname = parsed.pathname;
    } catch {
      // Fallback: strip query, hash, protocol
      const withoutProto = url.replace(/^[a-zA-Z]+:\/\/[^/]+/, '');
      const clean = withoutProto.split('?')[0].split('#')[0];
      rawPathname = clean.startsWith('/') ? clean : `/${clean}`;
    }

    // Safely decode percent-encoding
    try {
      rawPathname = decodeURI(rawPathname);
    } catch {
      // If URI malformed, proceed with raw string
    }

    // Collapse multiple slashes
    rawPathname = rawPathname.replace(/\/+/g, '/');

    // Strip .html or .htm suffix
    rawPathname = rawPathname.replace(/\.html?$/i, '');

    // Strip trailing slash unless it's root
    if (rawPathname.length > 1 && rawPathname.endsWith('/')) {
      rawPathname = rawPathname.replace(/\/+$/, '');
    }

    return rawPathname || '/';
  }
}
