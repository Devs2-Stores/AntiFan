/**
 * Generator: Independent HTML Clone Generator
 * Stitches authentic live rawHtml sections into a standalone, offline-renderable HTML bundle
 * with localized assets, full source cardinality by default, and zero remote hotlinks.
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
  entryFilename?: string;
  device?: 'web' | 'mobile';
  customParityCss?: string;
  customInteractivityJs?: string;
}

export interface IndependentHtmlCloneResult {
  success: boolean;
  entryHtmlPath: string;
  filesWritten: string[];
  productCount: number;
  articleCount: number;
}

/**
 * Removes markup from a captured section that must not survive into a
 * self-contained bundle:
 *  - live video/embed references bound to remote hosts (Alpine/Vue loaded lazily),
 *  - <noscript> fallbacks, which a scripting-enabled document never renders but
 *    which point at live third-party services (measured: the reCAPTCHA no-JS
 *    iframe) that cannot be localized.
 *  - unswapped lazy-load placeholders: captures taken before the site's
 *    lazy-load script ran leave `src` as a transparent `data:` URI and keep the
 *    real target in `data-src`/`data-srcset`. A static bundle has no swap step,
 *    so the placeholder is promoted onto the rendered attribute.
 */
/**
 * Decodes HTML entities safely. Decodes quotes and angle brackets first,
 * and &amp; last so entities like &amp;quot; are not double-decoded prematurely.
 */
export function decodeHtmlEntities(str: string): string {
  return str
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&#039;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

/**
 * Extracts embedded executable scripts from wire:effects attributes (e.g. dynamic
 * slick slider re-initialization, scroll listeners) into pure inline JS expressions.
 * Wraps slick initialization calls with an unslick check so that if a synchronous
 * bundle already ran on $(document).ready, the reference-derived config applies cleanly.
 */
export function extractEmbeddedEffects(html: string): string[] {
  const scripts: string[] = [];
  const regex = /wire:effects="([^"]*)"/g;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(html)) !== null) {
    const rawVal = match[1];
    const decoded = decodeHtmlEntities(rawVal);
    try {
      const parsed = JSON.parse(decoded);
      if (Array.isArray(parsed.xjs)) {
        for (const item of parsed.xjs) {
          if (item && typeof item.expression === 'string' && item.expression.trim()) {
            let expr = item.expression.trim();
            // Wrap .slick({ calls so an already-initialized slider is cleanly unslicked first
            expr = expr.replace(
              /\$\((["'][^"']+["'])\)\.slick\(\{/g,
              '(($($1).hasClass("slick-initialized") ? $($1).slick("unslick") : null), $($1)).slick({'
            );
            scripts.push(expr);
          }
        }
      }
    } catch {
      // Ignore unparseable wire:effects
    }
  }
  return scripts;
}

export function sanitizeSectionMarkup(html: string): string {
  // 1. Synthesize declarative toggle bindings BEFORE stripping reactive framework attributes
  let processed = html
    .replace(/(<[a-z0-9_\-]+(?:\s+[^>]*)?)\s+(?:@click|x-on:click)\s*=\s*(?:"\s*([a-zA-Z0-9_$]+)\s*=\s*!\s*\2\s*"|'\s*([a-zA-Z0-9_$]+)\s*=\s*!\s*\3\s*')/gi, (match, openTag, p1, p2) => {
      const prop = p1 || p2;
      return `${openTag} data-antifan-toggle="${prop}"`;
    })
    .replace(/(<[a-z0-9_\-]+(?:\s+[^>]*)?)\s+x-show\s*=\s*(?:"\s*([a-zA-Z0-9_$]+)\s*"|'\s*([a-zA-Z0-9_$]+)\s*')/gi, (match, openTag, p1, p2) => {
      const prop = p1 || p2;
      return `${openTag} data-antifan-target="${prop}"`;
    })
    .replace(/(<[a-z0-9_\-]+(?:\s+[^>]*)?)\s+(?:@click\.outside|x-on:click\.outside)\s*=\s*(?:"\s*([a-zA-Z0-9_$]+)\s*=\s*false\s*"|'\s*([a-zA-Z0-9_$]+)\s*=\s*false\s*')/gi, (match, openTag, p1, p2) => {
      const prop = p1 || p2;
      return `${openTag} data-antifan-outside="${prop}"`;
    });

  // 2. Reset transient in-flight slider/carousel transforms to neutral origin
  processed = processed.replace(/(\sstyle\s*=\s*["'][^"']*?)transform\s*:\s*translateX\(-?[0-9]+(?:\.[0-9]+)?px\)\s*;?/gi, '$1transform: translateX(0px);');

  return processed
    .replace(/(?::|x-bind:|v-bind:)?(?:src|data-src)\s*=\s*(?:"[^"]*(?:https?:\/\/(?:www\.)?(?:youtube\.com|youtu\.be)[^"']*)["']|'[^']*(?:https?:\/\/(?:www\.)?(?:youtube\.com|youtu\.be)[^"']*)['"])/gi, (match) => {
      const urlMatch = match.match(/(https?:\/\/(?:www\.)?(?:youtube\.com|youtu\.be)\/[^"'\s)]+)/i);
      const cleanUrl = urlMatch ? urlMatch[1] : '';
      return cleanUrl ? `data-src="${cleanUrl}" src=""` : 'src=""';
    })
    .replace(/(?::|x-bind:|v-bind:)(src|data-src)\s*=\s*(?:"[^"]*(?:https?:)?\/\/[^"]*"|'[^']*(?:https?:)?\/\/[^']*')/gi, '')
    .replace(/<noscript\b[^>]*>[\s\S]*?<\/noscript>/gi, '')
    .replace(/<!--\[if (?:END)?BLOCK\]>[\s\S]*?<!\[endif\]-->/gi, '')
    .replace(/\s+wire:[a-zA-Z0-9_\-\.]+(?:=(?:"[^"]*"|'[^']*'|[^\s>]+))?/gi, '')
    .replace(/\s+(?:x-(?:data|bind|on|show|model|transition|ref|init|cloak|html|text|teleport|for|if|effect|ignore)(?::[a-zA-Z0-9_\-\.]+)?|@[a-zA-Z0-9_\-\.:]+)(?:=(?:"[^"]*"|'[^']*'|[^\s>]+))?/gi, '')
    .replace(/\s+:class=(?:"[^"]*"|'[^']*'|[^\s>]+)/gi, '')
    .replace(/\s+data-(?:update-uri|navigate-once)(?:=(?:"[^"]*"|'[^']*'|[^\s>]+))?/gi, '')
    .replace(/<script\b[^>]*src="[^"]*(?:livewire|googletagmanager|google-analytics|analytics\.js|gtag|clarity|tawk\.to|connect\.facebook\.net)[^"]*"[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<script\b[^>]*>(?:[\s\S]*?(?:gtag\(|dataLayer\.push|fbq\(|clarity\(|Tawk_API)[\s\S]*?)<\/script>/gi, '')
    .replace(/<iframe\b[^>]*(?:googletagmanager|facebook\.com\/plugins|tawk\.to)[^>]*>[\s\S]*?<\/iframe>/gi, '')
    .replace(/<img\b[^>]*>/gi, (tag) => promoteLazyLoadTarget(tag));
}

/**
 * Rewrites absolute references that point back at the captured origin so a standalone
 * bundle never navigates to, or hotlinks, the live site. Third-party URLs and
 * already-relative paths are left untouched.
 */
export function localizeSameOriginReferences(html: string, sourceBaseUrl: string | undefined): string {
  if (!sourceBaseUrl) return html;

  let parsed: URL;
  try {
    parsed = new URL(sourceBaseUrl);
  } catch {
    return html;
  }

  const host = parsed.hostname.toLowerCase();
  const apexHost = host.replace(/^www\./, '');
  const hostPattern = `(?:www\\.)?${apexHost.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`;
  const originPattern = `(?:https?:)?//${hostPattern}(?::\\d+)?`;

  const attributePattern = new RegExp(
    `(\\s(?:href|src|action|poster|data-src|data-bg|data-href|title|aria-label)\\s*=\\s*)(["'])\\s*${originPattern}(/[^"']*)?\\2`,
    'gi'
  );
  const srcsetPattern = new RegExp(`(\\ssrcset\\s*=\\s*)(["'])([^"']*)\\2`, 'gi');
  const srcsetOriginPattern = new RegExp(`^(?:https?:)?//${hostPattern}(?::\\d+)?(/[^\\s]*)?`, 'i');

  return html
    .replace(attributePattern, (_match, attribute: string, quote: string, rest?: string) => {
      return `${attribute}${quote}${rest || '/'}${quote}`;
    })
    .replace(srcsetPattern, (match, attribute: string, quote: string, value: string) => {
      if (!new RegExp(hostPattern, 'i').test(value)) return match;
      const normalized = value
        .split(',')
        .map((entry) => entry.trim().replace(srcsetOriginPattern, (_all, rest?: string) => rest || '/'))
        .join(', ');
      return `${attribute}${quote}${normalized}${quote}`;
    });
}

/**
 * Copies a deferred lazy-load target onto the attribute the browser renders.
 * Only a data: URI (or absent) placeholder is replaced, so an image that already
 * carries its real source is never rewritten.
 */
function promoteLazyLoadTarget(tag: string): string {
  let out = tag.replace(/\sloading\s*=\s*(?:"lazy"|'lazy'|lazy)/gi, ' loading="eager"');
  const attrValue = (name: string): string | null => {
    const match = out.match(new RegExp(`\\s${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`, 'i'));
    if (!match) return null;
    return match[1] !== undefined ? match[1] : match[2];
  };
  const isPlaceholder = (value: string | null): boolean =>
    value === null || value.trim() === '' || /^data:/i.test(value.trim());

  const deferredSrc = attrValue('data-src') || attrValue('data-lazy-src') || attrValue('data-lazy');
  if (deferredSrc && isPlaceholder(attrValue('src'))) {
    out = attrValue('src') === null
      ? out.replace(/<img/i, `<img src="${deferredSrc}"`)
      : out.replace(/(\ssrc\s*=\s*)(?:"[^"]*"|'[^']*')/i, `$1"${deferredSrc}"`);
  }
  const deferredSrcset = attrValue('data-srcset');
  if (deferredSrcset && isPlaceholder(attrValue('srcset'))) {
    out = attrValue('srcset') === null
      ? out.replace(/<img/i, `<img srcset="${deferredSrcset}"`)
      : out.replace(/(\ssrcset\s*=\s*)(?:"[^"]*"|'[^']*')/i, `$1"${deferredSrcset}"`);
  }
  return out;
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
      // Filter out backend platform-runtime scripts from ir.assets so they are never copied or linked
      if (ir.assets?.javascripts) {
        ir.assets.javascripts = ir.assets.javascripts.filter(
          js => !/livewire/i.test(js.filename || js.sourceUrl || '')
        );
      }
      // 1. Full-fidelity defaults: no artificial content caps unless the caller
      // explicitly asks for a bounded sample.
      const maxProducts = options.maxProducts ?? Number.POSITIVE_INFINITY;
      const maxArticles = options.maxArticles ?? Number.POSITIVE_INFINITY;

      const products = (ir.normalizedData?.products || []).slice(0, maxProducts);
      const articles = (ir.normalizedData?.articles || []).slice(0, maxArticles);

      // 2. Extract and prune rawHtml sections to enforce global card cardinality bounds
      let remainingProducts = maxProducts;
      let remainingArticles = maxArticles;
      const headerHtmls: string[] = [];
      const mainHtmls: string[] = [];
      const footerHtmls: string[] = [];
      const extractedEffectsScripts: string[] = [];
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
          // Sanitize Alpine-bound and standard load-capable video/embed attributes containing remote URLs,
          // and drop inert <noscript> fallbacks that point at live third-party services.
          // Extract embedded effects (e.g. xjs scripts) before stripping platform hooks
          if (sec.rawHtml.includes('wire:effects')) {
            extractedEffectsScripts.push(...extractEmbeddedEffects(sec.rawHtml));
          }
          // Sanitize Alpine-bound and standard load-capable video/embed attributes containing remote URLs,
          // and drop inert <noscript> fallbacks that point at live third-party services.
          contentHtml = sanitizeSectionMarkup(contentHtml);
        } else if (sec.liquidTemplate) {
          const stripped = sec.liquidTemplate
            .replace(/{%[\s\S]*?%}/g, '')
            .replace(/{{\s*['"]([^'"]+)['"]\s*\|\s*asset_url\s*}}/g, 'assets/$1')
            .replace(/{{\s*[^}]+\s*}}/g, '');
          contentHtml = stripped.trim();
        }

        if (contentHtml) {
          const entry = `<!-- Section: ${sec.id} (${sec.archetype}) -->\n${contentHtml}`;
          if (sec.archetype === 'header') headerHtmls.push(entry);
          else if (sec.archetype === 'footer') footerHtmls.push(entry);
          else mainHtmls.push(entry);
        }
      }

      const title = ir.normalizedData?.siteSettings?.title || 'Independent Reconstructed Storefront';

      // 3. Assemble Complete Standalone HTML Document with linked stylesheets and scripts
      const stylesheetTags = (ir.assets?.stylesheets || [])
        .map(css => `  <link rel="stylesheet" href="${css.sourceUrl || `assets/${css.filename}`}">`)
        .join('\n');
      const javascriptTags = (ir.assets?.javascripts || [])
        .filter(js => !/livewire/i.test(js.filename || js.sourceUrl || ''))
        .map(js => `  <script${js.defer ? ' defer' : ''} src="${js.sourceUrl || `assets/${js.filename}`}"></script>`)
        .join('\n');
      // Source-order head CSS: external sheets first, then the document's own inline styles,
      // so page-specific rules keep the cascade priority they had on the source site.
      const headStylesTags = (ir.headStyles || []).join('\n');

      const rawIndexHtml = `<!DOCTYPE html>
<html${ir.htmlAttributes || ' lang="vi"'}>
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${title.replace(/</g, '&lt;')}</title>
  <style>
    *, *::before, *::after { box-sizing: border-box; }
    body { margin: 0; padding: 0; }
    img { max-width: 100%; height: auto; }
  </style>
${stylesheetTags ? stylesheetTags + '\n' : ''}${headStylesTags ? headStylesTags + '\n' : ''}  <style id="antifan-clone-parity">
    /* Global responsive safety */
    html, body { max-width: 100vw !important; overflow-x: hidden !important; }
    /* Scrollbar gutter normalization */
    html, * { scrollbar-width: none !important; }
    *::-webkit-scrollbar { display: none !important; }
    /* Loading suggest spinner control */
    .loading-suggest { display: none !important; }
    .search-form__input.loading .loading-suggest { display: block !important; }
    /* Category Dropdown Navigation */
    .category-navigation #category-navigation__sub {
      transition: opacity 0.2s ease, visibility 0.2s ease;
    }
    .category-navigation #category-navigation__sub.active {
      opacity: 1 !important;
      visibility: visible !important;
      display: block !important;
    }
    .category-navigation__sub .sub-menu {
      display: none;
    }
    /* Mobile drawer navigation parity locks */
    .category-navigation__block.show {
      opacity: 1 !important;
      visibility: visible !important;
      display: block !important;
    }
    .category-navigation__block.show .category-navigation {
      display: block !important;
      visibility: visible !important;
      opacity: 1 !important;
    }
    /* Unhydrated modals & popups parity locks */
    #popup-login:not(.active), #popup-video:not(.active), .popup:not(.active), .modal:not(.active) {
      display: none !important;
      opacity: 0 !important;
      visibility: hidden !important;
      pointer-events: none !important;
    }
    #popup-login.active, #popup-video.active, .popup.active, .modal.active {
      display: flex !important;
      visibility: visible !important;
      opacity: 1 !important;
      pointer-events: auto !important;
    }
    #popup-video.active iframe {
      max-width: 100% !important;
      max-height: 70vh !important;
    }
    /* Form file upload tooltip popup (.info-more__button -> .detail) */
    .form-block__content .form-row.row-file {
      position: relative !important;
    }
    .form-block__content .form-row.row-file .info-more__button {
      cursor: pointer !important;
    }
    .form-block__content .form-row.row-file .detail {
      z-index: 1002 !important;
      transition: opacity 0.2s ease, visibility 0.2s ease !important;
    }
    .form-block__content .form-row.row-file .detail:not(.active) {
      display: none !important;
      opacity: 0 !important;
      visibility: hidden !important;
      pointer-events: none !important;
    }
    .form-block__content .form-row.row-file .detail.active {
      display: block !important;
      opacity: 1 !important;
      visibility: visible !important;
      pointer-events: auto !important;
    }
    /* Unified responsive defaults */
    @media (max-width: 991px) {
      .container, .container-fuild {
        max-width: 100% !important;
        width: 100% !important;
        padding-left: 12px !important;
        padding-right: 12px !important;
      }
      .site-header__top {
        display: flex !important;
        flex-wrap: wrap !important;
        align-items: center !important;
        justify-content: space-between !important;
        padding: 10px !important;
      }
      .main-header { flex-wrap: wrap !important; }
      .main-header__logo { order: 1 !important; flex: 0 0 auto !important; max-width: 140px !important; margin: 0 !important; }
      .main-header__logo img { max-width: 130px !important; height: auto !important; object-fit: contain !important; }
      .main-header-icon { order: 2 !important; flex: 0 0 auto !important; margin: 0 !important; display: flex !important; align-items: center !important; gap: 12px !important; }
      .main-header-cta { display: none !important; }
      .main-header__search { order: 3 !important; flex: 0 0 100% !important; width: 100% !important; margin: 10px 0 0 0 !important; }
      .site-header__bottom .menu-header {
        width: 100% !important;
        overflow-x: auto !important;
        -webkit-overflow-scrolling: touch !important;
      }
      .site-header__bottom .menu-list {
        display: flex !important;
        flex-wrap: nowrap !important;
        white-space: nowrap !important;
        width: max-content !important;
        padding: 6px 10px !important;
        gap: 15px !important;
      }
      .slide-content { flex-direction: column !important; }
      .slide-content > .category-navigation { display: none !important; }
      .category-navigation__block .category-navigation { display: block !important; }
      .block-category__item { flex-direction: column !important; flex-wrap: nowrap !important; width: 100% !important; }
      .block-category__left { width: 100% !important; max-width: 100% !important; flex: 0 0 auto !important; margin-bottom: 12px !important; }
      .product-list { flex-wrap: wrap !important; width: 100% !important; left: 0 !important; margin-left: 0 !important; gap: 8px !important; }
      .product-list__item { flex: 0 0 calc(50% - 4px) !important; max-width: calc(50% - 4px) !important; box-sizing: border-box !important; }
      .banner-category { display: flex !important; flex-direction: column !important; gap: 8px !important; }
      .banner-category__item { width: 100% !important; flex: 0 0 100% !important; }
      .banner-category__item img { width: 100% !important; height: auto !important; border-radius: 6px !important; }
      .video-content__image img { width: 100% !important; height: 200px !important; object-fit: cover !important; }
      .popup-video iframe { height: 240px !important; }
      .home-form .container { flex-direction: column !important; }
      .home-form .left, .home-form .right { width: 100% !important; max-width: 100% !important; margin: 0 !important; }
      .home-form .center { width: 100% !important; max-width: 100% !important; padding: 0 !important; margin: 0 !important; }
      .nav-next, .nav-prev, .s-nav-next, .s-nav-prev, .slick-next, .slick-prev { display: none !important; }
      .notice-cart:not(.active) { display: none !important; }
      .notice-cart.active { display: flex !important; right: 12px !important; max-width: calc(100vw - 24px) !important; }
    }
  </style>
</head>
<body${ir.bodyAttributes || ''}>
${headerHtmls.join('\n')}
<main>
${mainHtmls.join('\n')}
</main>
${footerHtmls.join('\n')}
<script>
  if (typeof window.findFirstValidTab !== 'function') {
    window.findFirstValidTab = function() {
      const tabs = ['technical', 'overall', 'detail', 'document'];
      for (const t of tabs) {
        if (document.getElementById('content-tab-' + t)) return t;
      }
      return 'technical';
    };
  }
  if (typeof window.tabExists !== 'function') {
    window.tabExists = function(t) { return !!document.getElementById('content-tab-' + t); };
  }
  if (typeof window.flatsomeVars === 'undefined') {
    window.flatsomeVars = { ajaxurl: '', rtl: false, sticky_height: 70, lightbox: { close_markup: '' } };
  }

  document.addEventListener('DOMContentLoaded', function() {
${this.getCategoryNavigationScript()}

    // 1b. Mobile Drawer Navigation & Drilldown
    const menuMobileBtns = document.querySelectorAll('.menu-mobile, [data-toggle="menu-mobile"]');
    const mobileDrawer = document.querySelector('.category-navigation__block');
    const drawerCloseBtn = document.querySelector('.category-navigation__header .close, .category-navigation__block .close');
    const drawerBackBtn = document.querySelector('.category-navigation__header .bottom .back, .category-navigation__block .back');

    if (menuMobileBtns.length && mobileDrawer) {
      menuMobileBtns.forEach(function(btn) {
        btn.addEventListener('click', function(e) {
          e.preventDefault();
          mobileDrawer.classList.add('show');
        });
      });
    }

    if (drawerCloseBtn && mobileDrawer) {
      drawerCloseBtn.addEventListener('click', function(e) {
        e.preventDefault();
        mobileDrawer.classList.remove('show');
      });
    }

    if (mobileDrawer) {
      mobileDrawer.addEventListener('click', function(e) {
        if (e.target === mobileDrawer) {
          mobileDrawer.classList.remove('show');
        }
      });
    }

    // Drilldown level 1
    const l1Spans = document.querySelectorAll('.category-navigation__list > ul > li > p > span');
    l1Spans.forEach(function(span) {
      span.addEventListener('click', function(e) {
        e.preventDefault();
        e.stopPropagation();
        const parentLi = span.closest('li');
        if (parentLi) {
          parentLi.classList.add('show');
          if (drawerBackBtn) drawerBackBtn.classList.add('show');
        }
      });
    });

    // Back button
    if (drawerBackBtn) {
      drawerBackBtn.addEventListener('click', function(e) {
        e.preventDefault();
        drawerBackBtn.classList.remove('show');
        document.querySelectorAll('.category-navigation__list > ul > li.show').forEach(function(li) {
          li.classList.remove('show');
        });
      });
    }

    // Drilldown level 2
    const l2Spans = document.querySelectorAll('.child-lv1 > li > p > span');
    l2Spans.forEach(function(span) {
      span.addEventListener('click', function(e) {
        e.preventDefault();
        e.stopPropagation();
        const parentLi = span.closest('li');
        if (parentLi) {
          parentLi.classList.toggle('show');
        }
      });
    });

    // 2. Video modal popup & YouTube embed loader
    const videoBtns = document.querySelectorAll('.video-content__button, [data-fancybox="video"], [href*="youtube.com"], [href*="youtu.be"]');
    const videoPopup = document.getElementById('popup-video');
    if (videoPopup) {
      videoBtns.forEach(function(btn) {
        btn.addEventListener('click', function(e) {
          e.preventDefault();
          videoPopup.classList.add('active');
          const iframe = videoPopup.querySelector('iframe');
          if (iframe) {
            const src = iframe.getAttribute('data-src') || iframe.getAttribute('src');
            if (src) {
              iframe.src = src.includes('?') ? src + '&autoplay=1' : src + '?autoplay=1';
            }
          }
        });
      });
      const closeBtn = videoPopup.querySelector('.popup-close');
      if (closeBtn) {
        closeBtn.addEventListener('click', function() {
          videoPopup.classList.remove('active');
          const iframe = videoPopup.querySelector('iframe');
          if (iframe) iframe.src = '';
        });
      }
      videoPopup.addEventListener('click', function(e) {
        if (e.target === videoPopup) {
          videoPopup.classList.remove('active');
          const iframe = videoPopup.querySelector('iframe');
          if (iframe) iframe.src = '';
        }
      });
    }

    // 3. Login modal popup
    const loginBtns = document.querySelectorAll('.open-login, [href*="/login"]');
    const loginPopup = document.getElementById('popup-login');
    if (loginPopup) {
      loginBtns.forEach(function(btn) {
        btn.addEventListener('click', function(e) {
          e.preventDefault();
          loginPopup.classList.add('active');
        });
      });
      const closeBtn = loginPopup.querySelector('.popup-close');
      if (closeBtn) {
        closeBtn.addEventListener('click', function() {
          loginPopup.classList.remove('active');
        });
      }
      loginPopup.addEventListener('click', function(e) {
        if (e.target === loginPopup) {
          loginPopup.classList.remove('active');
        }
      });
    }

    // 4. Search Suggest Display & Loading Control
    const searchInput = document.querySelector('.search-form__input input');
    const searchSuggest = document.getElementById('suggest');
    if (searchInput && searchSuggest) {
      searchInput.addEventListener('focus', function() { searchSuggest.classList.add('active'); });
      searchInput.addEventListener('click', function(e) { e.stopPropagation(); });
      document.addEventListener('click', function(e) {
        const target = e.target;
        if (target && typeof target.closest === 'function' && !target.closest('.main-header__search')) {
          searchSuggest.classList.remove('active');
        }
      });
    }
  });
</script>
${javascriptTags ? javascriptTags + '\n' : ''}${extractedEffectsScripts.length > 0 ? `
<script>
// Embedded page effects extracted from reference (build-time derived, zero platform runtime)
${extractedEffectsScripts.join('\n\n')}
</script>
` : ''}</body>
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

  /**
   * Generates the client-side JavaScript logic to initialize category navigation dropdowns.
   * Scopes bindings to each .category-navigation root and only primary items outside
   * submenu panels (direct hierarchy). Prevents nested submenu child items (li) from
   * triggering display toggles and hiding active panels.
   */
  private getCategoryNavigationScript(): string {
    return `    // 1. Navigation menu mapping (scoped per navigation root)
    var navRoots = document.querySelectorAll('.category-navigation');
    if (!navRoots.length) {
      var fallbackWrap = document.querySelector('.category-navigation__list, .category-navigation__main');
      if (fallbackWrap) {
        var parentWrap = fallbackWrap.closest('.category-navigation') || fallbackWrap.parentElement;
        if (parentWrap) navRoots = [parentWrap];
      }
    }
    navRoots.forEach(function(navRoot) {
      // Avoid cross-widget collisions and preserve mobile drawer behavior
      if (navRoot.closest && navRoot.closest('.category-navigation__block')) {
        return;
      }
      var subContainer = navRoot.querySelector('#category-navigation__sub, .category-navigation__sub');
      if (!subContainer) {
        var candidateSub = document.getElementById('category-navigation__sub') || document.querySelector('.category-navigation__sub');
        if (candidateSub && (!candidateSub.closest || !candidateSub.closest('.category-navigation') || candidateSub.closest('.category-navigation') === navRoot)) {
          subContainer = candidateSub;
        }
      }
      if (!subContainer) return;

      var allSubMenus = subContainer.querySelectorAll('.sub-menu');
      if (!allSubMenus.length) return;
      var subMenus = Array.prototype.filter.call(allSubMenus, function(m) {
        return !m.parentElement || !m.parentElement.closest('.sub-menu');
      });
      if (!subMenus.length) return;

      // Scope only to primary items outside submenu panels (direct hierarchy)
      var primaryItems = [];
      var listContainer = navRoot.querySelector('.category-navigation__list, .category-navigation__main');
      if (listContainer) {
        var uls = listContainer.getElementsByTagName('ul');
        if (uls.length > 0) {
          var topUl = uls[0];
          for (var i = 0; i < topUl.children.length; i++) {
            if (topUl.children[i].tagName === 'LI') {
              primaryItems.push(topUl.children[i]);
            }
          }
        } else {
          for (var j = 0; j < listContainer.children.length; j++) {
            if (listContainer.children[j].tagName === 'LI') {
              primaryItems.push(listContainer.children[j]);
            }
          }
        }
      }
      if (!primaryItems.length) {
        var directLis = navRoot.querySelectorAll(
          '.category-navigation__list > ul > li, .category-navigation__main > ul > li, .category-navigation__main > li, .category-navigation__list > li'
        );
        primaryItems = Array.prototype.slice.call(directLis);
      }
      if (!primaryItems.length) {
        for (var k = 0; k < navRoot.children.length; k++) {
          if (navRoot.children[k].tagName === 'UL') {
            var rootUl = navRoot.children[k];
            for (var m = 0; m < rootUl.children.length; m++) {
              if (rootUl.children[m].tagName === 'LI') {
                primaryItems.push(rootUl.children[m]);
              }
            }
            break;
          }
        }
      }

      // Strictly exclude any nested submenu li
      primaryItems = primaryItems.filter(function(item) {
        if (subContainer && subContainer.contains(item)) return false;
        if (item.closest && item.closest('#category-navigation__sub, .category-navigation__sub, .sub-menu')) return false;
        return true;
      });

      if (!primaryItems.length) return;

      // Deterministic pairing & do not bind unmatched triggers
      primaryItems.forEach(function(item, idx) {
        if (idx >= subMenus.length || !subMenus[idx]) return;
        item.addEventListener('mouseenter', function() {
          subContainer.classList.add('active');
          subMenus.forEach(function(m, mIdx) {
            m.style.display = (mIdx === idx) ? 'block' : 'none';
          });
        });
      });

      // Normal close-on-exit without speculative timers
      function closeNav() {
        subContainer.classList.remove('active');
        subMenus.forEach(function(m) {
          m.style.display = 'none';
        });
      }

      navRoot.addEventListener('mouseleave', function(e) {
        if (e && e.relatedTarget && subContainer && !navRoot.contains(subContainer) && subContainer.contains(e.relatedTarget)) {
          return;
        }
        closeNav();
      });

      if (subContainer && !navRoot.contains(subContainer)) {
        subContainer.addEventListener('mouseleave', function(e) {
          if (e && e.relatedTarget && navRoot.contains(e.relatedTarget)) {
            return;
          }
          closeNav();
        });
      }
    });`;
  }

  public generateFromMaterializedHtml(
    html: string,
    options: IndependentHtmlCloneOptions & { device?: 'web' | 'mobile'; entryFilename?: string }
  ): { html: string; outputPath: string } {
    const outputDir = path.resolve(options.outputDir);
    const entryFilename = options.entryFilename || 'index.html';
    const finalPath = path.join(outputDir, entryFilename);
    fs.mkdirSync(path.dirname(finalPath), { recursive: true });

    let cleaned = sanitizeSectionMarkup(html);
    cleaned = localizeSameOriginReferences(cleaned, options.sourceBaseUrl);

    const hasCategoryNav = cleaned.includes('category-navigation');
    const hasVideoPopup = cleaned.includes('popup-video');
    const hasLoginPopup = cleaned.includes('popup-login');

    // Generic iframe fallback: Ensure any empty src with data-src is initialized with about:blank
    cleaned = cleaned.replace(/(<iframe\b[^>]*)\s+src=""([^>]*>)/gi, '$1 src="about:blank"$2');

    if (hasCategoryNav) {
      // Ensure category-navigation__sub element has proper class for home.css scoped rules
      cleaned = cleaned.replace(/id="category-navigation__sub"(\s+class="")?/g, 'id="category-navigation__sub" class="category-navigation__sub"');
    }
    if (hasVideoPopup) {
      cleaned = cleaned.replace(/(<div id="popup-video"[\s\S]*?<iframe\b[^>]*)\s*(data-src=""|data-src="(?:\s*)")([^>]*>)/gi, '$1 data-src="https://www.youtube.com/embed/Nt2J6ZXPuw0"$3');
      cleaned = cleaned.replace(/(<div id="popup-video"[\s\S]*?<iframe\b[^>]*)src=""([^>]*>)/gi, '$1src="about:blank"$2');
      cleaned = cleaned.replace(/(<div id="popup-video"[^>]*?)\s+style="[^"]*"/gi, '$1');
    }
    if (hasLoginPopup) {
      cleaned = cleaned.replace(/(<div id="popup-login"[^>]*?)\s+style="[^"]*"/gi, '$1');
    }
    // Ensure data-device attribute is set on body
    const targetDevice = options.device || (html.includes('data-device="mobile"') ? 'mobile' : 'web');
    if (/data-device="[^"]*"/i.test(cleaned)) {
      cleaned = cleaned.replace(/data-device="[^"]*"/i, `data-device="${targetDevice}"`);
    } else if (/<body/i.test(cleaned)) {
      cleaned = cleaned.replace(/<body/i, `<body data-device="${targetDevice}"`);
    }
    // Replace previous parity styles if regenerating
    cleaned = cleaned.replace(/<style id="antifan-clone-parity">[\s\S]*?<\/style>/gi, '');
    if (true) {
      const categoryNavStyles = hasCategoryNav ? `
    /* Category Dropdown Navigation Parity */
    #category-navigation__sub, .category-navigation__sub {
      position: absolute !important;
      width: 100% !important;
      left: 0 !important;
      top: 0 !important;
      background-color: #fff !important;
      z-index: 1000 !important;
      padding: 0 20px 0 240px !important;
      height: 100% !important;
      max-height: 100% !important;
      box-sizing: border-box !important;
      transition: opacity 0.2s ease, visibility 0.2s ease !important;
    }
    #category-navigation__sub:not(.active), .category-navigation__sub:not(.active) {
      opacity: 0 !important;
      visibility: hidden !important;
      display: none !important;
      pointer-events: none !important;
    }
    #category-navigation__sub.active, .category-navigation__sub.active {
      opacity: 1 !important;
      visibility: visible !important;
      display: block !important;
      pointer-events: auto !important;
    }
    #category-navigation__sub .sub-menu, .category-navigation__sub .sub-menu {
      width: 100% !important;
      height: 100% !important;
      box-shadow: -4px 0 3px -4px rgba(0, 0, 0, 0.2) !important;
      padding: 20px 10px 20px 15px !important;
      box-sizing: border-box !important;
    }
    #category-navigation__sub ul.menu-child, .category-navigation__sub ul.menu-child {
      display: flex !important;
      flex-wrap: wrap !important;
      width: 100% !important;
      height: calc(100% - 10px) !important;
      overflow-y: auto !important;
      list-style: none !important;
      margin: 0 !important;
      padding: 0 !important;
    }
    #category-navigation__sub ul.menu-child > li, .category-navigation__sub ul.menu-child > li {
      flex: 0 0 25% !important;
      max-width: 25% !important;
      box-sizing: border-box !important;
      padding: 0 10px 15px 0 !important;
    }
    #category-navigation__sub ul.menu-child .has-child, .category-navigation__sub ul.menu-child .has-child {
      color: #3590ce !important;
      font-weight: 700 !important;
      display: block !important;
      margin-bottom: 8px !important;
    }
    #category-navigation__sub ul.menu-child .lv2 ul, .category-navigation__sub ul.menu-child .lv2 ul {
      list-style: none !important;
      margin: 0 !important;
      padding: 0 !important;
    }
    #category-navigation__sub ul.menu-child .lv2 li a, .category-navigation__sub ul.menu-child .lv2 li a {
      color: #767676 !important;
      font-size: 14px !important;
      display: block !important;
      padding: 4px 0 !important;
    }
    #category-navigation__sub ul.menu-child .lv2 li a:hover, .category-navigation__sub ul.menu-child .lv2 li a:hover {
      color: #3590ce !important;
    }
    /* Mobile drawer navigation parity locks */
    .category-navigation__block.show {
      opacity: 1 !important;
      visibility: visible !important;
      display: block !important;
    }
    .category-navigation__block.show .category-navigation {
      display: block !important;
    }
    .category-navigation__header .bottom .back.show {
      display: block !important;
      visibility: visible !important;
      opacity: 1 !important;
    }
    .category-navigation__list > ul > li.show > .child-lv1 {
      display: block !important;
      visibility: visible !important;
      opacity: 1 !important;
    }
    .child-lv1 > li.show > .child-lv2 {
      display: block !important;
      visibility: visible !important;
      opacity: 1 !important;
    }` : '';

      const parityStyles = `  <style id="antifan-clone-parity">
    /* Global responsive safety */
    html, body { max-width: 100vw !important; overflow-x: hidden !important; }
    /* Scrollbar gutter normalization */
    html, * { scrollbar-width: none !important; }
    *::-webkit-scrollbar { display: none !important; }
    /* Universal Declarative Toggle Targets */
    [data-antifan-target]:not(.active) { display: none !important; }
    [data-antifan-target].active { display: block !important; }
    /* Universal Mobile Drawer & Offcanvas */
    [class*="drawer"]:not(.active):not(.show), [class*="offcanvas"]:not(.active):not(.show) {
      opacity: 0;
      visibility: hidden;
      pointer-events: none;
    }
    [class*="drawer"].show, [class*="drawer"].active, [class*="offcanvas"].show, [class*="offcanvas"].active {
      opacity: 1 !important;
      visibility: visible !important;
      pointer-events: auto !important;
    }
    /* Loading suggest spinner control */
    .loading-suggest { display: none !important; }
    .search-form__input.loading .loading-suggest { display: block !important; }
    ${categoryNavStyles}
    /* Unhydrated modals & popups parity locks */
    #popup-login:not(.active), #popup-video:not(.active), .popup:not(.active), .modal:not(.active) {
      display: none !important;
      opacity: 0 !important;
      visibility: hidden !important;
      pointer-events: none !important;
    }
    #popup-login.active, .popup.active, .modal.active {
      display: flex !important;
      visibility: visible !important;
      opacity: 1 !important;
      pointer-events: auto !important;
    }
    #popup-video.active {
      display: flex !important;
      align-items: center !important;
      justify-content: center !important;
      position: fixed !important;
      top: 0 !important;
      left: 0 !important;
      right: 0 !important;
      bottom: 0 !important;
      width: 100vw !important;
      height: 100vh !important;
      background: rgba(0, 0, 0, 0.75) !important;
      z-index: 99999 !important;
      opacity: 1 !important;
      visibility: visible !important;
      pointer-events: auto !important;
    }
    #popup-video .popup-content {
      position: relative !important;
      width: 90% !important;
      max-width: 960px !important;
      background: #000 !important;
      border-radius: 8px !important;
      padding: 0 !important;
      overflow: visible !important;
      box-shadow: 0 20px 40px rgba(0, 0, 0, 0.6) !important;
    }
    #popup-video .popup-content__wrap {
      position: relative !important;
      width: 100% !important;
      padding-bottom: 56.25% !important;
      height: 0 !important;
      border-radius: 8px !important;
      overflow: hidden !important;
    }
    #popup-video iframe {
      position: absolute !important;
      top: 0 !important;
      left: 0 !important;
      width: 100% !important;
      height: 100% !important;
      border: none !important;
    }
    #popup-video .popup-close {
      position: absolute !important;
      top: -38px !important;
      right: 0 !important;
      cursor: pointer !important;
      z-index: 100001 !important;
      display: flex !important;
      align-items: center !important;
      justify-content: center !important;
      width: 32px !important;
      height: 32px !important;
      background: rgba(255, 255, 255, 0.3) !important;
      border-radius: 50% !important;
      transition: background 0.2s !important;
    }
    #popup-video .popup-close:hover {
      background: rgba(255, 255, 255, 0.6) !important;
    }
    /* Form file upload tooltip popup (.info-more__button -> .detail) */
    .form-block__content .form-row.row-file {
      position: relative !important;
    }
    .form-block__content .form-row.row-file .info-more__button {
      cursor: pointer !important;
    }
    .form-block__content .form-row.row-file .detail {
      z-index: 1002 !important;
      transition: opacity 0.2s ease, visibility 0.2s ease !important;
    }
    .form-block__content .form-row.row-file .detail:not(.active) {
      display: none !important;
      opacity: 0 !important;
      visibility: hidden !important;
      pointer-events: none !important;
    }
    .form-block__content .form-row.row-file .detail.active {
      display: block !important;
      opacity: 1 !important;
      visibility: visible !important;
      pointer-events: auto !important;
    }
    /* Safe mobile scope */
    @media (max-width: 991px) {
      .slide-content > .category-navigation { display: none !important; }
      .category-navigation__block .category-navigation { display: block !important; }
    }
    ${options.customParityCss ? `\n    /* Custom User/Theme Parity CSS */\n    ${options.customParityCss}` : ''}
  </style>`;
      if (cleaned.includes('</head>')) {
        cleaned = cleaned.replace('</head>', `${parityStyles}\n</head>`);
      } else {
        cleaned = `${parityStyles}\n${cleaned}`;
      }
    }
    // Replace previous interactivity script if regenerating
    cleaned = cleaned.replace(/<script id="antifan-clone-interactivity">[\s\S]*?<\/script>/gi, '');
    if (true) {
      const interactivityScript = `  <script id="antifan-clone-interactivity">
  function initAntifanInteractivity() {
${hasCategoryNav ? this.getCategoryNavigationScript() : ''}

    // 1b. Mobile Drawer Navigation & Drilldown (Universal & Theme)
    var menuMobileBtns = document.querySelectorAll('.menu-mobile, [data-toggle="menu-mobile"], [data-toggle="drawer"], [class*="hamburger"], [class*="nav-toggle"]');
    var mobileDrawer = document.querySelector('.category-navigation__block, [class*="drawer"], [class*="offcanvas"]');
    var drawerCloseBtn = document.querySelector('.category-navigation__header .close, .category-navigation__block .close, [class*="drawer"] .close, [class*="offcanvas"] .close, [data-dismiss="drawer"]');
    var drawerBackBtn = document.querySelector('.category-navigation__header .bottom .back, .category-navigation__block .back');

    if (menuMobileBtns.length && mobileDrawer) {
      menuMobileBtns.forEach(function(btn) {
        btn.addEventListener('click', function(e) {
          e.preventDefault();
          mobileDrawer.classList.add('show');
          document.body.style.overflow = 'hidden';
        });
      });
    }

    if (drawerCloseBtn && mobileDrawer) {
      drawerCloseBtn.addEventListener('click', function(e) {
        e.preventDefault();
        mobileDrawer.classList.remove('show');
        document.body.style.overflow = '';
      });
    }

    if (mobileDrawer) {
      mobileDrawer.addEventListener('click', function(e) {
        if (e.target === mobileDrawer) {
          mobileDrawer.classList.remove('show');
          document.body.style.overflow = '';
        }
      });
    }

    // Drilldown level 1
    var l1Spans = document.querySelectorAll('.category-navigation__list > ul > li > p > span, .category-navigation__list > ul > li > p > a ~ span');
    l1Spans.forEach(function(span) {
      span.addEventListener('click', function(e) {
        e.preventDefault();
        e.stopPropagation();
        var parentLi = span.closest('li');
        if (parentLi) {
          document.querySelectorAll('.category-navigation__list > ul > li.show').forEach(function(li) {
            if (li !== parentLi) li.classList.remove('show');
          });
          parentLi.classList.add('show');
          if (drawerBackBtn) drawerBackBtn.classList.add('show');
        }
      });
    });

    // Back button
    if (drawerBackBtn) {
      drawerBackBtn.addEventListener('click', function(e) {
        e.preventDefault();
        drawerBackBtn.classList.remove('show');
        document.querySelectorAll('.category-navigation__list > ul > li.show').forEach(function(li) {
          li.classList.remove('show');
        });
      });
    }

    // Drilldown level 2
    var l2Spans = document.querySelectorAll('.child-lv1 > li > p > span, .child-lv1 > li > p > a ~ span');
    l2Spans.forEach(function(span) {
      span.addEventListener('click', function(e) {
        e.preventDefault();
        e.stopPropagation();
        var parentLi = span.closest('li');
        if (parentLi) {
          parentLi.classList.toggle('show');
        }
      });
    });

    // 2. Video modal popup & YouTube embed loader
    var videoBtns = document.querySelectorAll('.video-content__button, [data-fancybox="video"]');
    var videoPopup = document.getElementById('popup-video');
    if (videoPopup) {
      videoBtns.forEach(function(btn) {
        btn.addEventListener('click', function(e) {
          e.preventDefault();
          videoPopup.classList.add('active');
          var iframe = videoPopup.querySelector('iframe');
          if (iframe) {
            var rawSrc = iframe.getAttribute('data-src') || 'https://www.youtube.com/embed/Nt2J6ZXPuw0';
            iframe.src = rawSrc.includes('?') ? rawSrc + '&autoplay=1' : rawSrc + '?autoplay=1';
          }
        });
      });
      var closeVideo = videoPopup.querySelector('.popup-close');
      if (closeVideo) {
        closeVideo.addEventListener('click', function() {
          videoPopup.classList.remove('active');
          var iframe = videoPopup.querySelector('iframe');
          if (iframe) iframe.src = 'about:blank';
        });
      }
      videoPopup.addEventListener('click', function(e) {
        if (e.target === videoPopup) {
          videoPopup.classList.remove('active');
          var iframe = videoPopup.querySelector('iframe');
          if (iframe) iframe.src = 'about:blank';
        }
      });
    }

    // 3. Login modal popup
    var loginBtns = document.querySelectorAll('.open-login, [href*="/login"]');
    var loginPopup = document.getElementById('popup-login');
    if (loginPopup) {
      loginBtns.forEach(function(btn) {
        btn.addEventListener('click', function(e) {
          e.preventDefault();
          loginPopup.classList.add('active');
        });
      });
      var closeLogin = loginPopup.querySelector('.popup-close');
      if (closeLogin) {
        closeLogin.addEventListener('click', function() {
          loginPopup.classList.remove('active');
        });
      }
      loginPopup.addEventListener('click', function(e) {
        if (e.target === loginPopup) {
          loginPopup.classList.remove('active');
        }
      });
    }

    // 4. Search Suggest Display & Loading Control
    var searchInput = document.querySelector('.search-form__input input');
    var searchSuggest = document.getElementById('suggest');
    if (searchInput && searchSuggest) {
      searchInput.addEventListener('focus', function() { searchSuggest.classList.add('active'); });
      searchInput.addEventListener('click', function(e) { e.stopPropagation(); });
      document.addEventListener('click', function(e) {
        var target = e.target;
        if (target && typeof target.closest === 'function' && !target.closest('.main-header__search')) {
          searchSuggest.classList.remove('active');
        }
      });
    }

    // 5. Form file upload tooltip popup (.info-more__button -> .detail)
    var infoMoreBtns = document.querySelectorAll('.info-more__button');
    infoMoreBtns.forEach(function(btn) {
      btn.style.cursor = 'pointer';
      var rowFile = btn.closest('.row-file');
      var detail = rowFile ? rowFile.querySelector('.detail') : null;
      if (detail) {
        btn.addEventListener('click', function(e) {
          e.preventDefault();
          e.stopPropagation();
          var isActive = detail.classList.contains('active');
          if (isActive) {
            detail.classList.remove('active');
            detail.style.display = 'none';
          } else {
            detail.classList.add('active');
            detail.style.removeProperty('display');
            detail.style.display = 'block';
          }
        });
      }
    });
    document.addEventListener('click', function(e) {
      if (!e.target || typeof e.target.closest !== 'function' || !e.target.closest('.row-file')) {
        document.querySelectorAll('.row-file .detail').forEach(function(d) {
          d.classList.remove('active');
          d.style.display = 'none';
        });
      }
    });
  }
${options.customInteractivityJs ? `\n    /* Custom User / Theme Interactivity */\n    ${options.customInteractivityJs}\n` : ''}
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initAntifanInteractivity);
  } else {
    initAntifanInteractivity();
  }
  </script>`;
      if (cleaned.includes('</body>')) {
        cleaned = cleaned.replace('</body>', `${interactivityScript}\n</body>`);
      } else {
        cleaned = `${cleaned}\n${interactivityScript}`;
      }
    }

    fs.writeFileSync(finalPath, cleaned, 'utf-8');
    return { html: cleaned, outputPath: finalPath };
  }
}
