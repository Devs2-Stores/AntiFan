/**
 * AntiFan Browser Desktop - Advanced Inspection Script Generator
 * Pure isolated-world script builder for styles, box-model, typography, CSS variables, and spatial region queries.
 */

import { ISOLATED_AGENT_WORLD_ID } from '../semantic-ref-executor';
import type { SemanticElementDescriptor } from '../semantic-ref-types';

export { ISOLATED_AGENT_WORLD_ID };

export interface InspectStylesRequest {
  descriptor?: SemanticElementDescriptor;
  selector?: string;
  properties?: string[];
  documentUrl?: string;
}

export interface InspectRegionRequest {
  descriptor?: SemanticElementDescriptor;
  selector?: string;
  x?: number;
  y?: number;
  width?: number;
  height?: number;
  documentUrl?: string;
}

export interface InspectFontRequest {
  descriptor?: SemanticElementDescriptor;
  selector?: string;
  documentUrl?: string;
}

export function buildInspectStylesIsolatedScript(request: InspectStylesRequest): string {
  const reqJson = JSON.stringify(request);

  return `(async () => {
    try {
      const req = ${reqJson};

      if (typeof req.documentUrl === 'string' && req.documentUrl.trim() && window.location.href !== req.documentUrl.trim()) {
        return {
          ok: false,
          error: 'Document URL mutated: expected "' + req.documentUrl + '", current "' + window.location.href + '"',
          code: 'REF_DOCUMENT_MUTATED'
        };
      }

      function matchesFingerprint(el, fp) {
        if (!el || !(el instanceof Element) || !fp || typeof fp !== 'object') return false;
        if (fp.tag && el.tagName.toLowerCase() !== String(fp.tag).toLowerCase()) return false;
        if (fp.id && el.id !== fp.id) return false;
        if (fp.role && el.getAttribute('role') !== fp.role) return false;
        if (fp.type && el.getAttribute('type') !== fp.type && el.type !== fp.type) return false;
        if (fp.name && el.getAttribute('name') !== fp.name) return false;
        if (fp.classHint) {
          const cls = typeof el.className === 'string' ? el.className : (el.getAttribute('class') || '');
          if (!cls.includes(fp.classHint)) return false;
        }
        return true;
      }

      function resolveTraversalPath(path) {
        if (!Array.isArray(path) || path.length === 0) return { element: null, deepestRoot: document };
        let current = document;
        let deepestRoot = document;
        for (let i = 0; i < path.length; i++) {
          const step = path[i];
          if (!step || typeof step !== 'object') return { element: null, deepestRoot };
          if (step.kind === 'dom') {
            const children = Array.from(current.children || []);
            let candidate = children[step.index] || null;
            if (!candidate && step.id && typeof current.getElementById === 'function') {
              candidate = current.getElementById(step.id);
            }
            if (!candidate) return { element: null, deepestRoot };
            current = candidate;
          } else if (step.kind === 'shadow') {
            const shadow = current.shadowRoot;
            if (!shadow) return { element: null, deepestRoot };
            deepestRoot = shadow;
            current = shadow;
          } else if (step.kind === 'iframe') {
            try {
              const doc = current.contentDocument || (current.contentWindow ? current.contentWindow.document : null);
              if (!doc) return { element: null, deepestRoot };
              deepestRoot = doc;
              current = doc;
            } catch {
              return { element: null, deepestRoot };
            }
          }
        }
        return { element: current instanceof Element ? current : null, deepestRoot };
      }

      function resolveCandidate() {
        if (req.descriptor && typeof req.descriptor === 'object') {
          const desc = req.descriptor;
          const { element, deepestRoot } = resolveTraversalPath(desc.path || desc.traversalPath);
          if (element && matchesFingerprint(element, desc.fingerprint)) {
            return { element, error: null };
          }
          if (deepestRoot && desc.fingerprint) {
            const fp = desc.fingerprint;
            const candidates = Array.from(deepestRoot.querySelectorAll(fp.tag || '*'));
            const matches = candidates.filter(el => matchesFingerprint(el, fp));
            if (matches.length === 1 && matches[0].isConnected) {
              return { element: matches[0], error: null };
            }
          }
          return { element: null, error: { ok: false, error: 'Semantic ref element not found', code: 'REF_NOT_FOUND' } };
        }

        if (req.selector && typeof req.selector === 'string') {
          try {
            const el = document.querySelector(req.selector);
            return { element: el && el.isConnected ? el : null, error: null };
          } catch (e) {
            return { element: null, error: { ok: false, error: 'Invalid selector: ' + e.message, code: 'INVALID_SELECTOR' } };
          }
        }

        return { element: document.body || document.documentElement, error: null };
      }

      const cand = resolveCandidate();
      if (cand.error) return cand.error;
      const targetElement = cand.element;
      if (!targetElement) {
        return { ok: false, error: 'Target element not found', code: 'ELEMENT_NOT_FOUND' };
      }

      const rect = targetElement.getBoundingClientRect();
      const style = window.getComputedStyle ? window.getComputedStyle(targetElement) : {};

      const parsePx = (val) => {
        const num = parseFloat(val);
        return isNaN(num) ? 0 : Math.round(num * 100) / 100;
      };

      const boxModel = {
        width: Math.round(rect.width * 100) / 100,
        height: Math.round(rect.height * 100) / 100,
        margin: {
          top: parsePx(style.marginTop),
          right: parsePx(style.marginRight),
          bottom: parsePx(style.marginBottom),
          left: parsePx(style.marginLeft)
        },
        padding: {
          top: parsePx(style.paddingTop),
          right: parsePx(style.paddingRight),
          bottom: parsePx(style.paddingBottom),
          left: parsePx(style.paddingLeft)
        },
        border: {
          top: parsePx(style.borderTopWidth),
          right: parsePx(style.borderRightWidth),
          bottom: parsePx(style.borderBottomWidth),
          left: parsePx(style.borderLeftWidth)
        }
      };

      const typography = {
        fontFamily: style.fontFamily || '',
        fontSize: style.fontSize || '',
        fontWeight: style.fontWeight || '',
        lineHeight: style.lineHeight || '',
        letterSpacing: style.letterSpacing || '',
        color: style.color || '',
        textAlign: style.textAlign || '',
        textDecoration: style.textDecoration || ''
      };

      const layout = {
        display: style.display || '',
        position: style.position || '',
        zIndex: style.zIndex || '',
        opacity: style.opacity || '1',
        visibility: style.visibility || 'visible',
        overflow: style.overflow || '',
        overflowX: style.overflowX || '',
        overflowY: style.overflowY || '',
        flexDirection: style.flexDirection || undefined,
        justifyContent: style.justifyContent || undefined,
        alignItems: style.alignItems || undefined,
        gap: style.gap || undefined,
        gridTemplateColumns: style.gridTemplateColumns || undefined,
        gridTemplateRows: style.gridTemplateRows || undefined
      };

      const visual = {
        backgroundColor: style.backgroundColor || '',
        backgroundImage: style.backgroundImage || '',
        boxShadow: style.boxShadow || '',
        borderRadius: style.borderRadius || '',
        transform: style.transform || ''
      };

      const cssVariables = {};
      try {
        if (style.length) {
          for (let i = 0; i < style.length; i++) {
            const prop = style[i];
            if (prop && prop.startsWith('--')) {
              cssVariables[prop] = style.getPropertyValue(prop).trim();
            }
          }
        }
      } catch {}

      const requestedStyles = {};
      if (Array.isArray(req.properties) && req.properties.length > 0) {
        for (const p of req.properties) {
          if (typeof p === 'string' && p.trim()) {
            requestedStyles[p] = typeof style.getPropertyValue === 'function' ? style.getPropertyValue(p) : (style[p] || '');
          }
        }
      }

      return {
        ok: true,
        data: {
          target: {
            tag: targetElement.tagName.toLowerCase(),
            id: targetElement.id || undefined,
            className: typeof targetElement.className === 'string' ? targetElement.className : undefined,
            rect: { left: rect.left, top: rect.top, width: rect.width, height: rect.height }
          },
          boxModel,
          typography,
          layout,
          visual,
          cssVariables,
          styles: requestedStyles
        }
      };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err), code: 'EVALUATION_FAILED' };
    }
  })()`;
}

export function buildInspectRegionIsolatedScript(request: InspectRegionRequest): string {
  const reqJson = JSON.stringify(request);

  return `(async () => {
    try {
      const req = ${reqJson};

      if (typeof req.documentUrl === 'string' && req.documentUrl.trim() && window.location.href !== req.documentUrl.trim()) {
        return {
          ok: false,
          error: 'Document URL mutated: expected "' + req.documentUrl + '", current "' + window.location.href + '"',
          code: 'REF_DOCUMENT_MUTATED'
        };
      }

      function matchesFingerprint(el, fp) {
        if (!el || !(el instanceof Element) || !fp || typeof fp !== 'object') return false;
        if (fp.tag && el.tagName.toLowerCase() !== String(fp.tag).toLowerCase()) return false;
        if (fp.id && el.id !== fp.id) return false;
        if (fp.role && el.getAttribute('role') !== fp.role) return false;
        if (fp.type && el.getAttribute('type') !== fp.type && el.type !== fp.type) return false;
        if (fp.name && el.getAttribute('name') !== fp.name) return false;
        if (fp.classHint) {
          const cls = typeof el.className === 'string' ? el.className : (el.getAttribute('class') || '');
          if (!cls.includes(fp.classHint)) return false;
        }
        return true;
      }

      function resolveTraversalPath(path) {
        if (!Array.isArray(path) || path.length === 0) return { element: null, deepestRoot: document };
        let current = document;
        let deepestRoot = document;
        for (let i = 0; i < path.length; i++) {
          const step = path[i];
          if (!step || typeof step !== 'object') return { element: null, deepestRoot };
          if (step.kind === 'dom') {
            const children = Array.from(current.children || []);
            let candidate = children[step.index] || null;
            if (!candidate && step.id && typeof current.getElementById === 'function') {
              candidate = current.getElementById(step.id);
            }
            if (!candidate) return { element: null, deepestRoot };
            current = candidate;
          } else if (step.kind === 'shadow') {
            const shadow = current.shadowRoot;
            if (!shadow) return { element: null, deepestRoot };
            deepestRoot = shadow;
            current = shadow;
          } else if (step.kind === 'iframe') {
            try {
              const doc = current.contentDocument || (current.contentWindow ? current.contentWindow.document : null);
              if (!doc) return { element: null, deepestRoot };
              deepestRoot = doc;
              current = doc;
            } catch {
              return { element: null, deepestRoot };
            }
          }
        }
        return { element: current instanceof Element ? current : null, deepestRoot };
      }

      let region = {
        left: typeof req.x === 'number' ? req.x : 0,
        top: typeof req.y === 'number' ? req.y : 0,
        right: (typeof req.x === 'number' ? req.x : 0) + (typeof req.width === 'number' ? req.width : window.innerWidth),
        bottom: (typeof req.y === 'number' ? req.y : 0) + (typeof req.height === 'number' ? req.height : window.innerHeight),
        width: typeof req.width === 'number' ? req.width : window.innerWidth,
        height: typeof req.height === 'number' ? req.height : window.innerHeight
      };

      if (req.descriptor && typeof req.descriptor === 'object') {
        const { element } = resolveTraversalPath(req.descriptor.path || req.descriptor.traversalPath);
        if (!element) {
          return { ok: false, error: 'Anchor semantic ref not found', code: 'REF_NOT_FOUND' };
        }
        const rect = element.getBoundingClientRect();
        region = { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom, width: rect.width, height: rect.height };
      } else if (req.selector && typeof req.selector === 'string') {
        try {
          const el = document.querySelector(req.selector);
          if (!el) {
            return { ok: false, error: 'Anchor selector not found: ' + req.selector, code: 'ELEMENT_NOT_FOUND' };
          }
          const rect = el.getBoundingClientRect();
          region = { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom, width: rect.width, height: rect.height };
        } catch (e) {
          return { ok: false, error: 'Invalid selector: ' + e.message, code: 'INVALID_SELECTOR' };
        }
      }

      const allElements = document.querySelectorAll('*');
      const matched = [];

      for (let i = 0; i < allElements.length; i++) {
        if (matched.length >= 100) break;
        const el = allElements[i];
        if (!el || el === document.documentElement || el === document.body) continue;

        const rect = el.getBoundingClientRect();
        if (rect.width === 0 && rect.height === 0) continue;

        const intersects = !(rect.right < region.left || rect.left > region.right || rect.bottom < region.top || rect.top > region.bottom);
        if (!intersects) continue;

        const style = window.getComputedStyle ? window.getComputedStyle(el) : null;
        if (style && (style.display === 'none' || style.visibility === 'hidden' || parseFloat(style.opacity || '1') <= 0)) {
          continue;
        }

        matched.push({
          tag: el.tagName.toLowerCase(),
          id: el.id || undefined,
          className: typeof el.className === 'string' ? el.className.trim() || undefined : undefined,
          role: el.getAttribute('role') || undefined,
          rect: {
            left: Math.round(rect.left * 100) / 100,
            top: Math.round(rect.top * 100) / 100,
            width: Math.round(rect.width * 100) / 100,
            height: Math.round(rect.height * 100) / 100
          },
          zIndex: style ? style.zIndex : undefined,
          textSnippet: (el.textContent || '').trim().slice(0, 60) || undefined
        });
      }

      return {
        ok: true,
        data: {
          region,
          elementCount: matched.length,
          elements: matched
        }
      };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err), code: 'EVALUATION_FAILED' };
    }
  })()`;
}

export function buildInspectFontIsolatedScript(request: InspectFontRequest): string {
  const reqJson = JSON.stringify(request);

  return `(async () => {
    try {
      const req = ${reqJson};

      if (typeof req.documentUrl === 'string' && req.documentUrl.trim() && window.location.href !== req.documentUrl.trim()) {
        return {
          ok: false,
          error: 'Document URL mutated: expected "' + req.documentUrl + '", current "' + window.location.href + '"',
          code: 'REF_DOCUMENT_MUTATED'
        };
      }

      function matchesFingerprint(el, fp) {
        if (!el || !(el instanceof Element) || !fp || typeof fp !== 'object') return false;
        if (fp.tag && el.tagName.toLowerCase() !== String(fp.tag).toLowerCase()) return false;
        if (fp.id && el.id !== fp.id) return false;
        if (fp.role && el.getAttribute('role') !== fp.role) return false;
        if (fp.type && el.getAttribute('type') !== fp.type && el.type !== fp.type) return false;
        if (fp.name && el.getAttribute('name') !== fp.name) return false;
        if (fp.classHint) {
          const cls = typeof el.className === 'string' ? el.className : (el.getAttribute('class') || '');
          if (!cls.includes(fp.classHint)) return false;
        }
        return true;
      }

      function resolveTraversalPath(path) {
        if (!Array.isArray(path) || path.length === 0) return { element: null, deepestRoot: document };
        let current = document;
        let deepestRoot = document;
        for (let i = 0; i < path.length; i++) {
          const step = path[i];
          if (!step || typeof step !== 'object') return { element: null, deepestRoot };
          const tag = (step.tag || '').toLowerCase();
          const children = current.children || current.childNodes;
          let match = null;
          let matchCount = 0;
          for (let j = 0; j < children.length; j++) {
            const child = children[j];
            if (child.nodeType === 1) {
              if (!tag || child.tagName.toLowerCase() === tag) {
                if (matchCount === (step.childIndex || 0)) {
                  match = child;
                  break;
                }
                matchCount++;
              }
            }
          }
          if (!match) return { element: null, deepestRoot };
          if (step.shadowRoot && match.shadowRoot) {
            current = match.shadowRoot;
            deepestRoot = match.shadowRoot;
          } else {
            current = match;
          }
        }
        return { element: current, deepestRoot };
      }

      let targetElement = null;

      if (req.descriptor && typeof req.descriptor === 'object') {
        const desc = req.descriptor;
        if (Array.isArray(desc.traversalPath) && desc.traversalPath.length > 0) {
          const resolved = resolveTraversalPath(desc.traversalPath);
          if (resolved.element && matchesFingerprint(resolved.element, desc.fingerprint)) {
            targetElement = resolved.element;
          }
        }
        if (!targetElement && desc.fingerprint && desc.fingerprint.id) {
          const el = document.getElementById(desc.fingerprint.id);
          if (el && matchesFingerprint(el, desc.fingerprint)) {
            targetElement = el;
          }
        }
        if (!targetElement && desc.selector) {
          try {
            const el = document.querySelector(desc.selector);
            if (el && matchesFingerprint(el, desc.fingerprint)) {
              targetElement = el;
            }
          } catch {}
        }
      }

      if (!targetElement && typeof req.selector === 'string' && req.selector.trim()) {
        try {
          targetElement = document.querySelector(req.selector);
        } catch (selErr) {
          return { ok: false, error: 'Invalid selector: ' + req.selector, code: 'INVALID_SELECTOR' };
        }
      }

      if (!targetElement) {
        return { ok: false, error: 'Element not found', code: 'REF_NOT_FOUND' };
      }

      // Save reference on window so CDP Runtime.evaluate can access objectId directly
      try {
        window.__antifan_last_inspected_font_element = targetElement;
      } catch {}

      const style = window.getComputedStyle(targetElement);
      const fontFamily = style.fontFamily || '';
      const fontSize = style.fontSize || '';
      const fontWeight = style.fontWeight || '';
      const fontStyle = style.fontStyle || '';
      const lineHeight = style.lineHeight || '';
      const letterSpacing = style.letterSpacing || '';
      const color = style.color || '';

      const primaryDeclared = fontFamily.split(',')[0].replace(/['"]/g, '').trim() || 'sans-serif';
      const declaredStack = fontFamily.split(',').map(f => f.replace(/['"]/g, '').trim()).filter(Boolean);

      const fullText = (targetElement.textContent || '').trim();
      const sampleText = fullText.slice(0, 160);
      const characterCount = fullText.length;
      const glyphCount = fullText.replace(/\\s+/g, '').length;
      const hasVietnameseDiacritics = /[àáạảãâầấậẩẫăằắặẳẵèéẹẻẽêềếệểễìíịỉĩòóọỏõôồốộổỗơờớợởỡùúụủũưừứựửữỳýỵỷỹđĐ]/i.test(fullText);
      const hasNonAscii = /[^\\x00-\\x7F]/.test(fullText);

      let fontFaceLoaded = undefined;
      if (document.fonts && typeof document.fonts.check === 'function') {
        try {
          const checkQuery = (fontStyle ? fontStyle + ' ' : '') + (fontWeight ? fontWeight + ' ' : '') + (fontSize || '16px') + ' ' + (fontFamily || 'sans-serif');
          fontFaceLoaded = document.fonts.check(checkQuery, sampleText || 'A');
        } catch {}
      }

      let matchingFontFaceRule = null;
      try {
        const sheets = document.styleSheets;
        for (let i = 0; i < sheets.length; i++) {
          try {
            const rules = sheets[i].cssRules || sheets[i].rules;
            if (!rules) continue;
            for (let j = 0; j < rules.length; j++) {
              const rule = rules[j];
              if (rule.type === CSSRule.FONT_FACE_RULE || (typeof CSSFontFaceRule !== 'undefined' && rule instanceof CSSFontFaceRule)) {
                const rFamily = (rule.style.fontFamily || '').replace(/['"]/g, '').trim();
                if (rFamily.toLowerCase() === primaryDeclared.toLowerCase()) {
                  matchingFontFaceRule = {
                    fontFamily: rFamily,
                    src: rule.style.getPropertyValue('src') || '',
                    fontWeight: rule.style.getPropertyValue('font-weight') || '',
                    fontStyle: rule.style.getPropertyValue('font-style') || '',
                    fontDisplay: rule.style.getPropertyValue('font-display') || '',
                    unicodeRange: rule.style.getPropertyValue('unicode-range') || ''
                  };
                  break;
                }
              }
            }
            if (matchingFontFaceRule) break;
          } catch {}
        }
      } catch {}

      const rect = targetElement.getBoundingClientRect();

      return {
        ok: true,
        data: {
          target: {
            tag: targetElement.tagName.toLowerCase(),
            id: targetElement.id || undefined,
            className: typeof targetElement.className === 'string' ? targetElement.className : undefined,
            rect: { left: rect.left, top: rect.top, width: rect.width, height: rect.height }
          },
          declared: {
            fontFamily,
            primaryDeclared,
            declaredStack,
            fontSize,
            fontWeight,
            fontStyle,
            lineHeight,
            letterSpacing,
            color
          },
          textMetrics: {
            sampleText,
            characterCount,
            glyphCount,
            hasVietnameseDiacritics,
            hasNonAscii
          },
          fontFaceStatus: {
            isLoaded: fontFaceLoaded,
            ruleFound: !!matchingFontFaceRule,
            rule: matchingFontFaceRule || undefined
          }
        }
      };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err), code: 'EVALUATION_FAILED' };
    }
  })()`;
}
