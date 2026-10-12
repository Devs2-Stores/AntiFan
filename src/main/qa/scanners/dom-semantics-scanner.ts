/**
 * AntiFan Browser Desktop — DOM Semantics Scanner
 * Deterministic SEO, HTML, and Accessibility semantic tree scanner.
 * Evaluates heading hierarchy, accessible names, form labels, duplicate IDs,
 * metadata (lang, description, canonical, open-graph), JSON-LD syntax & types,
 * and touch target sizes.
 */

export interface DomSemanticsFinding {
  type:
    | 'missing_h1'
    | 'multiple_h1'
    | 'heading_level_skip'
    | 'missing_img_alt'
    | 'missing_accessible_name'
    | 'unlabeled_form_control'
    | 'duplicate_id'
    | 'missing_html_lang'
    | 'missing_meta_description'
    | 'meta_description_too_short'
    | 'meta_description_too_long'
    | 'missing_canonical'
    | 'missing_og_title'
    | 'missing_og_image'
    | 'invalid_json_ld'
    | 'touch_target_too_small';
  severity: 'critical' | 'warning' | 'info';
  message: string;
  selector?: string;
  details?: Record<string, unknown>;
}

export interface DomSemanticsSummary {
  h1Count: number;
  headingLevelSkipsCount: number;
  imgMissingAltCount: number;
  controlsMissingNameCount: number;
  formControlsMissingLabelCount: number;
  duplicateIdCount: number;
  hasHtmlLang: boolean;
  htmlLang?: string;
  hasMetaDescription: boolean;
  metaDescriptionLength?: number;
  hasCanonical: boolean;
  canonicalUrl?: string;
  hasOgTitle: boolean;
  hasOgImage: boolean;
  jsonLdBlocksCount: number;
  jsonLdInvalidCount: number;
  jsonLdTypes: string[];
  touchTargetsSub24Count: number;
}

export interface DomSemanticsScanResult {
  measured: boolean;
  score: number;
  summary: DomSemanticsSummary;
  findings: DomSemanticsFinding[];
}

export class DomSemanticsScanner {
  /**
   * Browser injection script to evaluate DOM semantics in page context.
   */
  public static getBrowserScanScript(): string {
    return `(() => {
      const findings = [];
      const MAX_TOP_OFFENDERS = 8;

      const getSelector = (el) => {
        if (!el || !el.tagName) return '';
        let sel = el.tagName.toLowerCase();
        if (el.id) {
          sel += '#' + el.id;
        } else if (el.className && typeof el.className === 'string') {
          const firstCls = el.className.trim().split(/\\s+/)[0];
          if (firstCls && /^[a-zA-Z][a-zA-Z0-9_-]*$/.test(firstCls)) sel += '.' + firstCls;
        }
        return sel;
      };

      const isAriaHidden = (el) => {
        try {
          return Boolean(el.getAttribute('aria-hidden') === 'true' || (el.closest && el.closest('[aria-hidden="true"]')));
        } catch {
          return false;
        }
      };

      // 1. Heading hierarchy (h1 count + level skips)
      const h1s = Array.from(document.querySelectorAll('h1'));
      const h1Count = h1s.length;
      if (h1Count === 0) {
        findings.push({
          type: 'missing_h1',
          severity: 'warning',
          message: 'No <h1> heading found on the page',
        });
      } else if (h1Count > 1) {
        findings.push({
          type: 'multiple_h1',
          severity: 'warning',
          message: 'Multiple <h1> headings (' + h1Count + ') found on the page; recommend exactly 1',
          selector: getSelector(h1s[1]),
          details: { h1Count, selectors: h1s.slice(0, MAX_TOP_OFFENDERS).map(getSelector) },
        });
      }

      const allHeadings = Array.from(document.querySelectorAll('h1, h2, h3, h4, h5, h6'));
      let prevLevel = 0;
      let headingSkips = 0;
      for (const h of allHeadings) {
        if (isAriaHidden(h)) continue;
        const level = parseInt(h.tagName.substring(1), 10);
        if (prevLevel > 0 && level > prevLevel + 1) {
          headingSkips++;
          if (headingSkips <= MAX_TOP_OFFENDERS) {
            findings.push({
              type: 'heading_level_skip',
              severity: 'warning',
              message: 'Heading level skipped from H' + prevLevel + ' to H' + level,
              selector: getSelector(h),
              details: { from: prevLevel, to: level },
            });
          }
        }
        prevLevel = level;
      }

      // 2. Images without alt attribute
      const images = Array.from(document.querySelectorAll('img'));
      let missingAltCount = 0;
      for (const img of images) {
        if (isAriaHidden(img)) continue;
        const role = img.getAttribute('role');
        if (role === 'presentation' || role === 'none') continue;
        if (!img.hasAttribute('alt')) {
          missingAltCount++;
          if (missingAltCount <= MAX_TOP_OFFENDERS) {
            findings.push({
              type: 'missing_img_alt',
              severity: 'warning',
              message: 'Image element missing "alt" attribute',
              selector: getSelector(img),
              details: { src: img.getAttribute('src') || '' },
            });
          }
        }
      }

      // 3. Buttons and links without accessible name
      const interactiveEls = Array.from(document.querySelectorAll('button, a[href], [role="button"], [role="link"], input[type="button"], input[type="submit"]'));
      let missingNameCount = 0;
      for (const el of interactiveEls) {
        if (isAriaHidden(el)) continue;
        let accessibleName = (el.getAttribute('aria-label') || '').trim();
        if (!accessibleName && el.getAttribute('aria-labelledby')) {
          const labelledId = el.getAttribute('aria-labelledby');
          const ref = document.getElementById(labelledId);
          if (ref) accessibleName = (ref.textContent || '').trim();
        }
        if (!accessibleName && el.getAttribute('title')) {
          accessibleName = (el.getAttribute('title') || '').trim();
        }
        if (!accessibleName && (el.tagName === 'INPUT')) {
          accessibleName = (el.getAttribute('value') || '').trim();
        }
        if (!accessibleName) {
          accessibleName = (el.innerText || el.textContent || '').trim();
        }
        if (!accessibleName) {
          const imgChild = el.querySelector('img[alt]');
          if (imgChild) accessibleName = (imgChild.getAttribute('alt') || '').trim();
        }
        if (!accessibleName) {
          const svgTitle = el.querySelector('svg title');
          if (svgTitle) accessibleName = (svgTitle.textContent || '').trim();
        }

        if (!accessibleName) {
          missingNameCount++;
          if (missingNameCount <= MAX_TOP_OFFENDERS) {
            findings.push({
              type: 'missing_accessible_name',
              severity: 'warning',
              message: 'Interactive element has no accessible name',
              selector: getSelector(el),
            });
          }
        }
      }

      // 4. Form controls without associated label
      const formControls = Array.from(document.querySelectorAll('input:not([type="hidden"]):not([type="submit"]):not([type="button"]):not([type="reset"]):not([type="image"]), select, textarea'));
      let missingLabelCount = 0;
      for (const fc of formControls) {
        if (isAriaHidden(fc)) continue;
        const hasAria = Boolean(fc.getAttribute('aria-label') || fc.getAttribute('aria-labelledby'));
        const hasWrappedLabel = Boolean(fc.closest && fc.closest('label'));
        let hasExplicitLabel = false;
        if (fc.id) {
          const escapedId = typeof CSS !== 'undefined' && typeof CSS.escape === 'function' ? CSS.escape(fc.id) : fc.id.replace(/["\\\\]/g, '\\\\$&');
          hasExplicitLabel = Boolean(document.querySelector('label[for="' + escapedId + '"]'));
        }
        const hasTitle = Boolean(fc.getAttribute('title'));
        if (!hasAria && !hasWrappedLabel && !hasExplicitLabel && !hasTitle) {
          missingLabelCount++;
          if (missingLabelCount <= MAX_TOP_OFFENDERS) {
            findings.push({
              type: 'unlabeled_form_control',
              severity: 'warning',
              message: 'Form control has no associated <label> or aria-label',
              selector: getSelector(fc),
            });
          }
        }
      }

      // 5. Duplicate ID detection
      const allWithId = Array.from(document.querySelectorAll('[id]'));
      const idCounts = new Map();
      for (const el of allWithId) {
        const id = el.id.trim();
        if (!id) continue;
        idCounts.set(id, (idCounts.get(id) || 0) + 1);
      }
      let duplicateIdCount = 0;
      idCounts.forEach((count, id) => {
        if (count > 1) {
          duplicateIdCount++;
          if (duplicateIdCount <= MAX_TOP_OFFENDERS) {
            findings.push({
              type: 'duplicate_id',
              severity: 'warning',
              message: 'Duplicate ID attribute "' + id + '" found on ' + count + ' elements',
              details: { id, count },
            });
          }
        }
      });

      // 6. HTML lang attribute
      const htmlLang = (document.documentElement.getAttribute('lang') || '').trim();
      const hasHtmlLang = Boolean(htmlLang);
      if (!hasHtmlLang) {
        findings.push({
          type: 'missing_html_lang',
          severity: 'warning',
          message: '<html> element is missing a non-empty "lang" attribute',
        });
      }

      // 7. Meta description
      const metaDescEl = document.querySelector('meta[name="description" i], meta[property="description" i]');
      const metaDesc = metaDescEl ? (metaDescEl.getAttribute('content') || '').trim() : '';
      const hasMetaDesc = Boolean(metaDesc);
      if (!hasMetaDesc) {
        findings.push({
          type: 'missing_meta_description',
          severity: 'warning',
          message: 'Page is missing a meta description tag',
        });
      } else if (metaDesc.length < 50) {
        findings.push({
          type: 'meta_description_too_short',
          severity: 'warning',
          message: 'Meta description is too short (' + metaDesc.length + ' chars; recommended 50-160)',
          details: { length: metaDesc.length },
        });
      } else if (metaDesc.length > 160) {
        findings.push({
          type: 'meta_description_too_long',
          severity: 'warning',
          message: 'Meta description is too long (' + metaDesc.length + ' chars; recommended 50-160)',
          details: { length: metaDesc.length },
        });
      }

      // 8. Canonical URL
      const canonicalEl = document.querySelector('link[rel="canonical" i]');
      const canonicalUrl = canonicalEl ? (canonicalEl.getAttribute('href') || '').trim() : '';
      const hasCanonical = Boolean(canonicalUrl);
      if (!hasCanonical) {
        findings.push({
          type: 'missing_canonical',
          severity: 'warning',
          message: 'Page is missing a canonical <link rel="canonical"> tag',
        });
      }

      // 9. Open Graph (og:title, og:image)
      const ogTitleEl = document.querySelector('meta[property="og:title" i]');
      const hasOgTitle = Boolean(ogTitleEl && (ogTitleEl.getAttribute('content') || '').trim());
      if (!hasOgTitle) {
        findings.push({
          type: 'missing_og_title',
          severity: 'warning',
          message: 'Page is missing an Open Graph title (<meta property="og:title">)',
        });
      }

      const ogImageEl = document.querySelector('meta[property="og:image" i]');
      const hasOgImage = Boolean(ogImageEl && (ogImageEl.getAttribute('content') || '').trim());
      if (!hasOgImage) {
        findings.push({
          type: 'missing_og_image',
          severity: 'warning',
          message: 'Page is missing an Open Graph image (<meta property="og:image">)',
        });
      }

      // 10. JSON-LD scripts
      const jsonLdScripts = Array.from(document.querySelectorAll('script[type="application/ld+json" i]'));
      const jsonLdBlocksCount = jsonLdScripts.length;
      let jsonLdInvalidCount = 0;
      const jsonLdTypesSet = new Set();

      const extractTypes = (obj) => {
        if (!obj || typeof obj !== 'object') return;
        if (Array.isArray(obj)) {
          obj.forEach(extractTypes);
          return;
        }
        if (obj['@type']) {
          if (Array.isArray(obj['@type'])) {
            obj['@type'].forEach((t) => typeof t === 'string' && jsonLdTypesSet.add(t));
          } else if (typeof obj['@type'] === 'string') {
            jsonLdTypesSet.add(obj['@type']);
          }
        }
        if (Array.isArray(obj['@graph'])) {
          obj['@graph'].forEach(extractTypes);
        }
      };

      for (const sc of jsonLdScripts) {
        const text = (sc.textContent || '').trim();
        if (!text) continue;
        try {
          const parsed = JSON.parse(text);
          extractTypes(parsed);
        } catch (err) {
          jsonLdInvalidCount++;
          findings.push({
            type: 'invalid_json_ld',
            severity: 'critical',
            message: 'Invalid JSON-LD syntax in <script type="application/ld+json">: ' + (err instanceof Error ? err.message : String(err)),
          });
        }
      }

      // 11. Touch targets < 24px on mobile widths
      const vpWidth = window.innerWidth || document.documentElement.clientWidth || 1024;
      const isMobileWidth = vpWidth < 768;
      let touchTargetsSub24Count = 0;
      if (isMobileWidth) {
        for (const el of interactiveEls) {
          if (isAriaHidden(el)) continue;
          const rect = el.getBoundingClientRect();
          if (rect.width > 0 && rect.height > 0 && (rect.width < 24 || rect.height < 24)) {
            touchTargetsSub24Count++;
            if (touchTargetsSub24Count <= MAX_TOP_OFFENDERS) {
              findings.push({
                type: 'touch_target_too_small',
                severity: 'warning',
                message: 'Interactive element touch target is ' + Math.round(rect.width) + 'x' + Math.round(rect.height) + 'px (< 24x24px)',
                selector: getSelector(el),
                details: { width: Math.round(rect.width), height: Math.round(rect.height) },
              });
            }
          }
        }
      }

      // Compute composite score [0..100]
      let score = 100;
      score -= jsonLdInvalidCount * 25;
      if (h1Count !== 1) score -= 10;
      score -= Math.min(15, headingSkips * 5);
      score -= Math.min(20, missingAltCount * 5);
      score -= Math.min(20, missingNameCount * 5);
      score -= Math.min(15, missingLabelCount * 5);
      score -= Math.min(15, duplicateIdCount * 5);
      if (!hasHtmlLang) score -= 5;
      if (!hasMetaDesc) score -= 5;
      if (!hasCanonical) score -= 5;
      if (!hasOgTitle) score -= 5;
      if (!hasOgImage) score -= 5;
      if (isMobileWidth) score -= Math.min(15, touchTargetsSub24Count * 3);
      score = Math.max(0, Math.min(100, score));

      return {
        measured: true,
        score,
        summary: {
          h1Count,
          headingLevelSkipsCount: headingSkips,
          imgMissingAltCount: missingAltCount,
          controlsMissingNameCount: missingNameCount,
          formControlsMissingLabelCount: missingLabelCount,
          duplicateIdCount,
          hasHtmlLang,
          htmlLang: htmlLang || undefined,
          hasMetaDescription: hasMetaDesc,
          metaDescriptionLength: hasMetaDesc ? metaDesc.length : undefined,
          hasCanonical,
          canonicalUrl: canonicalUrl || undefined,
          hasOgTitle,
          hasOgImage,
          jsonLdBlocksCount,
          jsonLdInvalidCount,
          jsonLdTypes: Array.from(jsonLdTypesSet),
          touchTargetsSub24Count,
        },
        findings,
      };
    })()`;
  }

  /**
   * Pure evaluation of document semantics over DOM fixtures.
   */
  public static evaluateDom(doc: Document, viewportWidth = 1024): DomSemanticsScanResult {
    const findings: DomSemanticsFinding[] = [];
    const MAX_TOP_OFFENDERS = 8;

    const getSelector = (el: Element): string => {
      if (!el || !el.tagName) return '';
      let sel = el.tagName.toLowerCase();
      if (el.id) {
        sel += '#' + el.id;
      } else if (el.className && typeof el.className === 'string') {
        const firstCls = el.className.trim().split(/\s+/)[0];
        if (firstCls && /^[a-zA-Z][a-zA-Z0-9_-]*$/.test(firstCls)) sel += '.' + firstCls;
      }
      return sel;
    };

    const isAriaHidden = (el: Element): boolean => {
      try {
        return Boolean(el.getAttribute('aria-hidden') === 'true' || el.closest?.('[aria-hidden="true"]'));
      } catch {
        return false;
      }
    };

    // 1. Heading hierarchy
    const h1s = Array.from(doc.querySelectorAll('h1'));
    const h1Count = h1s.length;
    if (h1Count === 0) {
      findings.push({
        type: 'missing_h1',
        severity: 'warning',
        message: 'No <h1> heading found on the page',
      });
    } else if (h1Count > 1) {
      findings.push({
        type: 'multiple_h1',
        severity: 'warning',
        message: `Multiple <h1> headings (${h1Count}) found on the page; recommend exactly 1`,
        selector: getSelector(h1s[1]!),
        details: { h1Count, selectors: h1s.slice(0, MAX_TOP_OFFENDERS).map(getSelector) },
      });
    }

    const allHeadings = Array.from(doc.querySelectorAll('h1, h2, h3, h4, h5, h6'));
    let prevLevel = 0;
    let headingSkips = 0;
    for (const h of allHeadings) {
      if (isAriaHidden(h)) continue;
      const level = parseInt(h.tagName.substring(1), 10);
      if (prevLevel > 0 && level > prevLevel + 1) {
        headingSkips++;
        if (headingSkips <= MAX_TOP_OFFENDERS) {
          findings.push({
            type: 'heading_level_skip',
            severity: 'warning',
            message: `Heading level skipped from H${prevLevel} to H${level}`,
            selector: getSelector(h),
            details: { from: prevLevel, to: level },
          });
        }
      }
      prevLevel = level;
    }

    // 2. Images without alt attribute
    const images = Array.from(doc.querySelectorAll('img'));
    let missingAltCount = 0;
    for (const img of images) {
      if (isAriaHidden(img)) continue;
      const role = img.getAttribute('role');
      if (role === 'presentation' || role === 'none') continue;
      if (!img.hasAttribute('alt')) {
        missingAltCount++;
        if (missingAltCount <= MAX_TOP_OFFENDERS) {
          findings.push({
            type: 'missing_img_alt',
            severity: 'warning',
            message: 'Image element missing "alt" attribute',
            selector: getSelector(img),
            details: { src: img.getAttribute('src') || '' },
          });
        }
      }
    }

    // 3. Buttons and links without accessible name
    const interactiveEls = Array.from(doc.querySelectorAll('button, a[href], [role="button"], [role="link"], input[type="button"], input[type="submit"]'));
    let missingNameCount = 0;
    for (const el of interactiveEls) {
      if (isAriaHidden(el)) continue;
      let accessibleName = (el.getAttribute('aria-label') || '').trim();
      if (!accessibleName && el.getAttribute('aria-labelledby')) {
        const labelledId = el.getAttribute('aria-labelledby');
        const ref = doc.getElementById(labelledId!);
        if (ref) accessibleName = (ref.textContent || '').trim();
      }
      if (!accessibleName && el.getAttribute('title')) {
        accessibleName = (el.getAttribute('title') || '').trim();
      }
      if (!accessibleName && el.tagName === 'INPUT') {
        accessibleName = (el.getAttribute('value') || '').trim();
      }
      if (!accessibleName) {
        accessibleName = (el.textContent || '').trim();
      }
      if (!accessibleName) {
        const imgChild = el.querySelector('img[alt]');
        if (imgChild) accessibleName = (imgChild.getAttribute('alt') || '').trim();
      }
      if (!accessibleName) {
        const svgTitle = el.querySelector('svg title');
        if (svgTitle) accessibleName = (svgTitle.textContent || '').trim();
      }

      if (!accessibleName) {
        missingNameCount++;
        if (missingNameCount <= MAX_TOP_OFFENDERS) {
          findings.push({
            type: 'missing_accessible_name',
            severity: 'warning',
            message: 'Interactive element has no accessible name',
            selector: getSelector(el),
          });
        }
      }
    }

    // 4. Form controls without associated label
    const formControls = Array.from(doc.querySelectorAll('input:not([type="hidden"]):not([type="submit"]):not([type="button"]):not([type="reset"]):not([type="image"]), select, textarea'));
    let missingLabelCount = 0;
    for (const fc of formControls) {
      if (isAriaHidden(fc)) continue;
      const hasAria = Boolean(fc.getAttribute('aria-label') || fc.getAttribute('aria-labelledby'));
      const hasWrappedLabel = Boolean(fc.closest?.('label'));
      let hasExplicitLabel = false;
      if (fc.id) {
        const escapedId = typeof CSS !== 'undefined' && typeof CSS.escape === 'function' ? CSS.escape(fc.id) : fc.id.replace(/["\\]/g, '\\$&');
        hasExplicitLabel = Boolean(doc.querySelector(`label[for="${escapedId}"]`));
      }
      const hasTitle = Boolean(fc.getAttribute('title'));
      if (!hasAria && !hasWrappedLabel && !hasExplicitLabel && !hasTitle) {
        missingLabelCount++;
        if (missingLabelCount <= MAX_TOP_OFFENDERS) {
          findings.push({
            type: 'unlabeled_form_control',
            severity: 'warning',
            message: 'Form control has no associated <label> or aria-label',
            selector: getSelector(fc),
          });
        }
      }
    }

    // 5. Duplicate ID detection
    const allWithId = Array.from(doc.querySelectorAll('[id]'));
    const idCounts = new Map<string, number>();
    for (const el of allWithId) {
      const id = el.id.trim();
      if (!id) continue;
      idCounts.set(id, (idCounts.get(id) || 0) + 1);
    }
    let duplicateIdCount = 0;
    idCounts.forEach((count, id) => {
      if (count > 1) {
        duplicateIdCount++;
        if (duplicateIdCount <= MAX_TOP_OFFENDERS) {
          findings.push({
            type: 'duplicate_id',
            severity: 'warning',
            message: `Duplicate ID attribute "${id}" found on ${count} elements`,
            details: { id, count },
          });
        }
      }
    });

    // 6. HTML lang attribute
    const htmlLang = (doc.documentElement.getAttribute('lang') || '').trim();
    const hasHtmlLang = Boolean(htmlLang);
    if (!hasHtmlLang) {
      findings.push({
        type: 'missing_html_lang',
        severity: 'warning',
        message: '<html> element is missing a non-empty "lang" attribute',
      });
    }

    // 7. Meta description
    const metaDescEl = doc.querySelector('meta[name="description" i], meta[property="description" i]');
    const metaDesc = metaDescEl ? (metaDescEl.getAttribute('content') || '').trim() : '';
    const hasMetaDesc = Boolean(metaDesc);
    if (!hasMetaDesc) {
      findings.push({
        type: 'missing_meta_description',
        severity: 'warning',
        message: 'Page is missing a meta description tag',
      });
    } else if (metaDesc.length < 50) {
      findings.push({
        type: 'meta_description_too_short',
        severity: 'warning',
        message: `Meta description is too short (${metaDesc.length} chars; recommended 50-160)`,
        details: { length: metaDesc.length },
      });
    } else if (metaDesc.length > 160) {
      findings.push({
        type: 'meta_description_too_long',
        severity: 'warning',
        message: `Meta description is too long (${metaDesc.length} chars; recommended 50-160)`,
        details: { length: metaDesc.length },
      });
    }

    // 8. Canonical URL
    const canonicalEl = doc.querySelector('link[rel="canonical" i]');
    const canonicalUrl = canonicalEl ? (canonicalEl.getAttribute('href') || '').trim() : '';
    const hasCanonical = Boolean(canonicalUrl);
    if (!hasCanonical) {
      findings.push({
        type: 'missing_canonical',
        severity: 'warning',
        message: 'Page is missing a canonical <link rel="canonical"> tag',
      });
    }

    // 9. Open Graph
    const ogTitleEl = doc.querySelector('meta[property="og:title" i]');
    const hasOgTitle = Boolean(ogTitleEl && (ogTitleEl.getAttribute('content') || '').trim());
    if (!hasOgTitle) {
      findings.push({
        type: 'missing_og_title',
        severity: 'warning',
        message: 'Page is missing an Open Graph title (<meta property="og:title">)',
      });
    }

    const ogImageEl = doc.querySelector('meta[property="og:image" i]');
    const hasOgImage = Boolean(ogImageEl && (ogImageEl.getAttribute('content') || '').trim());
    if (!hasOgImage) {
      findings.push({
        type: 'missing_og_image',
        severity: 'warning',
        message: 'Page is missing an Open Graph image (<meta property="og:image">)',
      });
    }

    // 10. JSON-LD scripts
    const jsonLdScripts = Array.from(doc.querySelectorAll('script[type="application/ld+json" i]'));
    const jsonLdBlocksCount = jsonLdScripts.length;
    let jsonLdInvalidCount = 0;
    const jsonLdTypesSet = new Set<string>();

    const extractTypes = (obj: unknown): void => {
      if (!obj || typeof obj !== 'object') return;
      if (Array.isArray(obj)) {
        obj.forEach(extractTypes);
        return;
      }
      const rec = obj as Record<string, unknown>;
      if (rec['@type']) {
        if (Array.isArray(rec['@type'])) {
          rec['@type'].forEach((t) => typeof t === 'string' && jsonLdTypesSet.add(t));
        } else if (typeof rec['@type'] === 'string') {
          jsonLdTypesSet.add(rec['@type']);
        }
      }
      if (Array.isArray(rec['@graph'])) {
        rec['@graph'].forEach(extractTypes);
      }
    };

    for (const sc of jsonLdScripts) {
      const text = (sc.textContent || '').trim();
      if (!text) continue;
      try {
        const parsed = JSON.parse(text);
        extractTypes(parsed);
      } catch (err) {
        jsonLdInvalidCount++;
        findings.push({
          type: 'invalid_json_ld',
          severity: 'critical',
          message: `Invalid JSON-LD syntax in <script type="application/ld+json">: ${err instanceof Error ? err.message : String(err)}`,
        });
      }
    }

    // 11. Touch targets < 24px on mobile widths
    const isMobileWidth = viewportWidth < 768;
    let touchTargetsSub24Count = 0;
    if (isMobileWidth) {
      for (const el of interactiveEls) {
        if (isAriaHidden(el)) continue;
        if (typeof el.getBoundingClientRect === 'function') {
          const rect = el.getBoundingClientRect();
          if (rect.width > 0 && rect.height > 0 && (rect.width < 24 || rect.height < 24)) {
            touchTargetsSub24Count++;
            if (touchTargetsSub24Count <= MAX_TOP_OFFENDERS) {
              findings.push({
                type: 'touch_target_too_small',
                severity: 'warning',
                message: `Interactive element touch target is ${Math.round(rect.width)}x${Math.round(rect.height)}px (< 24x24px)`,
                selector: getSelector(el),
                details: { width: Math.round(rect.width), height: Math.round(rect.height) },
              });
            }
          }
        }
      }
    }

    // Compute composite score [0..100]
    let score = 100;
    score -= jsonLdInvalidCount * 25;
    if (h1Count !== 1) score -= 10;
    score -= Math.min(15, headingSkips * 5);
    score -= Math.min(20, missingAltCount * 5);
    score -= Math.min(20, missingNameCount * 5);
    score -= Math.min(15, missingLabelCount * 5);
    score -= Math.min(15, duplicateIdCount * 5);
    if (!hasHtmlLang) score -= 5;
    if (!hasMetaDesc) score -= 5;
    if (!hasCanonical) score -= 5;
    if (!hasOgTitle) score -= 5;
    if (!hasOgImage) score -= 5;
    if (isMobileWidth) score -= Math.min(15, touchTargetsSub24Count * 3);
    score = Math.max(0, Math.min(100, score));

    return {
      measured: true,
      score,
      summary: {
        h1Count,
        headingLevelSkipsCount: headingSkips,
        imgMissingAltCount: missingAltCount,
        controlsMissingNameCount: missingNameCount,
        formControlsMissingLabelCount: missingLabelCount,
        duplicateIdCount,
        hasHtmlLang,
        htmlLang: htmlLang || undefined,
        hasMetaDescription: hasMetaDesc,
        metaDescriptionLength: hasMetaDesc ? metaDesc.length : undefined,
        hasCanonical,
        canonicalUrl: canonicalUrl || undefined,
        hasOgTitle,
        hasOgImage,
        jsonLdBlocksCount,
        jsonLdInvalidCount,
        jsonLdTypes: Array.from(jsonLdTypesSet),
        touchTargetsSub24Count,
      },
      findings,
    };
  }
}
