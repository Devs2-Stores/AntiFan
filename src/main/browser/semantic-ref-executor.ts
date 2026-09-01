/**
 * AntiFan Browser Desktop - Semantic Reference Isolated World Executor (World 1004)
 * Pure isolated-world script builder for fail-closed, synchronous DOM action execution.
 */

import {
  ISOLATED_AGENT_WORLD_ID,
  RendererActionRequest,
  RendererActionResponse,
  validateActionResponse,
} from './semantic-ref-types';

export { ISOLATED_AGENT_WORLD_ID, validateActionResponse };

export function buildIsolatedExecutorScript(request: RendererActionRequest): string {
  const reqJson = JSON.stringify(request);

  return `(async () => {
    try {
      const req = ${reqJson};

      // 1. Guard against pre-action navigation / URL mutation
      if (typeof req.documentUrl === 'string' && req.documentUrl.trim() && window.location.href !== req.documentUrl.trim()) {
        return {
          ok: false,
          error: 'Document URL mutated before execution: expected "' + req.documentUrl + '", current "' + window.location.href + '"',
          code: 'REF_DOCUMENT_MUTATED'
        };
      }

      // 2. Traversal path resolver across DOM, open Shadow DOM, and same-origin iframes
      function resolveTraversalPath(path) {
        if (!Array.isArray(path) || path.length === 0) return null;
        let current = document;
        for (let i = 0; i < path.length; i++) {
          const step = path[i];
          if (!step || typeof step !== 'object') return null;
          if (step.kind === 'dom') {
            const children = Array.from(current.children || []);
            let candidate = children[step.index] || null;
            if (!candidate && step.id) {
              if (typeof current.getElementById === 'function') {
                candidate = current.getElementById(step.id);
              }
              if (!candidate && typeof document.getElementById === 'function') {
                candidate = document.getElementById(step.id);
              }
            }
            if (!candidate) return null;
            current = candidate;
          } else if (step.kind === 'shadow') {
            if (!current.shadowRoot) return null;
            current = current.shadowRoot;
          } else if (step.kind === 'iframe') {
            if (!current.contentDocument) return null;
            current = current.contentDocument;
          } else {
            return null;
          }
        }
        return current instanceof Element ? current : null;
      }
      function resolveCandidate() {
        let el = null;
        if (req.descriptor && Array.isArray(req.descriptor.path)) {
          el = resolveTraversalPath(req.descriptor.path);
        } else if (req.selector && typeof req.selector === 'string') {
          el = document.querySelector(req.selector);
        }
        return el && el.isConnected ? el : null;
      }

      function isActionable(el) {
        if (!el || !el.isConnected) return false;
        const style = window.getComputedStyle ? window.getComputedStyle(el) : el.style || {};
        if (style.display === 'none' || style.visibility === 'hidden' || parseFloat(style.opacity || '1') <= 0) {
          return false;
        }
        if (el.disabled === true || el.getAttribute('aria-disabled') === 'true') {
          return false;
        }
        return true;
      }

      // 3. Resolve target node with MutationObserver / rAF auto-wait (up to 1500ms for element to become connected AND actionable)
      const needsTarget = Boolean(req.descriptor || req.selector);
      let targetElement = null;

      if (needsTarget) {
        targetElement = await new Promise((resolve) => {
          const immediate = resolveCandidate();
          if (immediate && isActionable(immediate)) {
            resolve(immediate);
            return;
          }

          let observer = null;
          let timeoutTimer = null;
          let rafHandle = null;

          const cleanup = () => {
            if (observer) {
              try { observer.disconnect(); } catch {}
              observer = null;
            }
            if (timeoutTimer) {
              clearTimeout(timeoutTimer);
              timeoutTimer = null;
            }
            if (rafHandle && typeof cancelAnimationFrame === 'function') {
              cancelAnimationFrame(rafHandle);
              rafHandle = null;
            }
          };

          const check = () => {
            const el = resolveCandidate();
            if (el && isActionable(el)) {
              cleanup();
              resolve(el);
              return true;
            }
            return false;
          };

          if (typeof MutationObserver === 'function' && (document.documentElement || document.body)) {
            observer = new MutationObserver(() => {
              check();
            });
            try {
              observer.observe(document.documentElement || document.body, {
                childList: true,
                subtree: true,
                attributes: true,
                attributeFilter: ['class', 'style', 'hidden', 'disabled', 'aria-hidden', 'open'],
              });
            } catch {}
          }

          const pollRaf = () => {
            if (!check()) {
              if (typeof requestAnimationFrame === 'function') {
                rafHandle = requestAnimationFrame(pollRaf);
              }
            }
          };
          if (typeof requestAnimationFrame === 'function') {
            rafHandle = requestAnimationFrame(pollRaf);
          }

          timeoutTimer = setTimeout(() => {
            cleanup();
            resolve(resolveCandidate());
          }, 1500);
        });
        if (!targetElement) {
          return {
            ok: false,
            error: req.selector ? 'Element not found for selector: "' + req.selector + '"' : 'Target element detached or not found along traversal path',
            code: 'REF_NOT_FOUND'
          };
        }

        // 4. Validate fingerprint
        if (req.descriptor && req.descriptor.fingerprint && typeof req.descriptor.fingerprint === 'object') {
          const fp = req.descriptor.fingerprint;
          if (fp.tag && targetElement.tagName.toLowerCase() !== fp.tag.toLowerCase()) {
            return {
              ok: false,
              error: 'Element fingerprint tag mismatch: expected "' + fp.tag + '", got "' + targetElement.tagName.toLowerCase() + '"',
              code: 'REF_FINGERPRINT_MISMATCH'
            };
          }
          if (fp.id && targetElement.id !== fp.id) {
            return {
              ok: false,
              error: 'Element fingerprint id mismatch: expected "' + fp.id + '", got "' + targetElement.id + '"',
              code: 'REF_FINGERPRINT_MISMATCH'
            };
          }
          if (fp.role && targetElement.getAttribute('role') && targetElement.getAttribute('role') !== fp.role) {
            return {
              ok: false,
              error: 'Element fingerprint role mismatch: expected "' + fp.role + '", got "' + targetElement.getAttribute('role') + '"',
              code: 'REF_FINGERPRINT_MISMATCH'
            };
          }
        }
      }

      // 5. Re-check URL immediately before irreversible event dispatch
      if (typeof req.documentUrl === 'string' && req.documentUrl.trim() && window.location.href !== req.documentUrl.trim()) {
        return {
          ok: false,
          error: 'Document URL mutated immediately before event dispatch: expected "' + req.documentUrl + '", current "' + window.location.href + '"',
          code: 'REF_DOCUMENT_MUTATED'
        };
      }

      // 6. Actionability, Visibility Pre-flight, and Post-Scroll Rect Calculation
      let computedRect = undefined;
      if (targetElement) {
        if (typeof targetElement.scrollIntoView === 'function') {
          targetElement.scrollIntoView({ block: 'nearest', inline: 'nearest' });
        }

        const style = window.getComputedStyle ? window.getComputedStyle(targetElement) : targetElement.style || {};
        if (style.display === 'none' || style.visibility === 'hidden' || parseFloat(style.opacity || '1') <= 0) {
          return {
            ok: false,
            error: 'Element is not visible (display: "' + style.display + '", visibility: "' + style.visibility + '", opacity: "' + style.opacity + '")',
            code: 'ELEMENT_NOT_VISIBLE'
          };
        }

        if (targetElement.disabled === true || targetElement.getAttribute('aria-disabled') === 'true') {
          return {
            ok: false,
            error: 'Element is disabled',
            code: 'ELEMENT_DISABLED'
          };
        }

        const rect = targetElement.getBoundingClientRect();
        computedRect = {
          x: rect.x,
          y: rect.y,
          width: rect.width,
          height: rect.height,
          centerX: rect.x + rect.width / 2,
          centerY: rect.y + rect.height / 2,
        };
      }

      // 7. Synchronous DOM event dispatch
      if (req.action === 'click') {
        if (targetElement) {
          if (typeof targetElement.focus === 'function') {
            targetElement.focus();
          }
          targetElement.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, view: window }));
          targetElement.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true, view: window }));
          targetElement.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
          return { ok: true, executed: true, rect: computedRect };
        } else if (typeof req.x === 'number' && typeof req.y === 'number') {
          const elAtPoint = document.elementFromPoint ? document.elementFromPoint(req.x, req.y) : null;
          if (elAtPoint) {
            elAtPoint.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, clientX: req.x, clientY: req.y, view: window }));
            elAtPoint.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true, clientX: req.x, clientY: req.y, view: window }));
            elAtPoint.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, clientX: req.x, clientY: req.y, view: window }));
          }
          return { ok: true, executed: true };
        }
      } else if (req.action === 'type') {
        if (!targetElement) {
          return { ok: false, error: 'Target element required for type action', code: 'REF_NOT_FOUND' };
        }
        if (typeof targetElement.focus === 'function') {
          targetElement.focus();
        }

        const isContentEditable = Boolean(
          targetElement.isContentEditable ||
          (targetElement.getAttribute && targetElement.getAttribute('contenteditable') === 'true')
        );

        function setNativeValue(element, val) {
          let proto = Object.getPrototypeOf(element);
          let descriptor = null;
          while (proto) {
            descriptor = Object.getOwnPropertyDescriptor(proto, 'value');
            if (descriptor && descriptor.set) break;
            proto = Object.getPrototypeOf(proto);
          }
          if (descriptor && descriptor.set) {
            descriptor.set.call(element, val);
          } else {
            element.value = val;
          }
        }

        const textToInsert = req.text || '';
        const currentVal = ('value' in targetElement) ? (targetElement.value || '') : (targetElement.textContent || '');
        const nextVal = req.clear ? textToInsert : (currentVal + textToInsert);

        try {
          targetElement.dispatchEvent(new InputEvent('beforeinput', {
            bubbles: true,
            cancelable: true,
            composed: true,
            data: textToInsert,
            inputType: 'insertText',
            view: window
          }));
        } catch {
          targetElement.dispatchEvent(new Event('beforeinput', { bubbles: true, cancelable: true, composed: true }));
        }

        if (isContentEditable) {
          if (req.clear) {
            targetElement.textContent = '';
          }
          if (textToInsert) {
            const sel = window.getSelection ? window.getSelection() : null;
            if (sel && sel.rangeCount > 0) {
              const range = sel.getRangeAt(0);
              range.deleteContents();
              const textNode = document.createTextNode(textToInsert);
              range.insertNode(textNode);
              range.setStartAfter(textNode);
              range.collapse(true);
              sel.removeAllRanges();
              sel.addRange(range);
            } else {
              targetElement.textContent = (targetElement.textContent || '') + textToInsert;
            }
          }
        } else if ('value' in targetElement) {
          setNativeValue(targetElement, nextVal);
        }

        try {
          targetElement.dispatchEvent(new InputEvent('input', {
            bubbles: true,
            cancelable: false,
            composed: true,
            data: textToInsert,
            inputType: 'insertText',
            view: window
          }));
        } catch {
          targetElement.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
        }

        targetElement.dispatchEvent(new Event('change', { bubbles: true, cancelable: false, composed: true }));
        return { ok: true, executed: true, rect: computedRect };
      } else if (req.action === 'hover' || req.action === 'move') {
        if (targetElement) {
          targetElement.dispatchEvent(new MouseEvent('mouseenter', { bubbles: true, view: window }));
          targetElement.dispatchEvent(new MouseEvent('mouseover', { bubbles: true, view: window }));
          targetElement.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, view: window }));
          return { ok: true, executed: true, rect: computedRect };
        } else if (typeof req.x === 'number' && typeof req.y === 'number') {
          const elAtPoint = document.elementFromPoint ? document.elementFromPoint(req.x, req.y) : null;
          if (elAtPoint) {
            elAtPoint.dispatchEvent(new MouseEvent('mouseenter', { bubbles: true, clientX: req.x, clientY: req.y, view: window }));
            elAtPoint.dispatchEvent(new MouseEvent('mouseover', { bubbles: true, clientX: req.x, clientY: req.y, view: window }));
          }
          return { ok: true, executed: true };
        }
      } else if (req.action === 'scroll') {
        if (targetElement && typeof targetElement.scrollBy === 'function') {
          targetElement.scrollBy({ top: req.deltaY || 400, behavior: 'auto' });
        } else if (window.scrollBy) {
          window.scrollBy({ top: req.deltaY || 400, behavior: 'auto' });
        }
        return { ok: true, executed: true };
      } else if (req.action === 'highlight') {
        return { ok: true, executed: true, rect: computedRect };
      } else if (req.action === 'focus') {
        if (!targetElement) {
          return { ok: false, error: 'Target element required for focus action', code: 'REF_NOT_FOUND' };
        }
        if (typeof targetElement.focus === 'function') {
          targetElement.focus();
        }
        if (req.clear) {
          if (typeof targetElement.select === 'function') {
            targetElement.select();
          } else if (targetElement.isContentEditable || (targetElement.getAttribute && targetElement.getAttribute('contenteditable') === 'true')) {
            const range = document.createRange ? document.createRange() : null;
            if (range) {
              range.selectNodeContents(targetElement);
              const sel = window.getSelection ? window.getSelection() : null;
              if (sel) {
                sel.removeAllRanges();
                sel.addRange(range);
              }
            }
          }
        }
        return { ok: true, executed: true, rect: computedRect };
      }
      return { ok: false, error: 'Unsupported action: "' + req.action + '"', code: 'INVALID_ARGUMENT' };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err), code: 'EXECUTION_ERROR' };
    }
  })()`;
}
export function buildIsolatedCollectorScript(nonce: string, expectedUrl: string): string {
  const nonceJson = JSON.stringify(nonce);
  const expectedUrlJson = JSON.stringify(expectedUrl);

  return `(() => {
    try {
      const expectedNonce = ${nonceJson};
      const expectedDocUrl = ${expectedUrlJson};

      if (window.location.href !== expectedDocUrl) {
        return {
          ok: false,
          error: 'Document URL mismatch before collection: expected "' + expectedDocUrl + '", got "' + window.location.href + '"',
          code: 'REF_DOCUMENT_MUTATED'
        };
      }

      const descriptors = [];
      const MAX_ITEMS = 150;
      const MAX_DEPTH = 32;

      function getCleanLabel(el) {
        const ariaLabel = el.getAttribute('aria-label');
        if (ariaLabel && ariaLabel.trim()) return ariaLabel.trim().slice(0, 60);
        const ariaLabelledBy = el.getAttribute('aria-labelledby');
        if (ariaLabelledBy) {
          const lblEl = document.getElementById(ariaLabelledBy);
          if (lblEl && lblEl.textContent && lblEl.textContent.trim()) return lblEl.textContent.trim().slice(0, 60);
        }
        if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') {
          const ph = el.getAttribute('placeholder');
          if (ph && ph.trim()) return ph.trim().slice(0, 60);
          if (el.type === 'submit' || el.type === 'button') {
            const val = el.getAttribute('value');
            if (val && val.trim()) return val.trim().slice(0, 60);
          }
        }
        const title = el.getAttribute('title');
        if (title && title.trim()) return title.trim().slice(0, 60);
        const alt = el.getAttribute('alt');
        if (alt && alt.trim()) return alt.trim().slice(0, 60);
        const txt = el.innerText || el.textContent;
        if (txt && txt.trim()) {
          return txt.trim().replace(/\\s+/g, ' ').slice(0, 60);
        }
        return '';
      }

      function getStorefrontMetadata(el) {
        let current = el;
        let sectionId = undefined;
        let productId = undefined;
        let blockId = undefined;
        while (current && current !== document.body && current !== document.documentElement) {
          if (!sectionId && current.dataset) {
            sectionId = current.dataset.sectionId || current.getAttribute('data-section-id') || undefined;
          }
          if (!productId && current.dataset) {
            productId = current.dataset.productId || current.getAttribute('data-product-id') || undefined;
          }
          if (!blockId && current.dataset) {
            blockId = current.dataset.blockId || current.getAttribute('data-block-id') || undefined;
          }
          current = current.parentElement;
        }
        if (sectionId || productId || blockId) {
          return { sectionId, productId, blockId };
        }
        return undefined;
      }

      function scanNode(node, currentPath, depth, frameOffsetX, frameOffsetY) {
        if (!node || descriptors.length >= MAX_ITEMS || depth > MAX_DEPTH) return;

        const children = Array.from(node.children || []);
        for (let i = 0; i < children.length; i++) {
          if (descriptors.length >= MAX_ITEMS) break;
          const child = children[i];
          if (!child || !(child instanceof Element)) continue;

          const tag = child.tagName.toLowerCase();
          const step = { kind: 'dom', index: i, tag, id: child.id || undefined };
          const stepPath = currentPath.concat([step]);

          // Handle iframes
          if (tag === 'iframe') {
            try {
              const contentDoc = child.contentDocument;
              if (contentDoc) {
                const ifrRect = child.getBoundingClientRect();
                const ifrStep = { kind: 'iframe', index: i, tag: 'iframe', id: child.id || undefined };
                scanNode(contentDoc, stepPath.concat([ifrStep]), depth + 1, frameOffsetX + ifrRect.left, frameOffsetY + ifrRect.top);
              }
            } catch {}
            continue;
          }

          // Handle shadow roots
          if (child.shadowRoot) {
            try {
              const shadowStep = { kind: 'shadow', index: i, tag };
              scanNode(child.shadowRoot, stepPath.concat([shadowStep]), depth + 1, frameOffsetX, frameOffsetY);
            } catch {}
          }
          const style = window.getComputedStyle(child);
          if (style.display === 'none' || style.visibility === 'hidden') continue;

          const role = child.getAttribute('role') || '';
          const isInteractive = (
            tag === 'button' ||
            (tag === 'a' && child.hasAttribute('href')) ||
            tag === 'input' ||
            tag === 'select' ||
            tag === 'textarea' ||
            tag === 'summary' ||
            role === 'button' ||
            role === 'link' ||
            role === 'checkbox' ||
            role === 'radio' ||
            role === 'tab' ||
            role === 'menuitem' ||
            child.hasAttribute('onclick') ||
            (child.hasAttribute('tabindex') && child.getAttribute('tabindex') !== '-1')
          );

          if (isInteractive) {
            const rect = child.getBoundingClientRect();
            if (rect.width > 0 && rect.height > 0) {
              const globalRect = {
                x: rect.x + frameOffsetX,
                y: rect.y + frameOffsetY,
                width: rect.width,
                height: rect.height,
                centerX: rect.x + frameOffsetX + rect.width / 2,
                centerY: rect.y + frameOffsetY + rect.height / 2
              };

              const label = getCleanLabel(child);
              const metadata = getStorefrontMetadata(child);
              const classHint = typeof child.className === 'string' && child.className.trim() ? child.className.trim().slice(0, 50) : undefined;

              descriptors.push({
                path: stepPath,
                fingerprint: {
                  tag,
                  role: role || undefined,
                  id: child.id || undefined,
                  name: child.getAttribute('name') || undefined,
                  type: child.getAttribute('type') || undefined,
                  classHint
                },
                rect: globalRect,
                label,
                role: role || tag,
                type: child.getAttribute('type') || undefined,
                id: child.id || undefined,
                metadata
              });
            }
          }

          // Scan child subtree
          if (child.children && child.children.length > 0 && !child.shadowRoot) {
            scanNode(child, stepPath, depth + 1, frameOffsetX, frameOffsetY);
          }
        }
      }
      scanNode(document, [], 0, 0, 0);
      return {
        ok: true,
        nonce: expectedNonce,
        documentUrl: window.location.href,
        descriptors
      };
    } catch (err) {
      return {
        ok: false,
        error: err instanceof Error ? err.message : String(err),
        code: 'COLLECTION_ERROR'
      };
    }
  })()`;
}
