/**
 * AntiFan Browser Desktop — Font Finder Script
 * High-precision typography inspector & CSS extractor with full Shadow DOM & SPA parity.
 */

export const FONT_FINDER_SCRIPT = `(() => {
  if (window.__antifanFontFinderActive) return;
  window.__antifanFontFinderActive = true;

  const BADGE_ID = 'antifan-font-badge';
  const OVERLAY_ID = 'antifan-font-overlay';
  const STYLE_ID = 'antifan-font-styles';

  const cleanup = () => {
    window.__antifanFontFinderActive = false;
    window.removeEventListener('mousemove', onHover, true);
    window.removeEventListener('pointermove', onHover, true);
    window.removeEventListener('pointerdown', onPointerDown, true);
    window.removeEventListener('pointerup', onPointerUp, true);
    window.removeEventListener('touchstart', onTouchStart, { capture: true });
    window.removeEventListener('touchmove', onTouchMove, { capture: true });
    window.removeEventListener('touchend', onTouchEnd, { capture: true });
    window.removeEventListener('click', onClick, true);
    window.removeEventListener('keydown', onKey, true);

    const bg = document.getElementById(BADGE_ID);
    if (bg) bg.remove();
    const ov = document.getElementById(OVERLAY_ID);
    if (ov) ov.remove();
    const st = document.getElementById(STYLE_ID);
    if (st) st.remove();
    if (document.documentElement) document.documentElement.style.cursor = '';
    window.__antifanFontFinderCleanup = null;
  };
  window.__antifanFontFinderCleanup = cleanup;

  const onKey = (e) => {
    if (e.key === 'Escape') {
      if (e.preventDefault) e.preventDefault();
      if (e.stopPropagation) e.stopPropagation();
      cleanup();
    }
  };

  function ensureStyles() {
    let st = document.getElementById(STYLE_ID);
    if (!st) {
      st = document.createElement('style');
      st.id = STYLE_ID;
      st.textContent = \`
        #\${OVERLAY_ID} {
          position: fixed !important;
          pointer-events: none !important;
          z-index: 2147483646 !important;
          box-sizing: border-box !important;
          border: 2px dashed #f59e0b !important;
          background-color: rgba(245, 158, 11, 0.12) !important;
          border-radius: 4px !important;
          box-shadow: 0 0 16px rgba(245, 158, 11, 0.3) !important;
          display: none;
          transition: all 0.1s ease-out !important;
        }
        #\${BADGE_ID} {
          position: fixed !important;
          pointer-events: none !important;
          z-index: 2147483647 !important;
          box-sizing: border-box !important;
          background: rgba(15, 23, 42, 0.96) !important;
          color: #f8fafc !important;
          border: 1.5px solid #f59e0b !important;
          border-radius: 8px !important;
          padding: 8px 12px !important;
          font: 12px/1.4 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif !important;
          box-shadow: 0 12px 32px rgba(0, 0, 0, 0.75), 0 0 20px rgba(245, 158, 11, 0.3) !important;
          display: none;
          white-space: nowrap !important;
          backdrop-filter: blur(8px) !important;
        }
      \`;
      (document.head || document.documentElement).appendChild(st);
    }
  }

  function ensureElements() {
    ensureStyles();
    const parent = document.body || document.documentElement;
    if (!parent) return null;

    let ov = document.getElementById(OVERLAY_ID);
    if (!ov) {
      ov = document.createElement('div');
      ov.id = OVERLAY_ID;
      parent.appendChild(ov);
    } else if (ov.parentElement !== parent) {
      parent.appendChild(ov);
    }

    let bg = document.getElementById(BADGE_ID);
    if (!bg) {
      bg = document.createElement('div');
      bg.id = BADGE_ID;
      parent.appendChild(bg);
    } else if (bg.parentElement !== parent) {
      parent.appendChild(bg);
    }

    return { overlay: ov, badge: bg };
  }

  let currentTarget = null;

  const onHover = (e) => {
    if (!window.__antifanFontFinderActive) return;
    const els = ensureElements();
    if (!els) return;
    const { overlay, badge } = els;

    // Penetrate Shadow DOM on YouTube / Polymer
    const path = (e.composedPath && typeof e.composedPath === 'function') ? e.composedPath() : [];
    let el = null;
    for (let i = 0; i < path.length; i++) {
      const node = path[i];
      if (node && node.nodeType === 1) {
        if (node.id === BADGE_ID || node.id === OVERLAY_ID) continue;
        el = node;
        break;
      }
    }
    if (!el) {
      el = (e.target && e.target.nodeType === 1) ? e.target : document.body;
    }
    if (!el || el.id === BADGE_ID || el.id === OVERLAY_ID) return;

    currentTarget = el;

    const r = el.getBoundingClientRect();
    if (r.width === 0 && r.height === 0) return;

    overlay.style.display = 'block';
    overlay.style.top = Math.max(0, r.top - 2) + 'px';
    overlay.style.left = Math.max(0, r.left - 2) + 'px';
    overlay.style.width = (r.width + 4) + 'px';
    overlay.style.height = (r.height + 4) + 'px';

    const cs = window.getComputedStyle(el);
    const family = cs.fontFamily ? cs.fontFamily.split(',')[0].replace(/['"]/g, '').trim() : 'sans-serif';
    const size = cs.fontSize || '16px';
    const weight = cs.fontWeight || '400';
    const lh = cs.lineHeight || 'normal';
    const color = cs.color || '#ffffff';
    const letterSpacing = cs.letterSpacing !== 'normal' ? cs.letterSpacing : '';

    let tag = el.tagName.toLowerCase();
    if (el.id) tag += '#' + el.id;
    else if (el.className && typeof el.className === 'string') {
      const cls = el.className.trim().split(/\\s+/).filter(Boolean)[0];
      if (cls && !cls.includes(':')) tag += '.' + cls;
    }

    badge.innerHTML = \`
      <div style="display:flex;align-items:center;justify-content:space-between;gap:8px;margin-bottom:3px;">
        <span style="font-weight:700;color:#fbbf24;font-size:12.5px;">🔤 \${family}</span>
        <span style="font-size:10.5px;color:#94a3b8;background:#1e293b;padding:1px 6px;border-radius:4px;border:1px solid #334155;">\${tag}</span>
      </div>
      <div style="font-size:11px;color:#94a3b8;display:flex;align-items:center;gap:6px;">
        <span>Size: <strong style="color:#f8fafc;">\${size}</strong></span>
        <span>•</span>
        <span>Weight: <strong style="color:#f8fafc;">\${weight}</strong></span>
        <span>•</span>
        <span>Line: <strong style="color:#f8fafc;">\${lh}</strong></span>
      </div>
      <div style="font-size:11px;color:#94a3b8;display:flex;align-items:center;gap:6px;margin-top:2px;">
        <span>Color:</span>
        <span style="display:inline-block;width:11px;height:11px;background:\${color};border:1.5px solid #475569;border-radius:3px;vertical-align:middle;"></span>
        <strong style="color:#f8fafc;">\${color}</strong>
        \${letterSpacing ? '<span>• Spacing: <strong style="color:#f8fafc;">' + letterSpacing + '</strong></span>' : ''}
      </div>
      <div style="font-size:10px;color:#38bdf8;margin-top:4px;display:flex;align-items:center;gap:4px;">
        <span>⚡ Click element to copy CSS typography</span>
      </div>
    \`;

    badge.style.display = 'block';
    const bTop = r.top >= 95 ? (r.top - 90) : Math.min(window.innerHeight - 110, r.bottom + 8);
    const bLeft = Math.max(10, Math.min(window.innerWidth - 290, r.left));
    badge.style.top = bTop + 'px';
    badge.style.left = bLeft + 'px';
  };

  const onClick = (e) => {
    if (!window.__antifanFontFinderActive) return;
    e.preventDefault();
    e.stopPropagation();
    const el = currentTarget || (e.target && e.target.nodeType === 1 ? e.target : document.body);
    if (!el) return;

    const cs = window.getComputedStyle(el);
    const cssText = [
      'font-family: ' + cs.fontFamily + ';',
      'font-size: ' + cs.fontSize + ';',
      'font-weight: ' + cs.fontWeight + ';',
      'line-height: ' + cs.lineHeight + ';',
      'color: ' + cs.color + ';',
      cs.letterSpacing !== 'normal' ? 'letter-spacing: ' + cs.letterSpacing + ';' : '',
    ].filter(Boolean).join('\\n');

    try {
      navigator.clipboard.writeText(cssText);
    } catch {}

    const bg = document.getElementById(BADGE_ID);
    if (bg) {
      bg.innerHTML = '<div style="color:#34d399;font-weight:700;padding:4px 8px;display:flex;align-items:center;gap:6px;"><span>✓</span> <span>CSS Typography Copied to Clipboard!</span></div>';
    }
    setTimeout(cleanup, 800);
  };
  const resolveElement = (e) => {
    if (e.touches && e.touches.length > 0) {
      const t = e.touches[0];
      return document.elementFromPoint(t.clientX, t.clientY);
    }
    if (e.changedTouches && e.changedTouches.length > 0) {
      const t = e.changedTouches[0];
      return document.elementFromPoint(t.clientX, t.clientY);
    }
    if (typeof e.clientX === 'number' && typeof e.clientY === 'number') {
      return document.elementFromPoint(e.clientX, e.clientY);
    }
    return e.target;
  };

  const onPointerDown = (e) => {
    if (!window.__antifanFontFinderActive) return;
    if (e.pointerType === 'touch' || e.pointerType === 'pen') {
      onHover(e);
    }
  };

  const onPointerUp = (e) => {
    if (!window.__antifanFontFinderActive) return;
    if (e.pointerType === 'touch' || e.pointerType === 'pen') {
      const el = resolveElement(e);
      if (el) {
        currentTarget = el;
        onClick(e);
      }
    }
  };

  const onTouchStart = (e) => {
    if (!window.__antifanFontFinderActive) return;
    onHover(e);
  };

  const onTouchMove = (e) => {
    if (!window.__antifanFontFinderActive) return;
    onHover(e);
  };

  const onTouchEnd = (e) => {
    if (!window.__antifanFontFinderActive) return;
    const el = resolveElement(e);
    if (el) {
      currentTarget = el;
      onClick(e);
    }
  };

  window.addEventListener('mousemove', onHover, true);
  window.addEventListener('pointermove', onHover, true);
  window.addEventListener('pointerdown', onPointerDown, true);
  window.addEventListener('pointerup', onPointerUp, true);
  window.addEventListener('touchstart', onTouchStart, { capture: true, passive: true });
  window.addEventListener('touchmove', onTouchMove, { capture: true, passive: true });
  window.addEventListener('touchend', onTouchEnd, { capture: true });
  window.addEventListener('click', onClick, true);
  window.addEventListener('keydown', onKey, true);
  if (document.documentElement) document.documentElement.style.cursor = 'help';
})();`;
