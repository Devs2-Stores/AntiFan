/**
 * AntiFan Browser Desktop — Element Picker & Compact Inline Comment / Multi-Select Modal
 * 100% Parity with Antigravity Browser Element Annotation & Multi-Add Pipeline.
 */

export const ELEMENT_PICKER_SCRIPT = `(() => {
  if (window.__antifanPickerActive) return;
  window.__antifanPickerActive = true;

  const OVERLAY_ID = 'antifan-inspect-overlay';
  const BADGE_ID = 'antifan-inspect-badge';
  const MODAL_ID = 'antifan-comment-modal';
  const MULTI_BAR_ID = 'antifan-multi-dock';
  const PIN_CLASS = 'antifan-element-pin';

  let pickedList = [];
  let isMultiMode = false;
  let currentTarget = null;
  let isModalOpen = false;

  const cleanup = () => {
    window.removeEventListener('mousemove', onHover, true);
    window.removeEventListener('pointermove', onHover, true);
    window.removeEventListener('pointerdown', onPointerDown, true);
    window.removeEventListener('pointerup', onPointerUp, true);
    window.removeEventListener('touchmove', onTouchMove, true);
    window.removeEventListener('touchstart', onTouchStart, true);
    window.removeEventListener('touchend', onTouchEnd, true);
    window.removeEventListener('click', onClick, true);
    window.removeEventListener('keydown', onKey, true);

    document.querySelectorAll('#' + MODAL_ID + ', #' + OVERLAY_ID + ', #' + BADGE_ID + ', #' + MULTI_BAR_ID + ', .' + PIN_CLASS).forEach((el) => {
      try { el.remove(); } catch {}
    });

    if (document.documentElement) document.documentElement.style.cursor = '';
    window.__antifanPickerActive = false;
    isModalOpen = false;
  };
  window.__antifanPickerCleanup = cleanup;
  const prevent = (e) => {
    if (e && e.preventDefault) e.preventDefault();
    if (e && e.stopPropagation) e.stopPropagation();
  };

  const isInteractiveUiEvent = (e) => {
    if (!e) return false;
    const modal = document.getElementById(MODAL_ID);
    const multiDock = document.getElementById(MULTI_BAR_ID);
    const path = (e.composedPath && typeof e.composedPath === 'function') ? e.composedPath() : [];
    if (modal && (modal === e.target || modal.contains(e.target) || path.includes(modal))) return true;
    if (multiDock && (multiDock === e.target || multiDock.contains(e.target) || path.includes(multiDock))) return true;
    if (e.target && e.target.nodeType === 1) {
      const el = e.target;
      if (el.id === MODAL_ID || el.id === MULTI_BAR_ID || (el.closest && (el.closest('#' + MODAL_ID) || el.closest('#' + MULTI_BAR_ID)))) {
        return true;
      }
    }
    return false;
  };

  const onKey = (e) => {
    if (e.key === 'Escape') {
      prevent(e);
      if (isModalOpen) {
        const modal = document.getElementById(MODAL_ID);
        if (modal) modal.remove();
        isModalOpen = false;
      }
      cleanup();
      window.__antifanPick = { canceled: true };
    }
  };
  const getDomAncestry = (el) => {
    const parts = [];
    let curr = el;
    while (curr && curr.nodeType === 1 && parts.length < 6) {
      let name = curr.tagName.toLowerCase();
      if (curr.id) name += '#' + curr.id;
      else if (curr.className && typeof curr.className === 'string') {
        const c = curr.className.trim().split(/\\s+/).filter(Boolean)[0];
        if (c) name += '.' + c;
      }
      parts.unshift(name);
      curr = curr.parentElement;
    }
    return parts.join(' > ');
  };

  const getXPath = (el) => {
    if (!el || el.nodeType !== 1) return '';
    if (el.id) return '//*[@id="' + el.id + '"]';
    const parts = [];
    while (el && el.nodeType === 1) {
      let idx = 1;
      let sibling = el.previousSibling;
      while (sibling) {
        if (sibling.nodeType === 1 && sibling.tagName === el.tagName) idx++;
        sibling = sibling.previousSibling;
      }
      parts.unshift(el.tagName.toLowerCase() + '[' + idx + ']');
      el = el.parentNode;
    }
    return '/' + parts.join('/');
  };
  const escapeCSSString = (s) => {
    return String(s)
      .replace(/\\\\/g, '\\\\\\\\')
      .replace(/"/g, '\\\\"')
      .replace(/\\n/g, '\\\\n')
      .replace(/\\r/g, '\\\\r');
  };

  const computeRelativeSubselector = (ownerEl, targetEl) => {
    if (!ownerEl || !targetEl || ownerEl === targetEl) {
      return { subselector: '', stability: 'stable', isStructuralFallback: false };
    }

    // 1. Check clean class on targetEl
    const cleanClasses = Array.from(targetEl.classList || []).filter(
      (c) =>
        typeof c === 'string' &&
        !c.startsWith('antifan-') &&
        !c.includes('slick-') &&
        !c.includes('swiper-') &&
        !c.includes('active') &&
        !c.includes('hover') &&
        !/^[0-9]/.test(c)
    );

    for (const cls of cleanClasses) {
      const classSel = '.' + CSS.escape(cls);
      try {
        const matches = ownerEl.querySelectorAll(classSel);
        if (matches.length === 1 && matches[0] === targetEl) {
          return { subselector: classSel, stability: 'stable', isStructuralFallback: false };
        }
      } catch {}
    }

    // 2. Check semantic attributes on targetEl
    const subAttrs = ['setting-id', 'name', 'type', 'role', 'aria-label'];
    for (const attr of subAttrs) {
      const val = targetEl.getAttribute(attr);
      if (val && typeof val === 'string' && val.length < 80) {
        const attrSel = '[' + attr + '="' + escapeCSSString(val) + '"]';
        try {
          const matches = ownerEl.querySelectorAll(attrSel);
          if (matches.length === 1 && matches[0] === targetEl) {
            return { subselector: attrSel, stability: 'stable', isStructuralFallback: false };
          }
        } catch {}
      }
    }

    // 3. Fallback: Structural path with nth-of-type (EXPLICITLY UNSTABLE)
    const pathParts = [];
    let curr = targetEl;
    while (curr && curr !== ownerEl && curr.parentElement && pathParts.length < 6) {
      const parent = curr.parentElement;
      const tag = curr.tagName.toLowerCase();
      const siblings = Array.from(parent.children).filter((s) => s.tagName.toLowerCase() === tag);
      if (siblings.length === 1) {
        pathParts.unshift(tag);
      } else {
        const idx = siblings.indexOf(curr) + 1;
        pathParts.unshift(tag + ':nth-of-type(' + idx + ')');
      }
      curr = parent;
    }

    return {
      subselector: pathParts.join(' > '),
      stability: 'unstable-structural-fallback',
      isStructuralFallback: true,
    };
  };

  const resolveRobustElementIdentity = (el) => {
    if (!el || el.nodeType !== 1) {
      return {
        primarySelector: '',
        isUnique: false,
        isClone: false,
        isLoopItem: false,
        indexStability: 'stable',
      };
    }

    // 1. Ancestor-aware Clone Detection
    const cloneAncestor = el.closest
      ? el.closest('.slick-cloned, .swiper-slide-duplicate, [data-cloned="true"]')
      : null;
    const isClone = Boolean(cloneAncestor);

    // 2. Section Scope
    const closestSec = el.closest
      ? el.closest('section[id^="shopify-section-"], section[id^="haravan-section-"], [data-section-id], [data-section-type], section, main')
      : null;

    let sectionSelector = '';
    let sectionId = undefined;
    if (closestSec) {
      if (closestSec.id) {
        sectionSelector = '#' + CSS.escape(closestSec.id);
        sectionId = closestSec.id;
      } else if (closestSec.getAttribute('data-section-id')) {
        const secAttr = closestSec.getAttribute('data-section-id');
        sectionSelector = '[data-section-id="' + escapeCSSString(secAttr) + '"]';
        sectionId = secAttr;
      }
    }

    // 3. Find Keyed Owner Element
    const candidateAttrs = ['data-product-id', 'data-handle', 'data-variant-id', 'setting-id', 'data-block-id', 'name'];
    let keyedOwner = undefined;
    let ownerKeyAttr = undefined;
    let ownerKeyValue = undefined;

    let curr = el;
    while (curr && curr !== closestSec && curr !== document.body) {
      for (const attr of candidateAttrs) {
        const val = curr.getAttribute ? curr.getAttribute(attr) : null;
        if (val && typeof val === 'string' && val.length < 100) {
          keyedOwner = curr;
          ownerKeyAttr = attr;
          ownerKeyValue = val;
          break;
        }
      }
      if (keyedOwner) break;
      curr = curr.parentElement;
    }

    // 4. Compute Subselector
    const subResult = keyedOwner
      ? computeRelativeSubselector(keyedOwner, el)
      : { subselector: '', stability: 'stable', isStructuralFallback: false };
    const ownerQuery = keyedOwner ? '[' + ownerKeyAttr + '="' + escapeCSSString(ownerKeyValue) + '"]' : '';
    const composedParts = [sectionSelector, ownerQuery, subResult.subselector].filter(Boolean);
    const composedSelector = composedParts.join(' ').trim();

    // 6. Strict Non-Clone Canonical Evidence Resolution via candidate.closest(cloneSelector) === null
    let canonicalEvidence = {
      isClone: isClone,
      ownerKey: ownerKeyAttr,
      ownerValue: ownerKeyValue,
      relativeSubSelector: subResult.subselector,
      canonicalMatchCount: 0,
      canonicalFound: false,
      isUniqueCanonicalTarget: false,
    };

    if (keyedOwner && ownerKeyAttr && ownerKeyValue) {
      const ownerCandidateQuery = [sectionSelector, '[' + ownerKeyAttr + '="' + escapeCSSString(ownerKeyValue) + '"]'].filter(Boolean).join(' ').trim();
      try {
        const allCandidateOwners = Array.from(document.querySelectorAll(ownerCandidateQuery));
        const nonCloneOwners = allCandidateOwners.filter(
          (cand) => cand.closest('.slick-cloned, .swiper-slide-duplicate, [data-cloned="true"]') === null
        );

        if (nonCloneOwners.length === 1) {
          const canonicalOwner = nonCloneOwners[0];
          if (subResult.subselector) {
            const canonicalTargets = Array.from(canonicalOwner.querySelectorAll(subResult.subselector));
            if (canonicalTargets.length === 1) {
              canonicalEvidence.canonicalFound = true;
              canonicalEvidence.isUniqueCanonicalTarget = true;
            } else if (canonicalTargets.length > 1) {
              canonicalEvidence.canonicalFound = true;
              canonicalEvidence.isUniqueCanonicalTarget = false;
              canonicalEvidence.canonicalTargetCount = canonicalTargets.length;
            }
          } else {
            canonicalEvidence.canonicalFound = true;
            canonicalEvidence.isUniqueCanonicalTarget = true;
          }
        }
      } catch {}
    }

    // 7. Uniqueness & Match Metrics
    let isUnique = false;
    let matchCount = 1;
    let captureTimeDomIndex = undefined;

    if (composedSelector) {
      try {
        const allMatches = Array.from(document.querySelectorAll(composedSelector));
        const realMatches = allMatches.filter(
          (m) => m.closest('.slick-cloned, .swiper-slide-duplicate, [data-cloned="true"]') === null
        );

        matchCount = realMatches.length;
        isUnique = realMatches.length === 1;

        const idx = realMatches.indexOf(el);
        if (idx >= 0) captureTimeDomIndex = idx;
      } catch {}
    }

    return {
      primarySelector: composedSelector || getDomAncestry(el),
      relativeSubpath: subResult.subselector,
      relativeSubpathStability: subResult.stability,
      isStructuralFallback: subResult.isStructuralFallback,
      keyedOwnerAttr: ownerKeyAttr,
      keyedOwnerValue: ownerKeyValue,
      isUnique: isUnique,
      matchCount: matchCount,
      captureTimeDomIndex: captureTimeDomIndex,
      isClone: isClone,
      canonicalEvidence: canonicalEvidence,
      isLoopItem: matchCount > 1,
      indexStability: (matchCount > 1 || subResult.isStructuralFallback) ? 'unstable-on-rerender' : 'stable',
      sectionId: sectionId,
      businessKeys: ownerKeyAttr ? { [ownerKeyAttr]: ownerKeyValue } : {},
    };
  };

  const extractSourceHints = (el) => {
    const signals = [];
    let detectedFramework = 'unknown';
    let frameworkConfidence = 'low';
    let suggestedFile = undefined;
    let suggestedLine = undefined;
    let suggestedComponent = undefined;

    if (!el || el.nodeType !== 1) {
      return { framework: 'unknown', confidence: 'low', signals: [] };
    }

    // 1. Explicit Liquid Theme Section Marker (Shopify / Haravan)
    const closestSec = el.closest ? el.closest('section[id^="shopify-section-"], section[id^="haravan-section-"], [data-section-id], [data-section-type]') : null;
    if (closestSec) {
      const isExplicitTheme = /^shopify-section-|^haravan-section-/.test(closestSec.id || '');
      const secId = closestSec.getAttribute('data-section-id') || closestSec.id;
      const secType = closestSec.getAttribute('data-section-type');

      signals.push({
        type: 'liquid-section',
        name: 'sectionId',
        value: String(secId || '').slice(0, 100),
        confidence: isExplicitTheme ? 'high' : 'medium',
      });

      if (secType) {
        signals.push({
          type: 'liquid-section',
          name: 'sectionType',
          value: String(secType).slice(0, 100),
          confidence: isExplicitTheme ? 'high' : 'medium',
        });
      }

      if (isExplicitTheme) {
        detectedFramework = 'liquid';
        frameworkConfidence = 'high';
      }
    }
    // 2. Strict Numeric Validation for sourceLine
    const rawLine = (el.getAttribute('data-source-line') || '').trim();
    if (/^\\d+$/.test(rawLine)) {
      const parsedLine = Number(rawLine);
      if (Number.isInteger(parsedLine) && parsedLine > 0 && parsedLine <= 1000000) {
        suggestedLine = parsedLine;
        signals.push({ type: 'build-attribute', name: 'data-source-line', value: String(parsedLine), confidence: 'medium' });
      }
    }

    // 3. Build-time and Locator Attributes (Astro / Vite / Next.js / LocatorJS)
    const astroFile = el.getAttribute('data-astro-source-file') || el.closest('[data-astro-source-file]')?.getAttribute('data-astro-source-file');
    if (astroFile && typeof astroFile === 'string') {
      suggestedFile = astroFile.slice(0, 300);
      detectedFramework = 'astro';
      frameworkConfidence = 'high';
      signals.push({ type: 'build-attribute', name: 'data-astro-source-file', value: suggestedFile, confidence: 'high' });
    }

    const srcFile = el.getAttribute('data-source-file') || el.getAttribute('data-locatorjs-id') || el.closest('[data-source-file]')?.getAttribute('data-source-file');
    if (srcFile && typeof srcFile === 'string' && !suggestedFile) {
      suggestedFile = srcFile.slice(0, 300);
      signals.push({ type: 'build-attribute', name: 'data-source-file', value: suggestedFile, confidence: 'medium' });
    }

    const sourceLoc = el.getAttribute('data-source-loc') || el.closest('[data-source-loc]')?.getAttribute('data-source-loc');
    if (sourceLoc && typeof sourceLoc === 'string') {
      const locParts = sourceLoc.split(':');
      if (locParts.length >= 2) {
        if (!suggestedFile) suggestedFile = locParts[0]?.slice(0, 300);
        if (!suggestedLine && /^\\d+$/.test(locParts[1] || '')) suggestedLine = Number(locParts[1]);
        signals.push({ type: 'build-attribute', name: 'data-source-loc', value: sourceLoc.slice(0, 300), confidence: 'high' });
      }
    }

    const compName = el.getAttribute('data-component') || el.getAttribute('data-component-name') || el.closest('[data-component]')?.getAttribute('data-component');
    if (compName && typeof compName === 'string') {
      suggestedComponent = compName.slice(0, 100);
      signals.push({ type: 'dom-attribute', name: 'data-component', value: suggestedComponent, confidence: 'medium' });
    }

    // 4. React Fiber & Debug Source Detection
    try {
      const fiberKey = Object.keys(el).find((k) => k.startsWith('__reactFiber$') || k.startsWith('__reactInternalInstance$'));
      if (fiberKey && el[fiberKey]) {
        if (detectedFramework === 'unknown') {
          detectedFramework = 'react';
          frameworkConfidence = 'medium';
        }
        let curr = el[fiberKey];
        let depth = 0;
        while (curr && depth < 10) {
          if (curr._debugSource && !suggestedFile) {
            if (curr._debugSource.fileName) suggestedFile = String(curr._debugSource.fileName).slice(0, 300);
            if (curr._debugSource.lineNumber) suggestedLine = Number(curr._debugSource.lineNumber);
            frameworkConfidence = 'high';
            signals.push({ type: 'react-debug-source', name: '_debugSource', value: suggestedFile + ':' + suggestedLine, confidence: 'high' });
          }
          if (curr._debugOwner?.type?.name && !suggestedComponent) {
            suggestedComponent = String(curr._debugOwner.type.name).slice(0, 100);
            signals.push({ type: 'react-debug-owner', name: 'componentName', value: suggestedComponent, confidence: 'high' });
          } else if (typeof curr.type === 'function' && curr.type.name && !suggestedComponent) {
            suggestedComponent = String(curr.type.name).slice(0, 100);
            signals.push({ type: 'react-fiber', name: 'componentName', value: suggestedComponent, confidence: 'medium' });
          }
          curr = curr.return;
          depth++;
        }
      }
    } catch {}

    const getAttrNames = (target) => {
      if (!target || !target.attributes) return [];
      if (typeof target.attributes[Symbol.iterator] === 'function' || Array.isArray(target.attributes)) {
        return Array.from(target.attributes).map((a) => (typeof a === 'string' ? a : (a && a.name) || ''));
      }
      return Object.keys(target.attributes);
    };
    const attrNames = getAttrNames(el);

    // 5. Vue Framework Detection (__vue__, __vnode, data-v-*)
    try {
      const isVue = el.__vue__ || el.__vnode || Object.keys(el).some((k) => k.startsWith('__vueParentComponent'));
      const hasVueScopedAttr = attrNames.some((name) => typeof name === 'string' && /^data-v-[a-f0-9]+$/i.test(name));
      if (isVue || hasVueScopedAttr) {
        if (detectedFramework === 'unknown') {
          detectedFramework = 'vue';
          frameworkConfidence = hasVueScopedAttr ? 'high' : 'medium';
        }
        signals.push({ type: 'vue-component', name: 'vueSignal', value: hasVueScopedAttr ? 'scoped-css' : 'vnode', confidence: 'medium' });
      }
    } catch {}

    // 6. Svelte Framework Detection (class="svelte-*", data-svelte-*)
    try {
      const classNames = typeof el.className === 'string' ? el.className : '';
      const isSvelteClass = /svelte-[a-z0-9]+/i.test(classNames);
      const hasSvelteAttr = attrNames.some((name) => typeof name === 'string' && name.startsWith('data-svelte-'));
      if (isSvelteClass || hasSvelteAttr) {
        if (detectedFramework === 'unknown') {
          detectedFramework = 'svelte';
          frameworkConfidence = 'high';
        }
        signals.push({ type: 'svelte-component', name: 'svelteSignal', value: isSvelteClass ? 'scoped-class' : 'data-svelte', confidence: 'high' });
      }
    } catch {}
    return {
      framework: detectedFramework,
      confidence: frameworkConfidence,
      suggestedFile: suggestedFile,
      suggestedLine: suggestedLine,
      suggestedComponent: suggestedComponent,
      signals: signals,
    };
  };

  const extractBoxModel = (el, computed, rect) => {
    const parse = (v) => parseFloat(v) || 0;
    const mt = parse(computed.marginTop), mr = parse(computed.marginRight), mb = parse(computed.marginBottom), ml = parse(computed.marginLeft);
    const pt = parse(computed.paddingTop), pr = parse(computed.paddingRight), pb = parse(computed.paddingBottom), pl = parse(computed.paddingLeft);
    const bt = parse(computed.borderTopWidth), br = parse(computed.borderRightWidth), bb = parse(computed.borderBottomWidth), bl = parse(computed.borderLeftWidth);

    return {
      margin: { top: mt, right: mr, bottom: mb, left: ml },
      padding: { top: pt, right: pr, bottom: pb, left: pl },
      border: { top: bt, right: br, bottom: bb, left: bl },
      content: {
        width: Math.max(0, Math.round(rect.width - (pl + pr + bl + br))),
        height: Math.max(0, Math.round(rect.height - (pt + pb + bt + bb))),
      },
    };
  };

  const extractParentLayout = (el) => {
    const parent = el.parentElement;
    if (!parent || parent === document.documentElement) return undefined;
    try {
      const pComp = window.getComputedStyle(parent);
      const display = pComp.display || 'block';
      return {
        tag: parent.tagName.toLowerCase(),
        selector: parent.id ? '#' + parent.id : (parent.className && typeof parent.className === 'string' ? '.' + parent.className.trim().split(/\\s+/)[0] : parent.tagName.toLowerCase()),
        display: display,
        flexDirection: display.includes('flex') ? pComp.flexDirection : undefined,
        gap: (display.includes('flex') || display.includes('grid')) ? pComp.gap : undefined,
        gridTemplateColumns: display.includes('grid') ? pComp.gridTemplateColumns : undefined,
      };
    } catch {
      return undefined;
    }
  };

  const extractSiblingSemantics = (el) => {
    const parent = el.parentElement;
    if (!parent) return [];
    const siblings = Array.from(parent.children).slice(0, 6);
    return siblings.map((sib) => ({
      tag: sib.tagName.toLowerCase(),
      role: sib.getAttribute('role') || undefined,
      textSnippet: (sib.textContent || '').trim().slice(0, 50),
      isTarget: sib === el,
    }));
  };

  const overlay = document.createElement('div');
  overlay.id = OVERLAY_ID;
  overlay.style.cssText = 'position:fixed !important;pointer-events:none !important;z-index:2147483646 !important;box-sizing:border-box !important;border:2px solid #087ff5 !important;background-color:rgba(8,127,245,0.15) !important;display:none;transition:none !important;';

  const badge = document.createElement('div');
  badge.id = BADGE_ID;
  badge.style.cssText = 'position:fixed !important;pointer-events:none !important;z-index:2147483647 !important;box-sizing:border-box !important;background:#090d16 !important;color:#38bdf8 !important;border:1px solid rgba(56,189,248,0.5) !important;border-radius:4px !important;padding:2px 6px !important;font:11px/14px monospace !important;box-shadow:0 4px 12px rgba(0,0,0,0.5) !important;display:none;white-space:nowrap !important;';

  const container = document.documentElement || document.body;
  if (container) {
    container.appendChild(overlay);
    container.appendChild(badge);
  }
  const updateMultiDock = () => {
    let dock = document.getElementById(MULTI_BAR_ID);
    if (pickedList.length === 0) {
      if (dock) dock.remove();
      return;
    }
    if (!dock) {
      dock = document.createElement('div');
      dock.id = MULTI_BAR_ID;
      dock.style.cssText = 'position:fixed;bottom:20px;left:50%;transform:translateX(-50%);z-index:2147483647;background:rgba(18,24,38,0.95);border:1px solid #38bdf8;border-radius:24px;padding:6px 14px;box-shadow:0 8px 30px rgba(0,0,0,0.6);display:flex;align-items:center;gap:12px;color:#fff;font-family:-apple-system,sans-serif;font-size:12px;backdrop-filter:blur(8px);';
      document.body.appendChild(dock);
    }
    dock.innerHTML = '<span style="font-weight:600;color:#38bdf8;">✨ ' + pickedList.length + ' element' + (pickedList.length > 1 ? 's' : '') + ' selected</span><div style="display:flex;align-items:center;gap:6px;"><button id="btnMultiQueue" style="background:#1e293b;border:1px solid #334155;color:#e2e8f0;border-radius:14px;padding:4px 10px;font-size:11px;font-weight:600;cursor:pointer;" title="Đưa vào hàng đợi / bản nháp (không chạy ngay)">Queue All</button><button id="btnMultiSubmit" style="background:#087ff5;border:none;color:#fff;border-radius:14px;padding:4px 12px;font-size:11px;font-weight:600;cursor:pointer;" title="Gửi và thực thi ngay">Send All ↑</button><button id="btnMultiCancel" style="background:transparent;border:none;color:#94a3b8;font-size:11px;cursor:pointer;">Cancel</button></div>';

    const submitMulti = (mode) => {
      if (pickedList.length > 0) {
        const first = pickedList[0];
        const combinedComment = pickedList.map((p, idx) => '[' + (idx + 1) + '] ' + p.selector + ': ' + (p.userComment || 'Check this element')).join('\\n\\n');
        window.__antifanPick = Object.assign({}, first, {
          userComment: combinedComment,
          multiItems: pickedList,
          deliveryMode: mode || 'auto',
        });
      }
      cleanup();
    };

    const multiQueueBtn = dock.querySelector('#btnMultiQueue');
    if (multiQueueBtn) multiQueueBtn.onclick = () => submitMulti('draft');
    const multiSubmitBtn = dock.querySelector('#btnMultiSubmit');
    if (multiSubmitBtn) multiSubmitBtn.onclick = () => submitMulti('auto');

    dock.querySelector('#btnMultiCancel').onclick = () => {
      cleanup();
      window.__antifanPick = { canceled: true };
    };
  };

  const resolveElementFromEvent = (e) => {
    let clientX = e.clientX;
    let clientY = e.clientY;
    if ((clientX === undefined || clientY === undefined) && e.touches && e.touches.length > 0) {
      clientX = e.touches[0].clientX;
      clientY = e.touches[0].clientY;
    } else if ((clientX === undefined || clientY === undefined) && e.changedTouches && e.changedTouches.length > 0) {
      clientX = e.changedTouches[0].clientX;
      clientY = e.changedTouches[0].clientY;
    }

    let el = null;
    if (typeof clientX === 'number' && typeof clientY === 'number') {
      try {
        const hit = document.elementFromPoint(clientX, clientY);
        if (hit && hit.id !== OVERLAY_ID && hit.id !== BADGE_ID && hit.id !== MULTI_BAR_ID && !hit.closest?.('#' + MODAL_ID) && !hit.closest?.('#' + MULTI_BAR_ID)) {
          el = hit;
        }
      } catch {}
    }

    if (!el) {
      const path = (e.composedPath && typeof e.composedPath === 'function') ? e.composedPath() : [];
      for (let i = 0; i < path.length; i++) {
        const node = path[i];
        if (node && node.nodeType === 1) {
          if (node.id === OVERLAY_ID || node.id === BADGE_ID || node.id === MULTI_BAR_ID || node.closest?.('#' + MODAL_ID) || node.closest?.('#' + MULTI_BAR_ID)) continue;
          el = node;
          break;
        }
      }
    }

    if (!el && e.target && e.target.nodeType === 1) {
      el = e.target;
    }

    if (el && (el.id === OVERLAY_ID || el.id === BADGE_ID || el.id === MULTI_BAR_ID || el.closest?.('#' + MODAL_ID) || el.closest?.('#' + MULTI_BAR_ID))) {
      return null;
    }
    return el;
  };

  const onHover = (e) => {
    if (isModalOpen) return;
    const el = resolveElementFromEvent(e);
    if (!el) return;

    currentTarget = el;
    const r = el.getBoundingClientRect();
    if (r.width === 0 && r.height === 0) return;

    overlay.style.display = 'block';
    overlay.style.top = r.top + 'px';
    overlay.style.left = r.left + 'px';
    overlay.style.width = r.width + 'px';
    overlay.style.height = r.height + 'px';

    let tag = el.tagName.toLowerCase();
    if (el.id) tag += '#' + el.id;
    else if (el.className && typeof el.className === 'string') {
      const cls = el.className.trim().split(/\\s+/).filter(Boolean)[0];
      if (cls && !cls.includes(':')) tag += '.' + cls;
    }
    badge.textContent = tag + ' (' + Math.round(r.width) + '×' + Math.round(r.height) + ')';
    badge.style.display = 'block';
    badge.style.top = Math.max(2, r.top - 22) + 'px';
    badge.style.left = Math.max(2, r.left) + 'px';
  };

  const showCommentModal = (el) => {
    isModalOpen = true;
    overlay.style.display = 'block';
    badge.style.display = 'none';

    const modal = document.createElement('div');
    modal.id = MODAL_ID;
    modal.style.cssText = 'position:fixed;z-index:2147483647;box-sizing:border-box;background:#0b111b;color:#e5eef8;border:1px solid #2c6d98;border-radius:10px;padding:10px 11px;box-shadow:0 14px 36px rgba(0,0,0,0.72),0 0 0 1px rgba(88,180,232,.08);width:310px;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;font-size:12px;display:flex;flex-direction:column;gap:8px;';

    const r = el.getBoundingClientRect();
    let top = r.bottom + 6;
    let left = r.left;
    if (top + 170 > window.innerHeight) top = Math.max(10, r.top - 180);
    if (left + 310 > window.innerWidth) left = Math.max(10, window.innerWidth - 320);
    modal.style.top = Math.max(10, top) + 'px';
    modal.style.left = Math.max(10, left) + 'px';

    const selectorName = el.id ? '#' + el.id : (el.className && typeof el.className === 'string' ? el.tagName.toLowerCase() + '.' + el.className.trim().split(/\s+/).filter(Boolean)[0] : el.tagName.toLowerCase());

    const header = document.createElement('div');
    header.style.cssText = 'display:flex;align-items:center;justify-content:space-between;font-size:11px;color:#94a3b8;border-bottom:1px solid #203246;padding-bottom:6px;';
    header.innerHTML = '<span style="font-weight:600;color:#38bdf8;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:200px;">' + selectorName + '</span><button type="button" id="btnModalClose" style="background:transparent;border:none;color:#94a3b8;font-size:11px;cursor:pointer;padding:2px 4px;display:flex;align-items:center;gap:3px;border-radius:3px;" title="Hủy (Esc)"><span style="font-size:9.5px;color:#71717a;">Esc hủy</span> <span style="font-weight:bold;color:#ef4444;">✕</span></button>';
    const closeBtn = header.querySelector('#btnModalClose');
    if (closeBtn) {
      closeBtn.onclick = (e) => {
        prevent(e);
        cleanupModalListeners();
        modal.remove();
        isModalOpen = false;
        if (pickedList.length === 0) {
          cleanup();
          window.__antifanPick = { canceled: true };
        }
      };
    }
    const termContext = window.__antifanTerminalContext || { sessions: [], selectedSessionId: '' };
    const termRow = document.createElement('div');
    termRow.style.cssText = 'display:flex;align-items:center;justify-content:space-between;gap:6px;background:#060a11;border:1px solid #1e293b;border-radius:5px;padding:3px 7px;font-size:11px;box-sizing:border-box;';

    const termLabel = document.createElement('div');
    termLabel.style.cssText = 'display:flex;align-items:center;gap:4px;color:#94a3b8;flex-shrink:0;';
    termLabel.innerHTML = '<span style="font-size:11px;">🎯</span><span style="font-weight:600;color:#cbd5e1;">Gửi tới:</span>';

    const termSelect = document.createElement('select');
    termSelect.id = 'antifanTerminalSelect';
    termSelect.style.cssText = 'flex:1;min-width:0;background:#0f172a;color:#38bdf8;border:1px solid #263b50;border-radius:4px;padding:2px 4px;font-size:11px;font-weight:500;outline:none;cursor:pointer;text-overflow:ellipsis;';

    if (termContext.sessions && termContext.sessions.length > 0) {
      const autoOpt = document.createElement('option');
      autoOpt.value = 'auto';
      autoOpt.textContent = 'Tự động (theo site URL)';
      autoOpt.selected = true;
      termSelect.appendChild(autoOpt);
      termContext.sessions.forEach((s) => {
        const opt = document.createElement('option');
        opt.value = s.id;
        const cleanCwd = (s.cwd || '').replace(/\\\\/g, '/');
        const folder = cleanCwd ? cleanCwd.split('/').filter(Boolean).pop() : '';
        opt.textContent = (s.name || s.id) + (folder ? ' (' + folder + ')' : '');
        termSelect.appendChild(opt);
      });
    } else {
      const opt = document.createElement('option');
      opt.value = '';
      opt.textContent = 'Terminal hiện tại (Active)';
      termSelect.appendChild(opt);
    }

    termRow.appendChild(termLabel);
    termRow.appendChild(termSelect);
    const textarea = document.createElement('textarea');
    textarea.placeholder = 'Nhập mô tả / yêu cầu sửa... (hoặc dán Ctrl+V ảnh vào đây)';
    textarea.style.cssText = 'width:100%;height:58px;min-height:58px;max-height:200px;background:#060a11;border:1px solid #263b50;border-radius:4px;color:#f8fafc;padding:8px;font-size:11.5px;font-family:inherit;outline:none;resize:none;box-sizing:border-box;line-height:1.4;overflow-y:auto;';

    const attachedImages = [];
    const previewContainer = document.createElement('div');
    previewContainer.style.cssText = 'display:none;flex-wrap:wrap;gap:6px;padding:4px 0;max-height:100px;overflow-y:auto;';

    const renderPreviews = () => {
      previewContainer.innerHTML = '';
      if (attachedImages.length === 0) {
        previewContainer.style.display = 'none';
        return;
      }
      previewContainer.style.display = 'flex';
      attachedImages.forEach((img, idx) => {
        const item = document.createElement('div');
        item.style.cssText = 'position:relative;width:46px;height:46px;border-radius:4px;border:1px solid #38bdf8;overflow:hidden;background:#0f172a;flex-shrink:0;';
        item.innerHTML = '<img src="' + img.dataUrl + '" style="width:100%;height:100%;object-fit:cover;" title="' + (img.name || 'Ảnh') + '" /><button type="button" style="position:absolute;top:1px;right:1px;background:rgba(0,0,0,0.7);color:#ef4444;border:none;border-radius:50%;width:14px;height:14px;font:bold 9px sans-serif;cursor:pointer;display:flex;align-items:center;justify-content:center;padding:0;">✕</button>';
        const delBtn = item.querySelector('button');
        if (delBtn) {
          delBtn.onclick = (e) => {
            e.stopPropagation();
            attachedImages.splice(idx, 1);
            renderPreviews();
          };
        }
        previewContainer.appendChild(item);
      });
    };

    const addImage = (name, dataUrl) => {
      if (!dataUrl) return;
      attachedImages.push({ name: name || ('image_' + (attachedImages.length + 1) + '.png'), dataUrl: dataUrl });
      renderPreviews();
      if (statusMsg.style.display !== 'none') statusMsg.style.display = 'none';
    };

    const fileInput = document.createElement('input');
    fileInput.type = 'file';
    fileInput.accept = 'image/*';
    fileInput.multiple = true;
    fileInput.style.display = 'none';
    fileInput.onchange = (e) => {
      const files = (e.target && e.target.files) ? Array.from(e.target.files) : [];
      files.forEach((file) => {
        const reader = new FileReader();
        reader.onload = (ev) => {
          if (ev.target && typeof ev.target.result === 'string') {
            addImage(file.name, ev.target.result);
          }
        };
        reader.readAsDataURL(file);
      });
      fileInput.value = '';
    };

    const statusMsg = document.createElement('div');
    statusMsg.id = 'statusMsg';
    statusMsg.style.cssText = 'display:none;color:#ef4444;font-size:10.5px;padding-top:2px;line-height:1.2;font-weight:500;';

    const footer = document.createElement('div');
    footer.style.cssText = 'display:flex;align-items:center;justify-content:space-between;padding-top:1px;';
    footer.innerHTML = '<div style="display:flex;align-items:center;gap:6px;"><button id="btnAttachImg" type="button" style="background:#1e293b;border:1px solid #334155;color:#94a3b8;border-radius:4px;padding:3px 7px;font-size:11px;cursor:pointer;display:flex;align-items:center;gap:4px;" title="Đính kèm ảnh từ máy tính"><span>📷</span> <span>Ảnh</span></button><span style="font-size:9.5px;color:#64748b;">Dán Ctrl+V ảnh</span></div><div style="display:flex;align-items:center;gap:6px;"><button id="btnModalQueue" type="button" style="background:#1e293b;border:1px solid #334155;color:#e2e8f0;border-radius:4px;padding:4px 9px;font-size:11px;font-weight:600;cursor:pointer;display:flex;align-items:center;gap:3px;" title="Đưa vào Queue / Draft (Không thực thi ngay)"><span>📥</span> <span>Queue</span></button><button id="btnModalSend" type="button" style="background:#087ff5;border:none;color:#ffffff;border-radius:4px;padding:4px 12px;font-size:11px;font-weight:600;cursor:pointer;" title="Gửi và thực thi ngay">Gửi ↑</button></div>';
    modal.appendChild(header);
    modal.appendChild(termRow);
    modal.appendChild(textarea);
    modal.appendChild(previewContainer);
    modal.appendChild(fileInput);
    modal.appendChild(statusMsg);
    modal.appendChild(footer);
    const targetParent = document.body || document.documentElement;
    targetParent.appendChild(modal);
    textarea.focus();
    textarea.addEventListener('input', () => { textarea.style.height = '58px'; textarea.style.height = Math.min(200, Math.max(58, textarea.scrollHeight)) + 'px'; });

    const btnAttach = modal.querySelector('#btnAttachImg');
    if (btnAttach) {
      btnAttach.onclick = () => fileInput.click();
    }

    // Helper function to process any image blob or file
    const processImageFile = (fileOrBlob, defaultName) => {
      if (!fileOrBlob) return;
      const reader = new FileReader();
      reader.onload = (e) => {
        if (e.target && typeof e.target.result === 'string') {
          addImage(fileOrBlob.name || defaultName || ('image_' + (attachedImages.length + 1) + '.png'), e.target.result);
        }
      };
      reader.readAsDataURL(fileOrBlob);
    };

    // Robust Clipboard Paste Handler (handles items, files, and HTML img tags)
    const handlePasteData = (clipboardData, ev) => {
      if (!clipboardData) return false;
      let handled = false;

      // 1. Check clipboard items (blobs / images / files)
      const items = clipboardData.items;
      if (items && items.length > 0) {
        for (let i = 0; i < items.length; i++) {
          const item = items[i];
          if (item.type && item.type.startsWith('image/')) {
            const blob = item.getAsFile();
            if (blob) {
              processImageFile(blob, 'pasted_image_' + (attachedImages.length + 1) + '.png');
              handled = true;
              break;
            }
          } else if (item.kind === 'file') {
            const file = item.getAsFile();
            if (file && (file.type.startsWith('image/') || /\\.(png|jpe?g|webp|gif|svg|bmp|ico|avif)$/i.test(file.name))) {
              processImageFile(file, file.name);
              handled = true;
              break;
            }
          }
        }
      }

      // 2. Check clipboard files ONLY if not already handled by items
      if (!handled) {
        const files = clipboardData.files;
        if (files && files.length > 0) {
          for (let i = 0; i < files.length; i++) {
            const file = files[i];
            if (file && (file.type.startsWith('image/') || /\\.(png|jpe?g|webp|gif|svg|bmp|ico|avif)$/i.test(file.name))) {
              processImageFile(file, file.name);
              handled = true;
              break;
            }
          }
        }
      }

      // 3. Check HTML content for embedded <img> data URLs
      if (!handled) {
        const html = clipboardData.getData('text/html');
        if (html) {
          const match = html.match(/<img[^>]+src=["'](data:image\\/[^"']+)["']/i);
          if (match && match[1]) {
            addImage('pasted_image_' + (attachedImages.length + 1) + '.png', match[1]);
            handled = true;
          }
        }
      }

      if (handled && ev) {
        ev.preventDefault();
        ev.stopPropagation();
      }
      return handled;
    };

    const onGlobalPaste = (ev) => {
      if (!isModalOpen) return;
      const cb = ev.clipboardData || window.clipboardData;
      handlePasteData(cb, ev);
    };

    // Global keydown handler for modal: Escape dismiss
    const onGlobalKeyDown = (ev) => {
      if (!isModalOpen) return;
      if (ev.key === 'Escape') {
        prevent(ev);
        cleanupModalListeners();
        modal.remove();
        isModalOpen = false;
        if (pickedList.length === 0) {
          cleanup();
          window.__antifanPick = { canceled: true };
        }
        return;
      }
    };

    window.addEventListener('paste', onGlobalPaste, true);
    window.addEventListener('keydown', onGlobalKeyDown, true);

    const cleanupModalListeners = () => {
      window.removeEventListener('paste', onGlobalPaste, true);
      window.removeEventListener('keydown', onGlobalKeyDown, true);
    };

    // Drag & Drop image files onto modal
    modal.addEventListener('dragover', (e) => { e.preventDefault(); modal.style.borderColor = '#38bdf8'; });
    modal.addEventListener('dragleave', () => { modal.style.borderColor = '#2c6d98'; });
    modal.addEventListener('drop', (e) => {
      e.preventDefault();
      modal.style.borderColor = '#2c6d98';
      if (e.dataTransfer && e.dataTransfer.files) {
        Array.from(e.dataTransfer.files).forEach((file) => {
          if (file.type && (file.type.startsWith('image/') || /\\.(png|jpe?g|webp|gif|svg|bmp|ico|avif)$/i.test(file.name))) {
            processImageFile(file, file.name);
          }
        });
      }
    });

    textarea.oninput = () => {
      if (statusMsg.style.display !== 'none') {
        statusMsg.style.display = 'none';
      }
    };

    const doSubmit = (mode = 'auto') => {
      const deliveryMode = mode === 'draft' ? 'draft' : 'auto';
      let userComment = textarea.value.trim();
      if (!userComment && attachedImages.length === 0) {
        statusMsg.textContent = 'Vui lòng nhập mô tả hoặc đính kèm ảnh trước khi gửi.';
        statusMsg.style.display = 'block';
        textarea.focus();
        return;
      }
      if (!userComment && attachedImages.length > 0) {
        userComment = 'Kiểm tra phần tử này theo ảnh đính kèm.';
      }
      statusMsg.style.display = 'none';

      const submitBtn = modal.querySelector('#btnModalSend');
      const queueBtn = modal.querySelector('#btnModalQueue');
      if (deliveryMode === 'draft') {
        if (queueBtn) {
          queueBtn.textContent = 'Đang lưu...';
          queueBtn.style.opacity = '0.7';
        }
      } else {
        if (submitBtn) {
          submitBtn.textContent = 'Đang gửi...';
          submitBtn.style.opacity = '0.7';
        }
      }
      try {
        // 1. Re-measure fresh rect on submit to eliminate any scroll/layout drift
        const freshRect = el.getBoundingClientRect ? el.getBoundingClientRect() : { left: 0, top: 0, width: 0, height: 0 };
        const computed = window.getComputedStyle ? window.getComputedStyle(el) : {};

        const pruneOuterHtml = (html) => {
          if (!html || typeof html !== 'string') return '';
          let res = html.replace(/d="[^"]{60,}"/gi, 'd="[svg-path-data]"');
          res = res.replace(/src="data:image\\/[^;]+;base64,[^"]{60,}"/gi, 'src="data:[image-base64]"');
          return res.slice(0, 8000);
        };

        let liquidContext = {};
        try {
          const closestSec = el.closest ? el.closest('[data-section-id], [data-section-type], section[id^="shopify-section-"], section[id^="haravan-section-"], [id^="shopify-section-"]') : null;
          liquidContext = {
            sectionId: closestSec ? (closestSec.getAttribute('data-section-id') || closestSec.id) : undefined,
            sectionType: closestSec ? closestSec.getAttribute('data-section-type') : undefined,
            productId: el.getAttribute ? (el.getAttribute('data-product-id') || el.closest('[data-product-id]')?.getAttribute('data-product-id')) : undefined,
            variantId: el.getAttribute ? (el.getAttribute('data-variant-id') || el.closest('[data-variant-id]')?.getAttribute('data-variant-id')) : undefined,
            settingId: el.getAttribute ? (el.getAttribute('setting-id') || el.closest('[setting-id]')?.getAttribute('setting-id')) : undefined,
          };
        } catch {}

        const styles = {
          fontFamily: computed.fontFamily || '',
          fontSize: computed.fontSize || '',
          fontWeight: computed.fontWeight || '',
          color: computed.color || '',
          backgroundColor: computed.backgroundColor || '',
          display: computed.display || '',
          position: computed.position || '',
          padding: computed.padding || '',
          margin: computed.margin || '',
          width: computed.width || '',
          height: computed.height || '',
        };

        const robustIdentity = resolveRobustElementIdentity(el);
        const sourceHints = extractSourceHints(el);
        const boxModel = extractBoxModel(el, computed, freshRect);
        const parentLayout = extractParentLayout(el);
        const siblingSemantics = extractSiblingSemantics(el);

        const pickedItem = {
          tag: (el.tagName || 'div').toLowerCase(),
          tagName: (el.tagName || 'div').toLowerCase(),
          id: el.id || undefined,
          classes: Array.from(el.classList || []),
          textSnippet: (el.textContent || '').trim().slice(0, 120),
          textContent: (el.textContent || '').trim().slice(0, 1500),
          xpath: getXPath(el),
          selector: robustIdentity.primarySelector,
          isUnique: robustIdentity.isUnique,
          matchCount: robustIdentity.matchCount,
          captureTimeDomIndex: robustIdentity.captureTimeDomIndex,
          isClone: robustIdentity.isClone,
          canonicalEvidence: robustIdentity.canonicalEvidence,
          relativeSubpath: robustIdentity.relativeSubpath,
          relativeSubpathStability: robustIdentity.relativeSubpathStability,
          isLoopItem: robustIdentity.isLoopItem,
          indexStability: robustIdentity.indexStability,
          sourceHints: sourceHints,
          boxModel: boxModel,
          parentLayout: parentLayout,
          siblingSemantics: siblingSemantics,
          domAncestry: getDomAncestry(el),
          dimensions: Math.round(freshRect.width) + ' x ' + Math.round(freshRect.height) + ' px',
          outerHTML: pruneOuterHtml(el.outerHTML || ''),
          liquidContext: liquidContext,
          computedStyles: styles,
          userComment: userComment,
          targetSessionId: termSelect ? termSelect.value : (termContext.selectedSessionId || undefined),
          attachedImages: attachedImages.slice(0, 6),
          deliveryMode: deliveryMode,
          rect: {
            x: Math.round(freshRect.left + window.scrollX),
            y: Math.round(freshRect.top + window.scrollY),
            width: Math.round(freshRect.width),
            height: Math.round(freshRect.height),
          },
          clientRect: {
            x: Math.round(freshRect.left),
            y: Math.round(freshRect.top),
            width: Math.round(freshRect.width),
            height: Math.round(freshRect.height),
          },
          position: {
            x: Math.round(freshRect.left),
            y: Math.round(freshRect.top),
            width: Math.round(freshRect.width),
            height: Math.round(freshRect.height),
            scrollX: Math.round(window.scrollX || window.pageXOffset || 0),
            scrollY: Math.round(window.scrollY || window.pageYOffset || 0),
          },
          viewport: {
            width: window.innerWidth || document.documentElement.clientWidth || 0,
            height: window.innerHeight || document.documentElement.clientHeight || 0,
            devicePixelRatio: window.devicePixelRatio || 1,
            scrollX: Math.round(window.scrollX || window.pageXOffset || 0),
            scrollY: Math.round(window.scrollY || window.pageYOffset || 0),
            screenWidth: window.screen ? window.screen.width : 0,
            screenHeight: window.screen ? window.screen.height : 0,
            colorDepth: window.screen ? window.screen.colorDepth : 24,
            orientation: window.screen?.orientation?.type || (window.innerWidth > window.innerHeight ? 'landscape-primary' : 'portrait-primary'),
            userAgent: navigator.userAgent,
          },
          interactionState: {
            hovered: false,
            focused: document.activeElement === el,
            disabled: !!(el.disabled || (el.getAttribute && el.getAttribute('disabled'))),
            ariaExpanded: el.getAttribute ? el.getAttribute('aria-expanded') : null,
            ariaSelected: el.getAttribute ? el.getAttribute('aria-selected') : null,
            ariaChecked: el.getAttribute ? el.getAttribute('aria-checked') : null,
            visibility: computed.visibility || '',
            display: computed.display || '',
            opacity: computed.opacity || '',
            zIndex: computed.zIndex || '',
          },
          accessibilitySnapshot: {
            role: (el.getAttribute && el.getAttribute('role')) || (el.tagName || '').toLowerCase(),
            ariaLabel: (el.getAttribute && (el.getAttribute('aria-label') || el.getAttribute('title'))) || undefined,
            ariaDescribedBy: (el.getAttribute && el.getAttribute('aria-describedby')) || undefined,
            tabIndex: el.tabIndex || 0,
            disabled: !!(el.disabled || (el.getAttribute && el.getAttribute('disabled'))),
          },
          timestamp: Date.now(),
        };

        if (isMultiMode) {
          pickedList.push(pickedItem);
          const pin = document.createElement('div');
          pin.className = PIN_CLASS;
          pin.style.cssText = 'position:fixed;z-index:2147483645;background:#087ff5;color:#fff;border-radius:50%;width:20px;height:20px;display:flex;align-items:center;justify-content:center;font:bold 11px sans-serif;box-shadow:0 2px 6px rgba(0,0,0,0.5);pointer-events:none;';
          pin.textContent = String(pickedList.length);
          pin.style.top = Math.max(0, freshRect.top - 10) + 'px';
          pin.style.left = Math.max(0, freshRect.left - 10) + 'px';
          (document.documentElement || document.body).appendChild(pin);
          cleanupModalListeners();
          try { modal.remove(); } catch {}
          isModalOpen = false;
          updateMultiDock();
        } else {
          cleanupModalListeners();
          try { modal.remove(); } catch {}
          cleanup();
          window.__antifanPick = pickedItem;
        }
      } catch (err) {
        console.error('[antifan-inspect] doSubmit error:', err);
        try {
          cleanupModalListeners();
          try { modal.remove(); } catch {}
          cleanup();
          window.__antifanPick = {
            selector: el.tagName ? el.tagName.toLowerCase() : 'div',
            userComment: userComment,
            targetSessionId: termSelect ? termSelect.value : undefined,
            attachedImages: attachedImages.slice(0, 6),
            deliveryMode: deliveryMode,
            timestamp: Date.now(),
          };
        } catch {}
      }
    };

    const queueBtn = modal.querySelector('#btnModalQueue');
    if (queueBtn) {
      queueBtn.onclick = (ev) => {
        if (ev) {
          ev.preventDefault();
          ev.stopPropagation();
        }
        doSubmit('draft');
      };
      queueBtn.onpointerdown = (ev) => {
        if (ev) ev.stopPropagation();
      };
    }
    const sendBtn = modal.querySelector('#btnModalSend');
    if (sendBtn) {
      sendBtn.onclick = (ev) => {
        if (ev) {
          ev.preventDefault();
          ev.stopPropagation();
        }
        doSubmit('auto');
      };
      sendBtn.onpointerdown = (ev) => {
        if (ev) ev.stopPropagation();
      };
    }
    textarea.onkeydown = (ev) => {
      if (ev.key === 'Enter' && (ev.ctrlKey || ev.metaKey)) {
        ev.preventDefault();
        doSubmit('auto');
      } else if (ev.key === 'Enter' && ev.altKey) {
        ev.preventDefault();
        doSubmit('draft');
      } else if (ev.key === 'Enter' && !ev.shiftKey) {
        ev.preventDefault();
        doSubmit('auto');
      } else if (ev.key === 'Escape') {
        ev.preventDefault();
        cleanupModalListeners();
        modal.remove();
        isModalOpen = false;
        if (pickedList.length === 0) {
          cleanup();
          window.__antifanPick = { canceled: true };
        }
      }
    };
  };
  const onClick = (e) => {
    if (isInteractiveUiEvent(e)) {
      return;
    }
    prevent(e);
    if (isModalOpen) return;
    const path = (e.composedPath && typeof e.composedPath === 'function') ? e.composedPath() : [];
    let el = currentTarget;
    if (!el) {
      for (let i = 0; i < path.length; i++) {
        const node = path[i];
        if (node && node.nodeType === 1) {
          if (node.id === OVERLAY_ID || node.id === BADGE_ID || node.id === MULTI_BAR_ID || node.id === MODAL_ID || (node.closest && (node.closest('#' + MODAL_ID) || node.closest('#' + MULTI_BAR_ID)))) continue;
          el = node;
          break;
        }
      }
    }
    if (!el) el = (e.target && e.target.nodeType === 1 ? e.target : document.body);
    showCommentModal(el);
  };

  const onPointerDown = (e) => {
    if (isInteractiveUiEvent(e) || isModalOpen) return;
    const el = resolveElementFromEvent(e);
    if (el) currentTarget = el;
  };

  const onPointerUp = (e) => {
    if (isInteractiveUiEvent(e) || isModalOpen) return;
    if (e.pointerType === 'touch' || e.pointerType === 'pen') {
      const el = resolveElementFromEvent(e);
      if (el) {
        currentTarget = el;
        onClick(e);
      }
    }
  };

  const onTouchStart = (e) => {
    if (isInteractiveUiEvent(e) || isModalOpen) return;
    onHover(e);
  };

  const onTouchMove = (e) => {
    if (isInteractiveUiEvent(e) || isModalOpen) return;
    onHover(e);
  };

  const onTouchEnd = (e) => {
    if (isInteractiveUiEvent(e) || isModalOpen) return;
    const el = resolveElementFromEvent(e);
    if (el) {
      currentTarget = el;
      onClick(e);
    }
  };

  window.addEventListener('mousemove', onHover, true);
  window.addEventListener('pointermove', onHover, true);
  window.addEventListener('pointerdown', onPointerDown, true);
  window.addEventListener('pointerup', onPointerUp, true);
  window.addEventListener('touchmove', onTouchMove, { capture: true, passive: true });
  window.addEventListener('touchstart', onTouchStart, { capture: true, passive: true });
  window.addEventListener('touchend', onTouchEnd, true);
  window.addEventListener('click', onClick, true);
  window.addEventListener('keydown', onKey, true);
  if (document.documentElement) document.documentElement.style.cursor = 'crosshair';
})();`;

export interface RelativeSubselectorResult {
  subselector: string;
  stability: 'stable' | 'unstable-structural-fallback';
  isStructuralFallback: boolean;
}

export const escapeCSS = (s: string): string => {
  if (typeof CSS !== 'undefined' && typeof CSS.escape === 'function') {
    return CSS.escape(s);
  }
  return String(s).replace(/([!"#$%&'()*+,.\/:;<=>?@[\\\]^`{|}~])/g, '\\$1');
};

export const escapeCSSString = (s: string): string => {
  return String(s)
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\n/g, '\\n')
    .replace(/\r/g, '\\r');
};
export function computeRelativeSubselectorTS(ownerEl: any, targetEl: any): RelativeSubselectorResult {
  if (!ownerEl || !targetEl || ownerEl === targetEl) {
    return { subselector: '', stability: 'stable', isStructuralFallback: false };
  }

  const cleanClasses: string[] = Array.from(targetEl.classList || [])
    .filter(
      (c: any): c is string =>
        typeof c === 'string' &&
        !c.startsWith('antifan-') &&
        !c.includes('slick-') &&
        !c.includes('swiper-') &&
        !c.includes('active') &&
        !c.includes('hover') &&
        !/^[0-9]/.test(c)
    );

  for (const cls of cleanClasses) {
    const classSel = '.' + escapeCSS(cls);
    try {
      const matches = ownerEl.querySelectorAll(classSel);
      if (matches.length === 1 && matches[0] === targetEl) {
        return { subselector: classSel, stability: 'stable', isStructuralFallback: false };
      }
    } catch {}
  }

  const subAttrs = ['setting-id', 'name', 'type', 'role', 'aria-label'];
  for (const attr of subAttrs) {
    const val = targetEl.getAttribute ? targetEl.getAttribute(attr) : null;
    if (val && typeof val === 'string' && val.length < 80) {
      const attrSel = '[' + attr + '="' + escapeCSSString(val) + '"]';
      try {
        const matches = ownerEl.querySelectorAll(attrSel);
        if (matches.length === 1 && matches[0] === targetEl) {
          return { subselector: attrSel, stability: 'stable', isStructuralFallback: false };
        }
      } catch {}
    }
  }

  const pathParts: string[] = [];
  let curr = targetEl;
  while (curr && curr !== ownerEl && curr.parentElement && pathParts.length < 6) {
    const parent = curr.parentElement;
    const tag = curr.tagName.toLowerCase();
    const siblings = Array.from(parent.children || []).filter((s: any) => s.tagName.toLowerCase() === tag);
    if (siblings.length === 1) {
      pathParts.unshift(tag);
    } else {
      const idx = siblings.indexOf(curr) + 1;
      pathParts.unshift(tag + ':nth-of-type(' + idx + ')');
    }
    curr = parent;
  }

  return {
    subselector: pathParts.join(' > '),
    stability: 'unstable-structural-fallback',
    isStructuralFallback: true,
  };
}

export function resolveRobustElementIdentityTS(el: any, rootDocument?: any): any {
  if (!el || el.nodeType !== 1) {
    return { primarySelector: '', isUnique: false, isClone: false, isLoopItem: false, indexStability: 'stable' };
  }
  const doc = rootDocument || (typeof document !== 'undefined' ? document : null);
  const cloneAncestor = el.closest ? el.closest('.slick-cloned, .swiper-slide-duplicate, [data-cloned="true"]') : null;
  const isClone = Boolean(cloneAncestor);

  const closestSec = el.closest
    ? el.closest('section[id^="shopify-section-"], section[id^="haravan-section-"], [data-section-id], [data-section-type], section, main')
    : null;

  let sectionSelector = '';
  let sectionId = undefined;
  if (closestSec) {
    if (closestSec.id) {
      sectionSelector = '#' + escapeCSS(closestSec.id);
      sectionId = closestSec.id;
    } else if (closestSec.getAttribute && closestSec.getAttribute('data-section-id')) {
      const secAttr = closestSec.getAttribute('data-section-id');
      sectionSelector = '[data-section-id="' + escapeCSSString(secAttr) + '"]';
    }
  }

  const candidateAttrs = ['data-product-id', 'data-handle', 'data-variant-id', 'setting-id', 'data-block-id', 'name'];
  let keyedOwner: any = undefined;
  let ownerKeyAttr: string | undefined = undefined;
  let ownerKeyValue: string | undefined = undefined;

  let curr = el;
  while (curr && curr !== closestSec && curr !== (doc?.body)) {
    for (const attr of candidateAttrs) {
      const val = curr.getAttribute ? curr.getAttribute(attr) : null;
      if (val && typeof val === 'string' && val.length < 100) {
        keyedOwner = curr;
        ownerKeyAttr = attr;
        ownerKeyValue = val;
        break;
      }
    }
    if (keyedOwner) break;
    curr = curr.parentElement;
  }

  const subResult = keyedOwner
    ? computeRelativeSubselectorTS(keyedOwner, el)
    : { subselector: '', stability: 'stable' as const, isStructuralFallback: false };
  const ownerQuery = keyedOwner ? '[' + ownerKeyAttr + '="' + escapeCSSString(ownerKeyValue!) + '"]' : '';
  const composedParts = [sectionSelector, ownerQuery, subResult.subselector].filter(Boolean);
  const composedSelector = composedParts.join(' ').trim();

  const canonicalEvidence: any = {
    isClone,
    ownerKey: ownerKeyAttr,
    ownerValue: ownerKeyValue,
    relativeSubSelector: subResult.subselector,
    canonicalMatchCount: 0,
    canonicalFound: false,
    isUniqueCanonicalTarget: false,
  };

  if (keyedOwner && ownerKeyAttr && ownerKeyValue && doc) {
    const ownerCandidateQuery = [sectionSelector, '[' + ownerKeyAttr + '="' + escapeCSSString(ownerKeyValue) + '"]'].filter(Boolean).join(' ').trim();
    try {
      const allCandidateOwners = Array.from(doc.querySelectorAll(ownerCandidateQuery));
      const nonCloneOwners = allCandidateOwners.filter(
        (cand: any) => cand.closest('.slick-cloned, .swiper-slide-duplicate, [data-cloned="true"]') === null
      );
      canonicalEvidence.canonicalMatchCount = nonCloneOwners.length;

      if (nonCloneOwners.length === 1) {
        const canonicalOwner: any = nonCloneOwners[0];
        if (subResult.subselector) {
          const canonicalTargets = Array.from(canonicalOwner.querySelectorAll(subResult.subselector));
          if (canonicalTargets.length === 1) {
            canonicalEvidence.canonicalFound = true;
            canonicalEvidence.isUniqueCanonicalTarget = true;
          } else if (canonicalTargets.length > 1) {
            canonicalEvidence.canonicalFound = true;
            canonicalEvidence.isUniqueCanonicalTarget = false;
            canonicalEvidence.canonicalTargetCount = canonicalTargets.length;
          }
        } else {
          canonicalEvidence.canonicalFound = true;
          canonicalEvidence.isUniqueCanonicalTarget = true;
        }
      }
    } catch {}
  }

  let isUnique = false;
  let matchCount = 1;
  let captureTimeDomIndex = undefined;

  if (composedSelector && doc) {
    try {
      const allMatches = Array.from(doc.querySelectorAll(composedSelector));
      const realMatches = allMatches.filter(
        (m: any) => m.closest('.slick-cloned, .swiper-slide-duplicate, [data-cloned="true"]') === null
      );

      matchCount = realMatches.length;
      isUnique = realMatches.length === 1;

      const idx = realMatches.indexOf(el);
      if (idx >= 0) captureTimeDomIndex = idx;
    } catch {}
  }

  return {
    primarySelector: composedSelector,
    relativeSubpath: subResult.subselector,
    relativeSubpathStability: subResult.stability,
    isStructuralFallback: subResult.isStructuralFallback,
    keyedOwnerAttr: ownerKeyAttr,
    keyedOwnerValue: ownerKeyValue,
    isUnique,
    matchCount,
    captureTimeDomIndex,
    isClone,
    canonicalEvidence,
    isLoopItem: matchCount > 1,
    indexStability: (matchCount > 1 || subResult.isStructuralFallback) ? 'unstable-on-rerender' : 'stable',
    sectionId,
  };
}

export function extractSourceHintsTS(el: any): any {
  const signals: any[] = [];
  let detectedFramework = 'unknown';
  let frameworkConfidence = 'low';
  let suggestedFile = undefined;
  let suggestedLine = undefined;
  let suggestedComponent = undefined;

  if (!el || el.nodeType !== 1) {
    return { framework: 'unknown', confidence: 'low', signals: [] };
  }

  // 1. Liquid section
  const closestSec = el.closest ? el.closest('section[id^="shopify-section-"], section[id^="haravan-section-"], [data-section-id], [data-section-type]') : null;
  if (closestSec) {
    const isExplicitTheme = /^shopify-section-|^haravan-section-/.test(closestSec.id || '');
    const secId = closestSec.getAttribute('data-section-id') || closestSec.id;
    const secType = closestSec.getAttribute('data-section-type');

    signals.push({
      type: 'liquid-section',
      name: 'sectionId',
      value: String(secId || '').slice(0, 100),
      confidence: isExplicitTheme ? 'high' : 'medium',
    });

    if (secType) {
      signals.push({
        type: 'liquid-section',
        name: 'sectionType',
        value: String(secType).slice(0, 100),
        confidence: isExplicitTheme ? 'high' : 'medium',
      });
    }

    if (isExplicitTheme) {
      detectedFramework = 'liquid';
      frameworkConfidence = 'high';
    }
  }

  // 2. Strict Numeric Validation for sourceLine
  const rawLine = (el.getAttribute('data-source-line') || '').trim();
  if (/^\d+$/.test(rawLine)) {
    const parsedLine = Number(rawLine);
    if (Number.isInteger(parsedLine) && parsedLine > 0 && parsedLine <= 1000000) {
      suggestedLine = parsedLine;
      signals.push({ type: 'build-attribute', name: 'data-source-line', value: String(parsedLine), confidence: 'medium' });
    }
  }

  // 3. Build-time attributes (Astro / LocatorJS / Vite / Next.js)
  const astroFile = el.getAttribute('data-astro-source-file') || el.closest('[data-astro-source-file]')?.getAttribute('data-astro-source-file');
  if (astroFile && typeof astroFile === 'string') {
    suggestedFile = astroFile.slice(0, 300);
    detectedFramework = 'astro';
    frameworkConfidence = 'high';
    signals.push({ type: 'build-attribute', name: 'data-astro-source-file', value: suggestedFile, confidence: 'high' });
  }

  const srcFile = el.getAttribute('data-source-file') || el.getAttribute('data-locatorjs-id') || el.closest('[data-source-file]')?.getAttribute('data-source-file');
  if (srcFile && typeof srcFile === 'string' && !suggestedFile) {
    suggestedFile = srcFile.slice(0, 300);
    signals.push({ type: 'build-attribute', name: 'data-source-file', value: suggestedFile, confidence: 'medium' });
  }

  const sourceLoc = el.getAttribute('data-source-loc') || el.closest('[data-source-loc]')?.getAttribute('data-source-loc');
  if (sourceLoc && typeof sourceLoc === 'string') {
    const locParts = sourceLoc.split(':');
    if (locParts.length >= 2) {
      if (!suggestedFile) suggestedFile = locParts[0]?.slice(0, 300);
      if (!suggestedLine && /^\d+$/.test(locParts[1] || '')) suggestedLine = Number(locParts[1]);
      signals.push({ type: 'build-attribute', name: 'data-source-loc', value: sourceLoc.slice(0, 300), confidence: 'high' });
    }
  }

  const compName = el.getAttribute('data-component') || el.getAttribute('data-component-name') || el.closest('[data-component]')?.getAttribute('data-component');
  if (compName && typeof compName === 'string') {
    suggestedComponent = compName.slice(0, 100);
    signals.push({ type: 'dom-attribute', name: 'data-component', value: suggestedComponent, confidence: 'medium' });
  }

  // 4. React Fiber & Debug Source
  try {
    const fiberKey = Object.keys(el).find((k) => k.startsWith('__reactFiber$') || k.startsWith('__reactInternalInstance$'));
    if (fiberKey && el[fiberKey]) {
      if (detectedFramework === 'unknown') {
        detectedFramework = 'react';
        frameworkConfidence = 'medium';
      }
      let curr = el[fiberKey];
      let depth = 0;
      while (curr && depth < 10) {
        if (curr._debugSource && !suggestedFile) {
          if (curr._debugSource.fileName) suggestedFile = String(curr._debugSource.fileName).slice(0, 300);
          if (curr._debugSource.lineNumber) suggestedLine = Number(curr._debugSource.lineNumber);
          frameworkConfidence = 'high';
          signals.push({ type: 'react-debug-source', name: '_debugSource', value: `${suggestedFile}:${suggestedLine}`, confidence: 'high' });
        }
        if (curr._debugOwner?.type?.name && !suggestedComponent) {
          suggestedComponent = String(curr._debugOwner.type.name).slice(0, 100);
          signals.push({ type: 'react-debug-owner', name: 'componentName', value: suggestedComponent, confidence: 'high' });
        } else if (typeof curr.type === 'function' && curr.type.name && !suggestedComponent) {
          suggestedComponent = String(curr.type.name).slice(0, 100);
          signals.push({ type: 'react-fiber', name: 'componentName', value: suggestedComponent, confidence: 'medium' });
        }
        curr = curr.return;
        depth++;
      }
    }
  } catch {}

  const getAttrNames = (target: any) => {
    if (!target || !target.attributes) return [];
    if (typeof target.attributes[Symbol.iterator] === 'function' || Array.isArray(target.attributes)) {
      return Array.from(target.attributes).map((a: any) => (typeof a === 'string' ? a : (a && a.name) || ''));
    }
    return Object.keys(target.attributes);
  };
  const attrNames = getAttrNames(el);

  // 5. Vue Framework
  try {
    const isVue = el.__vue__ || el.__vnode || Object.keys(el).some((k) => k.startsWith('__vueParentComponent'));
    const hasVueScopedAttr = attrNames.some((name: string) => typeof name === 'string' && /^data-v-[a-f0-9]+$/i.test(name));
    if (isVue || hasVueScopedAttr) {
      if (detectedFramework === 'unknown') {
        detectedFramework = 'vue';
        frameworkConfidence = hasVueScopedAttr ? 'high' : 'medium';
      }
      signals.push({ type: 'vue-component', name: 'vueSignal', value: hasVueScopedAttr ? 'scoped-css' : 'vnode', confidence: 'medium' });
    }
  } catch {}

  // 6. Svelte Framework
  try {
    const classNames = typeof el.className === 'string' ? el.className : '';
    const isSvelteClass = /svelte-[a-z0-9]+/i.test(classNames);
    const hasSvelteAttr = attrNames.some((name: string) => typeof name === 'string' && name.startsWith('data-svelte-'));
    if (isSvelteClass || hasSvelteAttr) {
      if (detectedFramework === 'unknown') {
        detectedFramework = 'svelte';
        frameworkConfidence = 'high';
      }
      signals.push({ type: 'svelte-component', name: 'svelteSignal', value: isSvelteClass ? 'scoped-class' : 'data-svelte', confidence: 'high' });
    }
  } catch {}

  return {
    framework: detectedFramework,
    confidence: frameworkConfidence,
    suggestedFile,
    suggestedLine,
    suggestedComponent,
    signals,
  };
}
