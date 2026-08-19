/**
 * AntiFan Browser Desktop — Agent Browser (Chromium Web Automation & Visual AI Cursor)
 * Complete Antigravity Agent Browser parity:
 * Renders an animated glowing AI Agent cursor, action banners, ripple click pulses,
 * typing indicators, visual scrolling, and real DOM event automation.
 */

export const AGENT_BROWSER_SCRIPT = `(() => {
  const OVERLAY_ID = '__antifan_agent_overlay__';
  const CURSOR_ID = '__antifan_agent_cursor__';
  const BANNER_ID = '__antifan_agent_banner__';
  const HIGHLIGHT_ID = '__antifan_agent_highlight__';

  let overlay = document.getElementById(OVERLAY_ID);
  if (!overlay) {
    overlay = document.createElement('div');
    overlay.id = OVERLAY_ID;
    overlay.style.cssText = 'position:fixed;top:0;left:0;width:100vw;height:100vh;pointer-events:none;z-index:2147483646;overflow:hidden;';
    document.documentElement.appendChild(overlay);
  }

  // 1. Agent Cursor Element (Glowing pointer + pulse wave + label)
  let cursor = document.getElementById(CURSOR_ID);
  if (!cursor) {
    cursor = document.createElement('div');
    cursor.id = CURSOR_ID;
    cursor.style.cssText = [
      'position: fixed',
      'top: 0',
      'left: 0',
      'width: 28px',
      'height: 28px',
      'transform: translate(-4px, -4px)',
      'transition: left 0.28s cubic-bezier(0.2, 0.8, 0.2, 1), top 0.28s cubic-bezier(0.2, 0.8, 0.2, 1)',
      'pointer-events: none',
      'z-index: 2147483647',
      'display: none',
    ].join(';');

    cursor.innerHTML = \`
      <div style="position:relative;width:100%;height:100%;">
        <svg viewBox="0 0 24 24" width="28" height="28" style="filter: drop-shadow(0 4px 10px rgba(56, 189, 248, 0.8));">
          <path d="M4 2 L20 12 L12 14 L8 22 Z" fill="#38bdf8" stroke="#ffffff" stroke-width="1.8" stroke-linejoin="round" />
        </svg>
        <div id="__antifan_cursor_badge__" style="position:absolute;top:-8px;left:24px;background:#0f172a;border:1px solid #38bdf8;color:#38bdf8;padding:2px 7px;border-radius:10px;font:700 10px/1.2 monospace;white-space:nowrap;box-shadow:0 4px 12px rgba(0,0,0,0.6);display:flex;align-items:center;gap:4px;">
          <span>🤖 Agent</span>
        </div>
      </div>
    \`;
    overlay.appendChild(cursor);
  }

  // 2. Agent Action Banner (Top-center floating notification)
  let banner = document.getElementById(BANNER_ID);
  if (!banner) {
    banner = document.createElement('div');
    banner.id = BANNER_ID;
    banner.style.cssText = [
      'position: fixed',
      'top: 14px',
      'left: 50%',
      'transform: translateX(-50%) translateY(-20px)',
      'background: rgba(15, 23, 42, 0.95)',
      'border: 1.5px solid #38bdf8',
      'color: #f1f5f9',
      'padding: 6px 16px',
      'border-radius: 20px',
      'font: 600 12px/1.3 system-ui, -apple-system, sans-serif',
      'box-shadow: 0 10px 30px rgba(0, 0, 0, 0.6), 0 0 20px rgba(56, 189, 248, 0.3)',
      'pointer-events: none',
      'z-index: 2147483647',
      'opacity: 0',
      'transition: all 0.25s cubic-bezier(0.2, 0.8, 0.2, 1)',
      'display: flex',
      'align-items: center',
      'gap: 8px',
    ].join(';');
    overlay.appendChild(banner);
  }

  let bannerTimer = null;
  function showBanner(text, icon = '🤖') {
    if (!banner) return;
    banner.innerHTML = \`<span style="font-size:14px;">\${icon}</span> <span>\${text}</span>\`;
    banner.style.opacity = '1';
    banner.style.transform = 'translateX(-50%) translateY(0)';
    if (bannerTimer) clearTimeout(bannerTimer);
    bannerTimer = setTimeout(() => {
      if (banner) {
        banner.style.opacity = '0';
        banner.style.transform = 'translateX(-50%) translateY(-20px)';
      }
    }, 2400);
  }

  // 3. Highlight Overlay Box
  let highlightBox = document.getElementById(HIGHLIGHT_ID);
  if (!highlightBox) {
    highlightBox = document.createElement('div');
    highlightBox.id = HIGHLIGHT_ID;
    highlightBox.style.cssText = [
      'position: absolute',
      'border: 2px solid #38bdf8',
      'background: rgba(56, 189, 248, 0.12)',
      'border-radius: 4px',
      'box-shadow: 0 0 0 3px rgba(15, 23, 42, 0.8), 0 0 16px rgba(56, 189, 248, 0.4)',
      'pointer-events: none',
      'z-index: 2147483645',
      'display: none',
      'transition: all 0.2s ease',
    ].join(';');
    overlay.appendChild(highlightBox);
  }

  function highlightElement(el, label) {
    if (!el || !highlightBox) return;
    const rect = el.getBoundingClientRect();
    highlightBox.style.display = 'block';
    highlightBox.style.left = (rect.left + window.scrollX - 2) + 'px';
    highlightBox.style.top = (rect.top + window.scrollY - 2) + 'px';
    highlightBox.style.width = (rect.width + 4) + 'px';
    highlightBox.style.height = (rect.height + 4) + 'px';
  }

  // 4. Click Wave Pulse Animation
  function createClickRipple(x, y) {
    const ripple = document.createElement('div');
    ripple.style.cssText = [
      'position: fixed',
      'left: ' + x + 'px',
      'top: ' + y + 'px',
      'width: 8px',
      'height: 8px',
      'border-radius: 50%',
      'background: rgba(56, 189, 248, 0.8)',
      'border: 2px solid #ffffff',
      'transform: translate(-50%, -50%) scale(1)',
      'pointer-events: none',
      'z-index: 2147483647',
      'box-shadow: 0 0 16px #38bdf8',
      'transition: transform 0.45s cubic-bezier(0.1, 0.9, 0.2, 1), opacity 0.45s ease',
      'opacity: 1',
    ].join(';');
    overlay.appendChild(ripple);

    requestAnimationFrame(() => {
      ripple.style.transform = 'translate(-50%, -50%) scale(6)';
      ripple.style.opacity = '0';
    });

    setTimeout(() => ripple.remove(), 500);
  }

  // 5. Global Agent API Functions
  window.__antifanAgentMove = (x, y, label) => {
    if (!cursor) return;
    cursor.style.display = 'block';
    cursor.style.left = x + 'px';
    cursor.style.top = y + 'px';
    if (label) {
      const badge = document.getElementById('__antifan_cursor_badge__');
      if (badge) badge.innerHTML = '<span>🤖 ' + label + '</span>';
    }
  };

  window.__antifanAgentClick = (selector, x, y, label) => {
    let targetX = x;
    let targetY = y;
    let targetEl = null;

    if (selector) {
      targetEl = document.querySelector(selector);
      if (targetEl) {
        targetEl.scrollIntoView({ behavior: 'smooth', block: 'center', inline: 'center' });
        const rect = targetEl.getBoundingClientRect();
        targetX = rect.left + rect.width / 2;
        targetY = rect.top + rect.height / 2;
        highlightElement(targetEl, label);
      }
    }

    if (typeof targetX === 'number' && typeof targetY === 'number') {
      window.__antifanAgentMove(targetX, targetY, label || 'Clicking...');
      showBanner(label || ('Clicking ' + (selector || 'at (' + Math.round(targetX) + ', ' + Math.round(targetY) + ')')), '👆');
      
      setTimeout(() => {
        createClickRipple(targetX, targetY);
        if (targetEl) {
          targetEl.focus();
          targetEl.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, clientX: targetX, clientY: targetY }));
          targetEl.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true, clientX: targetX, clientY: targetY }));
          targetEl.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, clientX: targetX, clientY: targetY }));
          if (typeof targetEl.click === 'function') targetEl.click();
        } else {
          const elAtPoint = document.elementFromPoint(targetX, targetY);
          if (elAtPoint) {
            elAtPoint.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, clientX: targetX, clientY: targetY }));
          }
        }
      }, 250);
    }
  };

  window.__antifanAgentType = async (selector, text, clear = false) => {
    const el = selector ? document.querySelector(selector) : document.activeElement;
    if (!el) return false;

    el.scrollIntoView({ behavior: 'smooth', block: 'center' });
    const rect = el.getBoundingClientRect();
    window.__antifanAgentMove(rect.left + rect.width / 2, rect.top + rect.height / 2, 'Typing...');
    showBanner('Typing into ' + (selector || 'input') + ': "' + text.slice(0, 30) + (text.length > 30 ? '...' : '') + '"', '⌨️');
    highlightElement(el);

    el.focus();
    if (clear) {
      if ('value' in el) (el).value = '';
      else el.textContent = '';
    }

    for (let i = 0; i < text.length; i++) {
      const char = text[i];
      if ('value' in el) {
        (el).value += char;
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
      } else {
        el.textContent += char;
      }
      await new Promise((r) => setTimeout(r, 25));
    }
    return true;
  };

  window.__antifanAgentScroll = (deltaY = 400, selector) => {
    if (selector) {
      const el = document.querySelector(selector);
      if (el) {
        el.scrollIntoView({ behavior: 'smooth', block: 'center' });
        showBanner('Scrolled to element ' + selector, '📜');
        return;
      }
    }
    window.scrollBy({ top: deltaY, behavior: 'smooth' });
    showBanner('Scrolling ' + (deltaY > 0 ? 'down ' : 'up ') + Math.abs(deltaY) + 'px', '📜');
  };

  window.__antifanAgentHighlight = (selector, label) => {
    if (!selector) return;
    const el = document.querySelector(selector);
    if (el) {
      el.scrollIntoView({ behavior: 'smooth', block: 'center' });
      highlightElement(el, label);
      showBanner(label || ('Highlighted ' + selector), '🎯');
    }
  };

  window.__antifanAgentClear = () => {
    if (cursor) cursor.style.display = 'none';
    if (highlightBox) highlightBox.style.display = 'none';
    if (banner) banner.style.opacity = '0';
  };
})();`;
