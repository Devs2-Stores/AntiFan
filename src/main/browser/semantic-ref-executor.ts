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

  return `(() => {
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
            if (!candidate && step.id && typeof current.getElementById === 'function') {
              candidate = current.getElementById(step.id);
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

      // 3. Resolve target node
      let targetElement = null;
      if (req.descriptor && Array.isArray(req.descriptor.path)) {
        targetElement = resolveTraversalPath(req.descriptor.path);
        if (!targetElement || !targetElement.isConnected) {
          return {
            ok: false,
            error: 'Target element detached or not found along traversal path',
            code: 'REF_NOT_FOUND'
          };
        }

        // 4. Validate fingerprint
        if (req.descriptor.fingerprint && typeof req.descriptor.fingerprint === 'object') {
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
      } else if (req.selector && typeof req.selector === 'string') {
        targetElement = document.querySelector(req.selector);
        if (!targetElement) {
          return {
            ok: false,
            error: 'Element not found for selector: "' + req.selector + '"',
            code: 'REF_NOT_FOUND'
          };
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

      // 6. Compute geometry rect
      let computedRect = undefined;
      if (targetElement) {
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
          if (typeof targetElement.scrollIntoView === 'function') {
            targetElement.scrollIntoView({ block: 'nearest', inline: 'nearest' });
          }
          if (typeof targetElement.focus === 'function') {
            targetElement.focus();
          }
          targetElement.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, view: window }));
          targetElement.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true, view: window }));
          targetElement.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
          return { ok: true, executed: true, rect: computedRect };
        } else if (typeof req.x === 'number' && typeof req.y === 'number') {
          const elAtPoint = document.elementFromPoint(req.x, req.y);
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
        if (req.clear && 'value' in targetElement) {
          targetElement.value = '';
          targetElement.dispatchEvent(new Event('input', { bubbles: true }));
        }
        if ('value' in targetElement) {
          targetElement.value = (targetElement.value || '') + (req.text || '');
          targetElement.dispatchEvent(new Event('input', { bubbles: true }));
          targetElement.dispatchEvent(new Event('change', { bubbles: true }));
        }
        return { ok: true, executed: true, rect: computedRect };
      } else if (req.action === 'hover' || req.action === 'move') {
        if (targetElement) {
          targetElement.dispatchEvent(new MouseEvent('mouseenter', { bubbles: true, view: window }));
          targetElement.dispatchEvent(new MouseEvent('mouseover', { bubbles: true, view: window }));
          targetElement.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, view: window }));
          return { ok: true, executed: true, rect: computedRect };
        } else if (typeof req.x === 'number' && typeof req.y === 'number') {
          const elAtPoint = document.elementFromPoint(req.x, req.y);
          if (elAtPoint) {
            elAtPoint.dispatchEvent(new MouseEvent('mouseenter', { bubbles: true, clientX: req.x, clientY: req.y, view: window }));
            elAtPoint.dispatchEvent(new MouseEvent('mouseover', { bubbles: true, clientX: req.x, clientY: req.y, view: window }));
          }
          return { ok: true, executed: true };
        }
      } else if (req.action === 'scroll') {
        if (targetElement && typeof targetElement.scrollBy === 'function') {
          targetElement.scrollBy({ top: req.deltaY || 400, behavior: 'auto' });
        } else {
          window.scrollBy({ top: req.deltaY || 400, behavior: 'auto' });
        }
        return { ok: true, executed: true };
      } else if (req.action === 'highlight') {
        return { ok: true, executed: true, rect: computedRect };
      }

      return { ok: false, error: 'Unsupported action: "' + req.action + '"', code: 'INVALID_ARGUMENT' };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err), code: 'EXECUTION_ERROR' };
    }
  })()`;
}
