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
    document.removeEventListener('mousemove', onHover, true);
    document.removeEventListener('pointermove', onHover, true);
    document.removeEventListener('click', onClick, true);
    document.removeEventListener('keydown', onKey, true);

    const ov = document.getElementById(OVERLAY_ID);
    if (ov) ov.remove();
    const bg = document.getElementById(BADGE_ID);
    if (bg) bg.remove();
    const modal = document.getElementById(MODAL_ID);
    if (modal) modal.remove();
    const multiDock = document.getElementById(MULTI_BAR_ID);
    if (multiDock) multiDock.remove();
    document.querySelectorAll('.' + PIN_CLASS).forEach((p) => p.remove());

    if (document.documentElement) document.documentElement.style.cursor = '';
    window.__antifanPickerActive = false;
  };

  const prevent = (e) => {
    e.preventDefault();
    e.stopPropagation();
  };

  const onKey = (e) => {
    if (e.key === 'Escape') {
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

  const findOptimalUniqueSelector = (el) => {
    if (!el || el.nodeType !== 1) return { selector: '', isUnique: false, matchCount: 0 };

    // 1. Check ID uniqueness
    if (el.id && typeof el.id === 'string' && !/^[0-9]/.test(el.id)) {
      const idSel = '#' + CSS.escape(el.id);
      try {
        if (document.querySelectorAll(idSel).length === 1) return { selector: idSel, isUnique: true, matchCount: 1 };
      } catch {}
    }

    const tag = el.tagName.toLowerCase();
    const classList = Array.from(el.classList || []).filter((c) => typeof c === 'string' && !c.startsWith('antifan-') && !c.includes(':') && !/^[0-9]/.test(c));

    // 2. Check distinct single class
    if (classList.length > 0) {
      for (const c of classList) {
        const sel = tag + '.' + CSS.escape(c);
        try {
          if (document.querySelectorAll(sel).length === 1) return { selector: sel, isUnique: true, matchCount: 1 };
        } catch {}
      }

      // 3. Check combined classes
      if (classList.length >= 2) {
        const sel = tag + '.' + classList.slice(0, 3).map((c) => CSS.escape(c)).join('.');
        try {
          if (document.querySelectorAll(sel).length === 1) return { selector: sel, isUnique: true, matchCount: 1 };
        } catch {}
      }
    }

    // 4. Check data attributes & semantics
    const attrs = ['data-id', 'data-sku', 'data-section-id', 'name', 'aria-label'];
    for (const a of attrs) {
      const v = el.getAttribute(a);
      if (v && v.length < 50) {
        const sel = tag + '[' + a + '="' + CSS.escape(v) + '"]';
        try {
          if (document.querySelectorAll(sel).length === 1) return { selector: sel, isUnique: true, matchCount: 1 };
        } catch {}
      }
    }

    // 5. Check parent-scoped selector
    if (el.parentElement && el.parentElement !== document.body) {
      const pTag = el.parentElement.tagName.toLowerCase();
      const pCls = (el.parentElement.className && typeof el.parentElement.className === 'string')
        ? el.parentElement.className.trim().split(/\\s+/).filter(Boolean)[0]
        : '';
      const pPrefix = pCls ? pTag + '.' + CSS.escape(pCls) : pTag;
      const childSuffix = classList.length ? tag + '.' + CSS.escape(classList[0]) : tag;
      const scopedSel = pPrefix + ' > ' + childSuffix;
      try {
        if (document.querySelectorAll(scopedSel).length === 1) return { selector: scopedSel, isUnique: true, matchCount: 1 };
      } catch {}
    }

    // Fallback: Dom Ancestry
    const fallback = getDomAncestry(el);
    let count = 1;
    try { count = document.querySelectorAll(fallback).length; } catch {}
    return { selector: fallback, isUnique: count === 1, matchCount: count };
  };

  const overlay = document.createElement('div');
  overlay.id = OVERLAY_ID;
  overlay.style.cssText = 'position:fixed;pointer-events:none;z-index:2147483646;box-sizing:border-box;border:2px solid #087ff5;background-color:rgba(8,127,245,0.15);display:none;transition:none;';

  const badge = document.createElement('div');
  badge.id = BADGE_ID;
  badge.style.cssText = 'position:fixed;pointer-events:none;z-index:2147483647;box-sizing:border-box;background:#090d16;color:#38bdf8;border:1px solid rgba(56,189,248,0.5);border-radius:4px;padding:2px 6px;font:11px/14px monospace;box-shadow:0 4px 12px rgba(0,0,0,0.5);display:none;white-space:nowrap;';

  const container = document.body || document.documentElement;
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
    dock.innerHTML = '<span style="font-weight:600;color:#38bdf8;">✨ ' + pickedList.length + ' element' + (pickedList.length > 1 ? 's' : '') + ' selected</span><button id="btnMultiSubmit" style="background:#087ff5;border:none;color:#fff;border-radius:14px;padding:4px 12px;font-size:11px;font-weight:600;cursor:pointer;">Send All ↑</button><button id="btnMultiCancel" style="background:transparent;border:none;color:#94a3b8;font-size:11px;cursor:pointer;">Cancel</button>';

    dock.querySelector('#btnMultiSubmit').onclick = () => {
      if (pickedList.length > 0) {
        const first = pickedList[0];
        const combinedComment = pickedList.map((p, idx) => '[' + (idx + 1) + '] ' + p.selector + ': ' + (p.userComment || 'Check this element')).join('\\n\\n');
        window.__antifanPick = Object.assign({}, first, {
          userComment: combinedComment,
          multiItems: pickedList,
        });
      }
      cleanup();
    };

    dock.querySelector('#btnMultiCancel').onclick = () => {
      cleanup();
      window.__antifanPick = { canceled: true };
    };
  };

  const onHover = (e) => {
    if (isModalOpen) return;
    const el = (e.target && e.target.nodeType === 1) ? e.target : document.body;
    if (!el || el.id === OVERLAY_ID || el.id === BADGE_ID || el.closest && (el.closest('#' + MODAL_ID) || el.closest('#' + MULTI_BAR_ID))) return;
    currentTarget = el;

    const r = el.getBoundingClientRect();
    overlay.style.display = 'block';
    overlay.style.top = r.top + 'px';
    overlay.style.left = r.left + 'px';
    overlay.style.width = r.width + 'px';
    overlay.style.height = r.height + 'px';

    let tag = el.tagName.toLowerCase();
    if (el.id) tag += '#' + el.id;
    else if (el.className && typeof el.className === 'string') {
      const cls = el.className.trim().split(/\\s+/).filter(Boolean)[0];
      if (cls) tag += '.' + cls;
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
    modal.style.cssText = 'position:fixed;z-index:2147483647;box-sizing:border-box;background:#18181b;color:#f1f5f9;border:1px solid #3b82f6;border-radius:8px;padding:8px 10px;box-shadow:0 8px 24px rgba(0,0,0,0.65);width:260px;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;font-size:12px;display:flex;flex-direction:column;gap:6px;';

    const r = el.getBoundingClientRect();
    let top = r.bottom + 6;
    let left = r.left;
    if (top + 130 > window.innerHeight) top = Math.max(10, r.top - 140);
    if (left + 260 > window.innerWidth) left = Math.max(10, window.innerWidth - 270);
    modal.style.top = Math.max(10, top) + 'px';
    modal.style.left = Math.max(10, left) + 'px';

    const selectorName = el.id ? '#' + el.id : (el.className && typeof el.className === 'string' ? el.tagName.toLowerCase() + '.' + el.className.trim().split(/\\s+/).filter(Boolean)[0] : el.tagName.toLowerCase());

    const header = document.createElement('div');
    header.style.cssText = 'display:flex;align-items:center;justify-content:space-between;font-size:11px;color:#94a3b8;border-bottom:1px solid #27272a;padding-bottom:4px;';
    header.innerHTML = '<span style="font-weight:600;color:#38bdf8;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:180px;">' + selectorName + '</span><span style="font-size:9.5px;color:#71717a;">Esc cancel</span>';

    const textarea = document.createElement('textarea');
    textarea.placeholder = 'Add comment (e.g. Change text, fix margin)...';
    textarea.style.cssText = 'width:100%;height:44px;max-height:100px;background:#09090b;border:1px solid #27272a;border-radius:4px;color:#f8fafc;padding:5px 6px;font-size:11.5px;font-family:inherit;outline:none;resize:none;box-sizing:border-box;line-height:1.35;';

    const statusMsg = document.createElement('div');
    statusMsg.id = 'statusMsg';
    statusMsg.style.cssText = 'display:none;color:#ef4444;font-size:10.5px;padding-top:2px;line-height:1.2;font-weight:500;';

    const footer = document.createElement('div');
    footer.style.cssText = 'display:flex;align-items:center;justify-content:space-between;padding-top:2px;';
    footer.innerHTML = '<label style="font-size:10.5px;color:#a1a1aa;cursor:pointer;display:flex;align-items:center;gap:3px;"><input type="checkbox" id="chkMulti" ' + (isMultiMode ? 'checked' : '') + ' style="cursor:pointer;width:12px;height:12px;margin:0;" /> Multi</label><button id="btnModalSend" style="background:#087ff5;border:none;color:#ffffff;border-radius:4px;padding:3px 10px;font-size:11px;font-weight:600;cursor:pointer;">Send ↑</button>';

    modal.appendChild(header);
    modal.appendChild(textarea);
    modal.appendChild(statusMsg);
    modal.appendChild(footer);
    document.body.appendChild(modal);

    textarea.focus();

    textarea.oninput = () => {
      if (statusMsg.style.display !== 'none') {
        statusMsg.style.display = 'none';
      }
    };

    const doSubmit = () => {
      const userComment = textarea.value.trim();
      if (!userComment) {
        statusMsg.textContent = 'Add a comment before sending to Chat.';
        statusMsg.style.display = 'block';
        textarea.focus();
        return;
      }
      statusMsg.style.display = 'none';

      const chk = modal.querySelector('#chkMulti');
      isMultiMode = chk ? chk.checked : false;

      const rect = el.getBoundingClientRect();
      const computed = window.getComputedStyle(el);

      const styles = {
        fontFamily: computed.fontFamily,
        fontSize: computed.fontSize,
        fontWeight: computed.fontWeight,
        color: computed.color,
        backgroundColor: computed.backgroundColor,
        display: computed.display,
        position: computed.position,
        padding: computed.padding,
        margin: computed.margin,
        width: computed.width,
        height: computed.height,
      };

      const pickedItem = {
        tag: el.tagName.toLowerCase(),
        tagName: el.tagName.toLowerCase(),
        id: el.id || undefined,
        classes: Array.from(el.classList || []),
        textSnippet: (el.textContent || '').trim().slice(0, 120),
        textContent: (el.textContent || '').trim().slice(0, 1500),
        xpath: getXPath(el),
        selector: findOptimalUniqueSelector(el).selector,
        isUnique: findOptimalUniqueSelector(el).isUnique,
        matchCount: findOptimalUniqueSelector(el).matchCount,
        domAncestry: getDomAncestry(el),
        dimensions: Math.round(rect.width) + ' x ' + Math.round(rect.height) + ' px',
        outerHTML: el.outerHTML ? el.outerHTML.slice(0, 15000) : '',
        computedStyles: styles,
        userComment: userComment,
        rect: {
          x: Math.round(rect.left + window.scrollX),
          y: Math.round(rect.top + window.scrollY),
          width: Math.round(rect.width),
          height: Math.round(rect.height),
        },
        clientRect: {
          x: Math.round(rect.left),
          y: Math.round(rect.top),
          width: Math.round(rect.width),
          height: Math.round(rect.height),
        },
        timestamp: Date.now(),
      };

      if (isMultiMode) {
        pickedList.push(pickedItem);
        // Add pin badge to element
        const pin = document.createElement('div');
        pin.className = PIN_CLASS;
        pin.style.cssText = 'position:absolute;z-index:2147483645;background:#087ff5;color:#fff;border-radius:50%;width:20px;height:20px;display:flex;align-items:center;justify-content:center;font:bold 11px sans-serif;box-shadow:0 2px 6px rgba(0,0,0,0.5);pointer-events:none;';
        pin.textContent = String(pickedList.length);
        pin.style.top = (rect.top + window.scrollY - 10) + 'px';
        pin.style.left = (rect.left + window.scrollX - 10) + 'px';
        document.body.appendChild(pin);

        modal.remove();
        isModalOpen = false;
        updateMultiDock();
      } else {
        window.__antifanPick = pickedItem;
        cleanup();
      }
    };

    const sendBtn = modal.querySelector('#btnModalSend');
    if (sendBtn) sendBtn.onclick = doSubmit;

    textarea.onkeydown = (ev) => {
      if (ev.key === 'Enter' && !ev.shiftKey) {
        ev.preventDefault();
        doSubmit();
      } else if (ev.key === 'Escape') {
        ev.preventDefault();
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
    prevent(e);
    if (isModalOpen) return;
    const el = currentTarget || (e.target && e.target.nodeType === 1 ? e.target : document.body);
    if (!el || el.id === OVERLAY_ID || el.id === BADGE_ID || el.id === MULTI_BAR_ID || el.closest && el.closest('#' + MULTI_BAR_ID)) return;
    showCommentModal(el);
  };

  document.addEventListener('mousemove', onHover, true);
  document.addEventListener('pointermove', onHover, true);
  document.addEventListener('click', onClick, true);
  document.addEventListener('keydown', onKey, true);
  if (document.documentElement) document.documentElement.style.cursor = 'crosshair';
})();`;
