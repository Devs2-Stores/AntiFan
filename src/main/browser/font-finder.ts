/**
 * AntiFan Browser Desktop — Font Finder Script
 * Injected into the page to inspect and copy typography styles on hover/click.
 */

export const FONT_FINDER_SCRIPT = `(() => {
  if (window.__antifanFontFinderActive) return;
  window.__antifanFontFinderActive = true;

  const BADGE_ID = 'antifan-font-badge';
  const OVERLAY_ID = 'antifan-font-overlay';

  const cleanup = () => {
    document.removeEventListener('mousemove', onHover, true);
    document.removeEventListener('pointermove', onHover, true);
    document.removeEventListener('click', onClick, true);
    document.removeEventListener('keydown', onKey, true);

    const bg = document.getElementById(BADGE_ID);
    if (bg) bg.remove();
    const ov = document.getElementById(OVERLAY_ID);
    if (ov) ov.remove();
    if (document.documentElement) document.documentElement.style.cursor = '';
    window.__antifanFontFinderActive = false;
  };

  const onKey = (e) => {
    if (e.key === 'Escape') {
      cleanup();
    }
  };

  const overlay = document.createElement('div');
  overlay.id = OVERLAY_ID;
  overlay.style.cssText = 'position:fixed;pointer-events:none;z-index:2147483646;box-sizing:border-box;border:2px dashed #f59e0b;background-color:rgba(245,158,11,0.12);display:none;';

  const badge = document.createElement('div');
  badge.id = BADGE_ID;
  badge.style.cssText = 'position:fixed;pointer-events:none;z-index:2147483647;box-sizing:border-box;background:#0f172a;color:#f8fafc;border:1px solid #f59e0b;border-radius:6px;padding:6px 10px;font:12px/16px -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;box-shadow:0 8px 24px rgba(0,0,0,0.5);display:none;white-space:nowrap;';

  const container = document.body || document.documentElement;
  if (container) {
    container.appendChild(overlay);
    container.appendChild(badge);
  }

  let currentTarget = null;

  const onHover = (e) => {
    const el = (e.target && e.target.nodeType === 1) ? e.target : document.body;
    if (!el || el.id === BADGE_ID || el.id === OVERLAY_ID) return;
    currentTarget = el;

    const r = el.getBoundingClientRect();
    overlay.style.display = 'block';
    overlay.style.top = r.top + 'px';
    overlay.style.left = r.left + 'px';
    overlay.style.width = r.width + 'px';
    overlay.style.height = r.height + 'px';

    const cs = window.getComputedStyle(el);
    const family = cs.fontFamily ? cs.fontFamily.split(',')[0].replace(/['"]/g, '').trim() : 'sans-serif';
    const size = cs.fontSize || '16px';
    const weight = cs.fontWeight || '400';
    const lh = cs.lineHeight || 'normal';
    const color = cs.color || '#000000';

    badge.innerHTML = '<div style="display:flex;align-items:center;gap:6px;font-weight:600;color:#fbbf24;margin-bottom:2px;">🔤 ' + family + ' (' + weight + ')</div>' +
      '<div style="font-size:11px;color:#94a3b8;">Size: <span style="color:#f8fafc;">' + size + '</span> | Line-height: <span style="color:#f8fafc;">' + lh + '</span></div>' +
      '<div style="font-size:11px;color:#94a3b8;display:flex;align-items:center;gap:4px;margin-top:2px;">Color: <span style="display:inline-block;width:10px;height:10px;background:' + color + ';border:1px solid #475569;border-radius:2px;"></span> <span style="color:#f8fafc;">' + color + '</span></div>' +
      '<div style="font-size:10px;color:#38bdf8;margin-top:3px;">Click to copy CSS</div>';

    badge.style.display = 'block';
    const bTop = r.top >= 80 ? (r.top - 75) : (r.bottom + 8);
    const bLeft = Math.max(8, Math.min(window.innerWidth - 240, r.left));
    badge.style.top = bTop + 'px';
    badge.style.left = bLeft + 'px';
  };

  const onClick = (e) => {
    e.preventDefault();
    e.stopPropagation();
    const el = currentTarget || (e.target && e.target.nodeType === 1 ? e.target : document.body);
    if (!el) return;

    const cs = window.getComputedStyle(el);
    const cssText = 'font-family: ' + cs.fontFamily + ';\\n' +
      'font-size: ' + cs.fontSize + ';\\n' +
      'font-weight: ' + cs.fontWeight + ';\\n' +
      'line-height: ' + cs.lineHeight + ';\\n' +
      'color: ' + cs.color + ';';

    try {
      navigator.clipboard.writeText(cssText);
    } catch {}

    badge.innerHTML = '<div style="color:#34d399;font-weight:600;padding:4px 8px;">✓ CSS Copied to Clipboard!</div>';
    setTimeout(cleanup, 800);
  };

  document.addEventListener('mousemove', onHover, true);
  document.addEventListener('pointermove', onHover, true);
  document.addEventListener('click', onClick, true);
  document.addEventListener('keydown', onKey, true);
  if (document.documentElement) document.documentElement.style.cursor = 'help';
})();`;
