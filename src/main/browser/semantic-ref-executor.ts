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

  // The body below is a template literal, so a bare backtick anywhere inside it - including inside a
  // comment - ends the string and turns the following JavaScript into TypeScript. Write markdown-style
  // references as \`name\` with the backslash, and leave regular expressions double-escaped (\\s).
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

      // 2. Traversal path resolver strictly confined to boundary chain
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
            if (!candidate && step.id) {
              if (typeof current.getElementById === 'function') {
                candidate = current.getElementById(step.id);
              }
            }
            if (!candidate) return { element: null, deepestRoot };
            current = candidate;
          } else if (step.kind === 'shadow') {
            if (!current.shadowRoot) return { element: null, deepestRoot };
            current = current.shadowRoot;
            deepestRoot = current;
          } else if (step.kind === 'iframe') {
            try {
              if (!current.contentDocument) return { element: null, deepestRoot };
              current = current.contentDocument;
              deepestRoot = current;
            } catch {
              return { element: null, deepestRoot };
            }
          } else {
            return { element: null, deepestRoot };
          }
        }
        return {
          element: current instanceof Element ? current : null,
          deepestRoot: deepestRoot,
        };
      }

      function findCandidatesInBoundary(root, fp) {
        const start = performance.now();
        let inspectedCount = 0;
        const matches = [];
        const queue = [root];
        let truncated = false;

        while (queue.length > 0) {
          const node = queue.shift();
          if (!node) continue;

          if (node instanceof Element) {
            inspectedCount++;
            if (inspectedCount > 500 || (performance.now() - start) > 50) {
              truncated = true;
              break;
            }
            if (matchesFingerprint(node, fp)) {
              matches.push(node);
            }
            if (node.shadowRoot) {
              queue.push(node.shadowRoot);
            }
            if (node.tagName.toLowerCase() === 'iframe') {
              try {
                if (node.contentDocument) queue.push(node.contentDocument);
              } catch {}
            }
          }

          const children = Array.from(node.children || []);
          for (let i = 0; i < children.length; i++) {
            queue.push(children[i]);
          }
        }

        return {
          matches,
          inspectedCount,
          durationMs: performance.now() - start,
          truncated,
        };
      }

      function resolveCandidate() {
        if (req.descriptor && Array.isArray(req.descriptor.path)) {
          const fp = req.descriptor.fingerprint;
          const { element, deepestRoot } = resolveTraversalPath(req.descriptor.path);
          if (element && element.isConnected) {
            // Validate all populated terminal fingerprint fields on exact traversal candidate
            if (!fp || matchesFingerprint(element, fp)) {
              return { element, error: null };
            }
          }

          // Exact traversal failed or fingerprint mismatch -> enumerate within boundary root
          if (fp) {
            const searchRes = findCandidatesInBoundary(deepestRoot || document, fp);
            if (searchRes.truncated || searchRes.matches.length > 1) {
              return {
                element: null,
                error: {
                  ok: false,
                  error: 'Semantic ref is ambiguous: ' + (searchRes.truncated ? 'uniqueness search exceeded budget (500 elements or 50ms)' : searchRes.matches.length + ' matching elements found in boundary root'),
                  code: 'REF_AMBIGUOUS',
                  metadata: {
                    matchCount: searchRes.matches.length,
                    inspectedCount: searchRes.inspectedCount,
                    durationMs: searchRes.durationMs,
                    truncated: searchRes.truncated,
                  }
                }
              };
            }
            if (searchRes.matches.length === 1 && searchRes.matches[0].isConnected) {
              return { element: searchRes.matches[0], error: null };
            }
          }
          return { element: null, error: null };
        }

        if (req.selector && typeof req.selector === 'string') {
          try {
            let el = document.querySelector(req.selector);
            if (!el) {
              function queryShadowDeep(selector, root) {
                if (!root) return null;
                try {
                  const direct = root.querySelector(selector);
                  if (direct) return direct;
                } catch {}
                const elements = root.querySelectorAll ? Array.from(root.querySelectorAll('*')) : [];
                for (let i = 0; i < elements.length; i++) {
                  if (elements[i] && elements[i].shadowRoot) {
                    const found = queryShadowDeep(selector, elements[i].shadowRoot);
                    if (found) return found;
                  }
                }
                return null;
              }
              el = queryShadowDeep(req.selector, document);
            }
            return { element: el && el.isConnected ? el : null, error: null };
          } catch (e) {
            return { element: null, error: { ok: false, error: 'Invalid selector: ' + e.message, code: 'INVALID_SELECTOR' } };
          }
        }
        return { element: null, error: null };
      }

      function isActionable(el) {
        if (!el || !el.isConnected) return false;
        const style = window.getComputedStyle ? window.getComputedStyle(el) : el.style || {};
        if (style.display === 'none' || style.visibility === 'hidden' || parseFloat(style.opacity || '1') <= 0) {
          // Smart Swatch & Form Delegation: a hidden input[type=radio|checkbox] is actionable
          // if wrapped by or associated with an active, visible <label>.
          if (el.tagName === 'INPUT' && (el.type === 'radio' || el.type === 'checkbox')) {
            let label = el.closest ? el.closest('label') : null;
            if (!label && el.id && typeof CSS !== 'undefined' && typeof CSS.escape === 'function') {
              try {
                label = document.querySelector('label[for="' + CSS.escape(el.id) + '"]');
              } catch {}
            }
            if (label && label.isConnected) {
              const labelStyle = window.getComputedStyle ? window.getComputedStyle(label) : label.style || {};
              if (labelStyle.display !== 'none' && labelStyle.visibility !== 'hidden' && parseFloat(labelStyle.opacity || '1') > 0) {
                return true;
              }
            }
          }
          return false;
        }
        if (el.disabled === true || (typeof el.getAttribute === 'function' && el.getAttribute('aria-disabled') === 'true')) {
          return false;
        }
        return true;
      }

      // A pulsing CTA (transform: scale) or a spinning icon never reaches zero
      // position drift, so a naive frame-by-frame wait would burn every click
      // budget on a control that is perfectly clickable. Detect a running
      // infinite animation on the target itself and relax both the drift anchor
      // and the tolerance instead of waiting for motion that never stops.
      function hasRunningInfiniteAnimation(el) {
        try {
          if (!el || typeof el.getAnimations !== 'function') return false;
          const animations = el.getAnimations({ subtree: false });
          for (let i = 0; i < animations.length; i++) {
            const animation = animations[i];
            if (!animation || animation.playState === 'paused' || animation.playState === 'idle') continue;
            const effect = animation.effect;
            const timing = effect && typeof effect.getComputedTiming === 'function' ? effect.getComputedTiming() : null;
            if (!timing) continue;
            if (timing.iterations === Infinity || timing.duration === Infinity || timing.endTime === Infinity) {
              return true;
            }
          }
        } catch {}
        return false;
      }

      function describeNode(node) {
        if (!node || !node.tagName) return 'unknown';
        const tag = String(node.tagName).toLowerCase();
        const id = node.id ? '#' + node.id : '';
        let cls = '';
        try {
          const raw = typeof node.className === 'string' ? node.className : (node.getAttribute ? node.getAttribute('class') : '');
          if (raw) cls = '.' + String(raw).trim().split(/\\s+/).slice(0, 2).join('.');
        } catch {}
        return tag + id + cls;
      }

      // Does \`node\` sit inside \`ancestor\` in the COMPOSED tree? \`contains\` stops
      // at a shadow boundary, and this executor resolves refs inside open shadow
      // roots, so a shadow-inner target would otherwise read as a foreign
      // overlay covering itself.
      function composedContains(ancestor, node) {
        let current = node;
        while (current) {
          if (current === ancestor) return true;
          if (current.parentNode) {
            current = current.parentNode;
            continue;
          }
          // A shadow root has no parentNode; its host is the way out.
          const root = typeof current.getRootNode === 'function' ? current.getRootNode() : null;
          if (root && root !== current && root.host) {
            current = root.host;
            continue;
          }
          break;
        }
        return false;
      }

      // Is the point (cx, cy) still owned by the target, or did something else
      // swallow it? \`elementsFromPoint\` returns the z-order stack, so the first
      // element that can actually receive pointer input is the real owner of the
      // click. A non-interactive decorator (svg path, span) inside the target is
      // not an obstruction; an unrelated overlay in front of it is, and that is
      // reported instead of being clicked through.
      function resolveInputReceiver(cx, cy) {
        let stack = [];
        try {
          if (typeof document.elementsFromPoint === 'function') {
            stack = document.elementsFromPoint(cx, cy) || [];
          } else if (typeof document.elementFromPoint === 'function') {
            const single = document.elementFromPoint(cx, cy);
            stack = single ? [single] : [];
          }
        } catch {
          return null;
        }
        for (let i = 0; i < stack.length; i++) {
          const node = stack[i];
          if (!node || node.nodeType !== 1) continue;
          let style = null;
          try {
            style = window.getComputedStyle ? window.getComputedStyle(node) : null;
          } catch {}
          if (style) {
            if (style.pointerEvents === 'none') continue;
            if (style.visibility === 'hidden' || parseFloat(style.opacity || '1') <= 0) continue;
          }
          // First pointer-receiving element owns the point: decide on it.
          if (composedContains(targetElement, node)) return null;
          // Smart Label & Swatch Delegation:
          // A label wrapping (or bound to) the target forwards its activation to
          // the control, so it and any of its child decorators (color spans, svgs, text)
          // are legitimate receivers, not obstructions.
          const labelNode = node.tagName === 'LABEL' ? node : (node.closest ? node.closest('label') : null);
          if (labelNode) {
            let bound = null;
            try {
              bound = labelNode.control || (labelNode.htmlFor ? document.getElementById(labelNode.htmlFor) : null);
            } catch {}
            if (bound === targetElement) return null;
            try {
              if (targetElement.closest && targetElement.closest('label') === labelNode) return null;
            } catch {}
            try {
              const swatchContainer = targetElement.closest ? targetElement.closest('[data-variant-swatch], .swatch, .swatches, .variant-picker, [data-swatch]') : null;
              if (swatchContainer && swatchContainer.contains(node)) return null;
            } catch {}
          }
          // Both remaining cases are refusals, but they are different defects:
          // an ancestor receiver means the target itself cannot be hit here
          // (typically pointer-events: none on it), while a foreign node means
          // something else is genuinely on top.
          return { node: node, relation: composedContains(node, targetElement) ? 'ancestor' : 'foreign' };
        }
        return null;
      }

      // A target's center is not always the point it accepts input: a footer
      // link under a sticky add-to-cart bar, or a CTA under a fixed header, is
      // genuinely clickable slightly off-center. Sample the center first, then
      // an inset ring, and use the first point the target actually owns — only
      // when every sample belongs to something else is the target obscured.
      function samplePoints(rect) {
        const points = [{ x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 }];
        const insetX = Math.min(rect.width * 0.25, 24);
        const insetY = Math.min(rect.height * 0.25, 24);
        if (rect.width > 2 * insetX) {
          points.push({ x: rect.x + insetX, y: rect.y + rect.height / 2 });
          points.push({ x: rect.x + rect.width - insetX, y: rect.y + rect.height / 2 });
        }
        if (rect.height > 2 * insetY) {
          points.push({ x: rect.x + rect.width / 2, y: rect.y + insetY });
          points.push({ x: rect.x + rect.width / 2, y: rect.y + rect.height - insetY });
        }
        return points;
      }

      function readValueSignature(el) {
        const signature = { tag: '', value: null, ariaValueNow: null, ariaValueText: null };
        if (!el) return signature;
        signature.tag = String(el.tagName || '').toLowerCase();
        if ('value' in el && el.value !== undefined && el.value !== null) {
          signature.value = String(el.value).slice(0, 64);
        }
        if (typeof el.getAttribute === 'function') {
          signature.ariaValueNow = el.getAttribute('aria-valuenow');
          signature.ariaValueText = el.getAttribute('aria-valuetext');
        }
        return signature;
      }

      // 3. Resolve target node with MutationObserver / rAF auto-wait (up to 1500ms for element to become connected AND actionable)
      const needsTarget = Boolean(req.descriptor || req.selector);
      let targetElement = null;

      if (needsTarget) {
        const initial = resolveCandidate();
        if (initial.error) {
          return initial.error;
        }

        targetElement = await new Promise((resolve) => {
          if (initial.element && isActionable(initial.element)) {
            resolve(initial.element);
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
            const res = resolveCandidate();
            if (res.error) {
              cleanup();
              resolve(res);
              return true;
            }
            if (res.element && isActionable(res.element)) {
              cleanup();
              resolve(res.element);
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
            const finalRes = resolveCandidate();
            resolve(finalRes.error ? finalRes : finalRes.element);
          }, 1500);
        });

        if (targetElement && typeof targetElement === 'object' && 'error' in targetElement && targetElement.error) {
          return targetElement.error;
        }

        if (!targetElement) {
          return {
            ok: false,
            error: req.selector ? 'Element not found for selector: "' + req.selector + '"' : 'Target element detached or not found along traversal path',
            code: 'REF_NOT_FOUND'
          };
        }
      }

      // 4. Re-check URL immediately before irreversible event dispatch
      if (typeof req.documentUrl === 'string' && req.documentUrl.trim() && window.location.href !== req.documentUrl.trim()) {
        return {
          ok: false,
          error: 'Document URL mutated immediately before event dispatch: expected "' + req.documentUrl + '", current "' + window.location.href + '"',
          code: 'REF_DOCUMENT_MUTATED'
        };
      }

      // 5. Actionability, Visibility Pre-flight, and Post-Scroll Rect Calculation
      let computedRect = undefined;
      if (targetElement) {
        // Scrolling is opt-out: a caller taking before/after measurements (the
        // drag engine) must not have the page move between them.
        if (req.scrollIntoView !== false && typeof targetElement.scrollIntoView === 'function') {
          targetElement.scrollIntoView({ block: 'center', inline: 'center' });
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

        // Wait for motion to settle before computing the click anchor. Drift is
        // measured on the CENTER, not the corner: a scale-keyframe pulse leaves
        // (x, y) still while the center walks, so a corner anchor declares a
        // moving button stable. A running infinite animation can never settle,
        // so it relaxes the tolerance to 4px (harmonic oscillation of a pulse
        // badge) instead of spending the whole budget waiting for motion that
        // never stops. The budget is hard-bounded to 5 rAF frames (~83ms), and the
        // loop exits after two consecutive drift-free frames, so a static element
        // pays two frames. Asset/font readiness is not awaited here — the composed
        // settle barrier for visual parity lives in the capture path
        // (verification/capture-settle.ts), where a comparison actually needs it;
        // every agent action would otherwise pay that budget twice.
        if (!req.force) {
          const infiniteMotion = hasRunningInfiniteAnimation(targetElement);
          const tolerance = infiniteMotion ? 4 : 2;
          const firstRect = targetElement.getBoundingClientRect();
          let prevX = firstRect.x + firstRect.width / 2;
          let prevY = firstRect.y + firstRect.height / 2;
          let consecutiveZeroDelta = 0;
          for (let frame = 0; frame < 5; frame++) {
            const frameGate = Promise.withResolvers();
            let rafFired = false;
            // The gate resolves on whichever comes first: the compositor's frame, or a 50ms floor
            // that stops a throttled surface from stalling the action (a 20fps minimum frame rate).
            // Which one won is the signal below — a timer-sourced gate means the compositor produced
            // no frame at all, so no later frame can describe motion either.
            if (typeof requestAnimationFrame === 'function') {
              requestAnimationFrame(() => {
                rafFired = true;
                frameGate.resolve(undefined);
              });
            }
            const frameTimer = setTimeout(() => frameGate.resolve(undefined), 50);
            await frameGate.promise;
            clearTimeout(frameTimer);
            if (!targetElement.isConnected) break;
            if (!rafFired) {
              // Surface is throttled (backgrounded or occluded): frame-based drift cannot be
              // observed here, and paying the floor once per frame would cost more than the whole
              // actionability budget. One timer-paced measurement is all this context can produce.
              break;
            }
            const currentRect = targetElement.getBoundingClientRect();
            const centerX = currentRect.x + currentRect.width / 2;
            const centerY = currentRect.y + currentRect.height / 2;
            const delta = Math.hypot(prevX - centerX, prevY - centerY);
            prevX = centerX;
            prevY = centerY;
            if (delta <= tolerance) {
              consecutiveZeroDelta++;
              if (consecutiveZeroDelta >= 2) {
                break;
              }
            } else {
              consecutiveZeroDelta = 0;
            }
          }
        }
        // Re-validate post-settle invariants immediately before final rect computation & event dispatch
        if (typeof req.documentUrl === 'string' && req.documentUrl.trim() && window.location.href !== req.documentUrl.trim()) {
          return {
            ok: false,
            error: 'Document URL mutated during animation stabilization wait: expected "' + req.documentUrl + '", current "' + window.location.href + '"',
            code: 'REF_DOCUMENT_MUTATED'
          };
        }

        if (!targetElement.isConnected) {
          return {
            ok: false,
            error: 'Target element detached from DOM during animation stabilization wait',
            code: 'REF_DETACHED'
          };
        }

        if (!isActionable(targetElement)) {
          return {
            ok: false,
            error: 'Target element became non-actionable during animation stabilization wait',
            code: 'ELEMENT_NOT_ACTIONABLE'
          };
        }

        let rect = targetElement.getBoundingClientRect();
        // Smart Swatch Target Rect Redirection:
        // If target is an input (radio/checkbox) that has zero dimensions or is visually hidden,
        // redirect its bounding box to its associated visible <label> so CDP native mouse click
        // has a physical, interactive surface to hit!
        if (
          targetElement.tagName === 'INPUT' &&
          (targetElement.type === 'radio' || targetElement.type === 'checkbox') &&
          (rect.width <= 0 || rect.height <= 0)
        ) {
          let label = targetElement.closest ? targetElement.closest('label') : null;
          if (!label && targetElement.id && typeof CSS !== 'undefined' && typeof CSS.escape === 'function') {
            try {
              label = document.querySelector('label[for="' + CSS.escape(targetElement.id) + '"]');
            } catch {}
          }
          if (label) {
            const labelRect = label.getBoundingClientRect();
            if (labelRect.width > 0 && labelRect.height > 0) {
              rect = labelRect;
            }
          }
        }
        computedRect = {
          x: rect.x,
          y: rect.y,
          width: rect.width,
          height: rect.height,
          centerX: rect.x + rect.width / 2,
          centerY: rect.y + rect.height / 2,
        };

        // Occlusion gate: only requests that hand input to the page (or that
        // pre-flight such a hand-off, which is what 'focus' is used for) can be
        // stolen by a covering element. highlight/scroll/probe are observations
        // and must never be refused because a newsletter modal sits on top.
        const inputBearing = req.action === 'focus' || req.action === 'click' || req.action === 'type' || req.action === 'hover' || req.action === 'move';
        if (inputBearing && !req.force) {
          const deliveredAt = { x: computedRect.centerX, y: computedRect.centerY };
          let obstruction = null;
          for (const candidate of samplePoints(computedRect)) {
            const receiver = resolveInputReceiver(candidate.x, candidate.y);
            if (!receiver) {
              deliveredAt.x = candidate.x;
              deliveredAt.y = candidate.y;
              obstruction = null;
              break;
            }
            if (!obstruction) obstruction = { receiver: receiver, point: candidate };
          }
          if (obstruction) {
            // 1. Containment check FIRST on TARGET_OBSCURED:
            // If coveringNode contains targetElement (or relation === 'ancestor'),
            // targetElement is inside the overlay/modal/dialog itself.
            // Skip dismissal entirely and dispatch into the overlay.
            const isContained = obstruction.receiver.relation === 'ancestor' ||
              composedContains(obstruction.receiver.node, targetElement) ||
              (obstruction.receiver.node.contains && obstruction.receiver.node.contains(targetElement));

            if (isContained) {
              deliveredAt.x = obstruction.point.x;
              deliveredAt.y = obstruction.point.y;
              obstruction = null;
            }
          }

          if (obstruction) {
            // 2. Raycast auto-dismiss (target NOT contained):
            const noAutoDismiss = Boolean(req.noAutoDismiss || (typeof window !== 'undefined' && window.__antifanNoAutoDismiss));
            if (!noAutoDismiss) {
              const overlaySelector = '[aria-modal="true"], .modal, .popup, .cookie-banner, [class*="overlay"], [class*="backdrop"]';
              const covering = obstruction.receiver.node;
              let overlayEl = null;
              if (covering && covering.nodeType === 1) {
                if (covering.matches && covering.matches(overlaySelector)) {
                  overlayEl = covering;
                } else if (covering.closest) {
                  overlayEl = covering.closest(overlaySelector);
                }
              }

              if (overlayEl) {
                // Cap 2 attempts
                for (let attempt = 0; attempt < 2; attempt++) {
                  let mutationCount = 0;
                  let observer = null;
                  if (typeof MutationObserver === 'function') {
                    try {
                      observer = new MutationObserver((mutations) => {
                        mutationCount += mutations.length;
                      });
                      observer.observe(document.body || document.documentElement, { childList: true, subtree: true });
                    } catch {}
                  }

                  let dismissControl = null;
                  const dismissSelectors = [
                    '[aria-label="Close" i]',
                    '[aria-label="close" i]',
                    '.modal-close',
                    '.close-btn',
                    'button:has(.fa-times)',
                    '[data-dismiss="modal"]',
                    '.close'
                  ];
                  for (const sel of dismissSelectors) {
                    try {
                      dismissControl = overlayEl.querySelector(sel);
                      if (dismissControl) break;
                    } catch {}
                  }

                  if (dismissControl) {
                    try {
                      dismissControl.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, view: window }));
                      dismissControl.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true, view: window }));
                      dismissControl.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
                      if (typeof dismissControl.click === 'function') dismissControl.click();
                    } catch {}
                  } else {
                    const activeEl = document.activeElement;
                    const isEditableFocused = activeEl && (
                      activeEl.tagName === 'INPUT' ||
                      activeEl.tagName === 'TEXTAREA' ||
                      activeEl.isContentEditable ||
                      (activeEl.getAttribute && activeEl.getAttribute('contenteditable') === 'true')
                    );
                    if (!isEditableFocused) {
                      try {
                        const escEv = new KeyboardEvent('keydown', {
                          key: 'Escape',
                          code: 'Escape',
                          keyCode: 27,
                          which: 27,
                          bubbles: true,
                          cancelable: true,
                          view: window
                        });
                        document.dispatchEvent(escEv);
                        window.dispatchEvent(escEv);
                      } catch {}
                    }
                  }

                  await new Promise((r) => setTimeout(r, 150));

                  if (observer) {
                    try {
                      observer.disconnect();
                      // >5 DOM mutations/sec circuit breaker (150ms window with >= 5 mutations)
                      if (mutationCount >= 5) {
                        if (typeof window !== 'undefined') {
                          window.__antifanNoAutoDismiss = true;
                        }
                      }
                    } catch {}
                  }

                  let reObstructed = false;
                  for (const candidate of samplePoints(computedRect)) {
                    const receiver = resolveInputReceiver(candidate.x, candidate.y);
                    if (!receiver || receiver.relation === 'ancestor' || composedContains(receiver.node, targetElement)) {
                      deliveredAt.x = candidate.x;
                      deliveredAt.y = candidate.y;
                      obstruction = null;
                      reObstructed = false;
                      break;
                    }
                    reObstructed = true;
                    obstruction = { receiver, point: candidate };
                  }
                  if (!reObstructed) {
                    break;
                  }
                }
              }
            }
          }

          if (obstruction) {
            // 3. Deep-piercing dispatch for type + non-dismissible:
            // focus() + native value setter + beforeinput/input/change
            // Programmatic typing never required pointer traversal.
            if (req.action === 'type') {
              deliveredAt.x = computedRect.centerX;
              deliveredAt.y = computedRect.centerY;
              obstruction = null;
            }
          }

          if (obstruction) {
            let receiverText = '';
            try {
              receiverText = String(obstruction.receiver.node.textContent || '').trim().slice(0, 80);
            } catch {}
            return {
              ok: false,
              error: 'Target obscured by ' + describeNode(obstruction.receiver.node) + ' at every sampled point on ' + describeNode(targetElement) + '; refusing to dispatch input through a covering element',
              code: 'TARGET_OBSCURED',
              metadata: {
                target: describeNode(targetElement),
                obscuredBy: describeNode(obstruction.receiver.node),
                obscuredByRelation: obstruction.receiver.relation,
                obscuredByText: receiverText,
                point: obstruction.point,
                forceAvailable: true,
              },
            };
          }
          // Publish the point that was proven to accept input, so the trusted
          // CDP path clicks where the gate actually verified instead of guessing
          // the geometric center again. x/y/width/height remain the true element
          // box; a caller doing its own geometry (the drag engine) uses those.
          computedRect.centerX = deliveredAt.x;
          computedRect.centerY = deliveredAt.y;
        }
      }

      // 6. Synchronous DOM event dispatch
      if (req.action === 'click') {
        const isMobilePreset = Boolean(
          req.presetId && (
            req.presetId.startsWith('phone-') ||
            req.presetId.startsWith('iphone') ||
            req.presetId.startsWith('galaxy-') ||
            req.presetId.startsWith('tablet-') ||
            req.presetId.includes('mobile')
          )
        ) || (typeof window !== 'undefined' && window.innerWidth <= 768) ||
        (typeof navigator === 'object' && Number(navigator.maxTouchPoints || 0) > 0);

        function dispatchTouchSequence(target, cx, cy, elRect) {
          const width = elRect && typeof elRect.width === 'number' ? elRect.width : 0;
          const height = elRect && typeof elRect.height === 'number' ? elRect.height : 0;
          const dilatedWidth = Math.max(width, 44);
          const dilatedHeight = Math.max(height, 44);
          let prevented = false;

          if (typeof target.focus === 'function') {
            try { target.focus(); } catch {}
          }

          // 1. pointerover
          try {
            target.dispatchEvent(new PointerEvent('pointerover', {
              bubbles: true,
              cancelable: true,
              view: window,
              clientX: cx,
              clientY: cy,
              pointerId: 1,
              pointerType: 'touch',
              isPrimary: true,
              width: dilatedWidth,
              height: dilatedHeight,
            }));
          } catch {}

          // 2. pointerenter
          try {
            target.dispatchEvent(new PointerEvent('pointerenter', {
              bubbles: false,
              cancelable: false,
              view: window,
              clientX: cx,
              clientY: cy,
              pointerId: 1,
              pointerType: 'touch',
              isPrimary: true,
              width: dilatedWidth,
              height: dilatedHeight,
            }));
          } catch {}

          // 3. pointerdown(touch)
          try {
            const pDown = new PointerEvent('pointerdown', {
              bubbles: true,
              cancelable: true,
              view: window,
              clientX: cx,
              clientY: cy,
              pointerId: 1,
              pointerType: 'touch',
              isPrimary: true,
              buttons: 1,
              width: dilatedWidth,
              height: dilatedHeight,
            });
            if (!target.dispatchEvent(pDown)) prevented = true;
          } catch {}

          // 4. touchstart
          let touchObj = null;
          if (typeof Touch === 'function') {
            try {
              touchObj = new Touch({
                identifier: 1,
                target: target,
                clientX: cx,
                clientY: cy,
                pageX: cx + (window.scrollX || 0),
                pageY: cy + (window.scrollY || 0),
                radiusX: dilatedWidth / 2,
                radiusY: dilatedHeight / 2,
              });
            } catch {}
          }

          if (typeof TouchEvent === 'function') {
            try {
              const tStart = new TouchEvent('touchstart', {
                bubbles: true,
                cancelable: true,
                view: window,
                touches: touchObj ? [touchObj] : [],
                targetTouches: touchObj ? [touchObj] : [],
                changedTouches: touchObj ? [touchObj] : [],
              });
              if (!target.dispatchEvent(tStart)) prevented = true;
            } catch {}
          }

          // 5. touchend
          if (typeof TouchEvent === 'function') {
            try {
              const tEnd = new TouchEvent('touchend', {
                bubbles: true,
                cancelable: true,
                view: window,
                touches: [],
                targetTouches: [],
                changedTouches: touchObj ? [touchObj] : [],
              });
              if (!target.dispatchEvent(tEnd)) prevented = true;
            } catch {}
          }

          // 6. pointerup
          try {
            const pUp = new PointerEvent('pointerup', {
              bubbles: true,
              cancelable: true,
              view: window,
              clientX: cx,
              clientY: cy,
              pointerId: 1,
              pointerType: 'touch',
              isPrimary: true,
              buttons: 0,
              width: dilatedWidth,
              height: dilatedHeight,
            });
            if (!target.dispatchEvent(pUp)) prevented = true;
          } catch {}

          // 7. click (check defaultPrevented before click)
          if (!prevented) {
            try {
              target.dispatchEvent(new MouseEvent('click', {
                bubbles: true,
                cancelable: true,
                view: window,
                clientX: cx,
                clientY: cy,
              }));
            } catch {}
          }
        }

        if (targetElement) {
          if (isMobilePreset) {
            dispatchTouchSequence(targetElement, computedRect.centerX, computedRect.centerY, computedRect);
          } else {
            if (typeof targetElement.focus === 'function') {
              targetElement.focus();
            }
            targetElement.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, view: window }));
            targetElement.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true, view: window }));
            targetElement.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
          }
          return { ok: true, executed: true, executionTier: 'isolated_synthetic', rect: computedRect };
        } else if (typeof req.x === 'number' && typeof req.y === 'number') {
          const elAtPoint = document.elementFromPoint ? document.elementFromPoint(req.x, req.y) : null;
          if (elAtPoint) {
            if (isMobilePreset) {
              dispatchTouchSequence(elAtPoint, req.x, req.y, { width: 0, height: 0 });
            } else {
              elAtPoint.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, clientX: req.x, clientY: req.y, view: window }));
              elAtPoint.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true, clientX: req.x, clientY: req.y, view: window }));
              elAtPoint.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, clientX: req.x, clientY: req.y, view: window }));
            }
          }
          return { ok: true, executed: true, executionTier: 'isolated_synthetic' };
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
        return { ok: true, executed: true, executionTier: 'isolated_synthetic', rect: computedRect };
      } else if (req.action === 'hover' || req.action === 'move') {
        if (targetElement) {
          targetElement.dispatchEvent(new MouseEvent('mouseenter', { bubbles: true, view: window }));
          targetElement.dispatchEvent(new MouseEvent('mouseover', { bubbles: true, view: window }));
          targetElement.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, view: window }));
          return { ok: true, executed: true, executionTier: 'isolated_synthetic', rect: computedRect };
        } else if (typeof req.x === 'number' && typeof req.y === 'number') {
          const elAtPoint = document.elementFromPoint ? document.elementFromPoint(req.x, req.y) : null;
          if (elAtPoint) {
            elAtPoint.dispatchEvent(new MouseEvent('mouseenter', { bubbles: true, clientX: req.x, clientY: req.y, view: window }));
            elAtPoint.dispatchEvent(new MouseEvent('mouseover', { bubbles: true, clientX: req.x, clientY: req.y, view: window }));
          }
          return { ok: true, executed: true, executionTier: 'isolated_synthetic' };
        }
      } else if (req.action === 'scroll') {
        if (targetElement && typeof targetElement.scrollBy === 'function') {
          targetElement.scrollBy({ top: req.deltaY || 400, behavior: 'auto' });
        } else if (window.scrollBy) {
          window.scrollBy({ top: req.deltaY || 400, behavior: 'auto' });
        }
        return { ok: true, executed: true, executionTier: 'isolated_synthetic' };
      } else if (req.action === 'highlight') {
        if (targetElement) {
          const r = targetElement.getBoundingClientRect();
          let ov = document.getElementById('__antifan_agent_overlay__');
          if (!ov) {
            ov = document.createElement('div');
            ov.id = '__antifan_agent_overlay__';
            ov.setAttribute('style', 'position:fixed;inset:0;pointer-events:none;z-index:2147483646;');
            (document.documentElement || document.body).appendChild(ov);
          }
          let hl = document.getElementById('__antifan_agent_highlight__');
          if (!hl) {
            hl = document.createElement('div');
            hl.id = '__antifan_agent_highlight__';
            ov.appendChild(hl);
          } else if (hl.parentElement !== ov) {
            ov.appendChild(hl);
          }
          const color = typeof req.color === 'string' && req.color ? req.color : '#00f0ff';
          hl.setAttribute('style', [
            'position:fixed',
            'left:' + Math.max(0, r.left - 3) + 'px',
            'top:' + Math.max(0, r.top - 3) + 'px',
            'width:' + (r.width + 6) + 'px',
            'height:' + (r.height + 6) + 'px',
            'border:2px solid ' + color,
            'background:rgba(0,240,255,0.12)',
            'border-radius:6px',
            'box-shadow:0 0 0 3px rgba(10,15,30,0.85), 0 0 24px ' + color,
            'pointer-events:none',
            'z-index:2147483645',
            'display:block',
            'opacity:1',
            'transition:opacity 0.35s ease'
          ].join(';'));
          if (window.__antifanIsolatedHighlightTimer) clearTimeout(window.__antifanIsolatedHighlightTimer);
          window.__antifanIsolatedHighlightTimer = setTimeout(function() {
            const box = document.getElementById('__antifan_agent_highlight__');
            if (box) {
              box.style.opacity = '0';
              setTimeout(function() {
                if (box && box.style.opacity === '0') box.style.display = 'none';
              }, 360);
            }
          }, 2500);
        }
        return { ok: true, executed: true, executionTier: 'isolated_synthetic', rect: computedRect };
      } else if (req.action === 'probe') {
        // Measurement only: no scroll, no dispatch, no occlusion gate. The drag
        // engine needs an element's true rect and value signature immediately
        // before and after a gesture, and reusing the mutating focus/click
        // pre-flight there would move the page between the two measurements and
        // re-arm the gate on the post-read.
        if (!targetElement) {
          return { ok: false, error: 'Target element required for probe action', code: 'REF_NOT_FOUND' };
        }
        return {
          ok: true,
          executed: false,
          rect: computedRect,
          metadata: {
            touchCapable: typeof navigator === 'object' && Number(navigator.maxTouchPoints || 0) > 0,
            valueSignature: readValueSignature(targetElement),
          },
        };
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
        return {
          ok: true,
          executed: true,
          executionTier: 'isolated_synthetic',
          rect: computedRect,
          metadata: {
            touchCapable: typeof navigator === 'object' && Number(navigator.maxTouchPoints || 0) > 0,
            // Slider/range controls expose their state through value or
            // aria-valuenow; capturing it at pre-flight time lets a caller prove
            // a gesture actually moved the control instead of assuming it did.
            valueSignature: readValueSignature(targetElement),
          },
        };
      }
      return { ok: false, error: 'Unsupported action: "' + req.action + '"', code: 'INVALID_ARGUMENT' };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err), code: 'EXECUTION_ERROR' };
    }
  })()`;
}
export function buildIsolatedCollectorScript(nonce: string, expectedUrl: string, rootSelector?: string, viewportOnly?: boolean): string {
  const nonceJson = JSON.stringify(nonce);
  const expectedUrlJson = JSON.stringify(expectedUrl);
  const rootSelectorJson = JSON.stringify(rootSelector || '');
  const isVpOnly = viewportOnly === true;

  return `(() => {
    try {
      const expectedNonce = ${nonceJson};
      const expectedDocUrl = ${expectedUrlJson};
      const targetRootSelector = ${rootSelectorJson};
      const isViewportOnly = ${isVpOnly ? 'true' : 'false'};
      const vpHeight = window.innerHeight || 900;

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
        if (!el) return '';
        const getAttr = (name) => typeof el.getAttribute === 'function' ? el.getAttribute(name) : null;
        const ariaLabel = getAttr('aria-label');
        if (ariaLabel && ariaLabel.trim()) return ariaLabel.trim().slice(0, 60);
        const ariaLabelledBy = getAttr('aria-labelledby');
        if (ariaLabelledBy) {
          const lblEl = typeof document.getElementById === 'function' ? document.getElementById(ariaLabelledBy) : null;
          if (lblEl && lblEl.textContent && lblEl.textContent.trim()) return lblEl.textContent.trim().slice(0, 60);
        }
        if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') {
          const ph = getAttr('placeholder');
          if (ph && ph.trim()) return ph.trim().slice(0, 60);
          if (el.type === 'submit' || el.type === 'button') {
            const val = getAttr('value');
            if (val && val.trim()) return val.trim().slice(0, 60);
          }
        }
        const title = getAttr('title');
        if (title && title.trim()) return title.trim().slice(0, 60);
        const alt = getAttr('alt');
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
        let depth = 0;
        while (current && current !== document.body && current !== document.documentElement && depth < 8) {
          depth++;
          if (!sectionId && current.dataset) {
            sectionId = current.dataset.sectionId || current.getAttribute('data-section-id') || undefined;
          }
          if (!productId && current.dataset) {
            productId = current.dataset.productId || current.getAttribute('data-product-id') || undefined;
          }
          if (!blockId && current.dataset) {
            blockId = current.dataset.blockId || current.getAttribute('data-block-id') || undefined;
          }
          if (sectionId && productId && blockId) break;
          current = current.parentElement;
        }
        if (sectionId || productId || blockId) {
          return {
            sectionId: sectionId ? sectionId.slice(0, 80) : undefined,
            productId: productId ? productId.slice(0, 80) : undefined,
            blockId: blockId ? blockId.slice(0, 80) : undefined
          };
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
          const hasHiddenAttr = typeof child.hasAttribute === 'function' && child.hasAttribute('hidden');
          const hasDisplayNone = child.style && (child.style.display === 'none' || child.style.visibility === 'hidden');
          if (child.hidden || hasHiddenAttr || hasDisplayNone) continue;

          const getAttr = (name) => typeof child.getAttribute === 'function' ? child.getAttribute(name) : null;
          const hasAttr = (name) => typeof child.hasAttribute === 'function' ? child.hasAttribute(name) : false;

          const role = getAttr('role') || '';
          const isInteractive = (
            tag === 'button' ||
            (tag === 'a' && hasAttr('href')) ||
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
            hasAttr('onclick') ||
            (hasAttr('tabindex') && getAttr('tabindex') !== '-1')
          );

          if (isInteractive) {
            const rect = child.getBoundingClientRect();
            if (rect.width > 0 && rect.height > 0) {
              const style = window.getComputedStyle ? window.getComputedStyle(child) : null;
              if (style && (style.display === 'none' || style.visibility === 'hidden' || parseFloat(style.opacity || '1') <= 0)) {
                continue;
              }
              const isStickyOrFixed = style && (style.position === 'fixed' || style.position === 'sticky');
              if (isViewportOnly && !isStickyOrFixed && !targetRootSelector) {
                if (rect.bottom < -200 || rect.top > vpHeight * 1.5) {
                  continue;
                }
              }
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
                  name: getAttr('name') || undefined,
                  type: getAttr('type') || undefined,
                  classHint
                },
                rect: globalRect,
                label,
                role: role || tag,
                type: getAttr('type') || undefined,
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
      const startNode = targetRootSelector ? document.querySelector(targetRootSelector) : document;
      if (!startNode) {
        return {
          ok: false,
          error: 'Root selector not found: "' + targetRootSelector + '"',
          code: 'SELECTOR_NOT_FOUND'
        };
      }
      scanNode(startNode, [], 0, 0, 0);
      const vpWidth = window.innerWidth || 1280;
      descriptors.sort((a, b) => {
        const aInVp = a.rect.centerY >= 0 && a.rect.centerY <= vpHeight && a.rect.centerX >= 0 && a.rect.centerX <= vpWidth;
        const bInVp = b.rect.centerY >= 0 && b.rect.centerY <= vpHeight && b.rect.centerX >= 0 && b.rect.centerX <= vpWidth;
        if (aInVp && !bInVp) return -1;
        if (!aInVp && bInVp) return 1;
        return (a.rect.y - b.rect.y);
      });
      let finalDescriptors = descriptors.slice(0, MAX_ITEMS);
      let payloadJson = JSON.stringify(finalDescriptors);
      while (finalDescriptors.length > 20 && payloadJson.length > 120000) {
        finalDescriptors = finalDescriptors.slice(0, Math.floor(finalDescriptors.length * 0.8));
        payloadJson = JSON.stringify(finalDescriptors);
      }
      return {
        ok: true,
        nonce: expectedNonce,
        documentUrl: window.location.href,
        descriptors: finalDescriptors
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
