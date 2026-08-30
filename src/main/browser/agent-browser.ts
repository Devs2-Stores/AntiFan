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
  const STYLE_ID = '__antifan_agent_style__';

  function ensureStyles() {
    let style = document.getElementById(STYLE_ID);
    if (!style) {
      style = document.createElement('style');
      style.id = STYLE_ID;
      style.textContent = \`
        @keyframes antifan_cursor_glow {
          0%, 100% { transform: scale(1); opacity: 0.85; }
          50% { transform: scale(1.35); opacity: 0.35; }
        }
        @keyframes antifan_pulse_ring {
          0% { transform: translate(-50%, -50%) scale(1); opacity: 1; }
          100% { transform: translate(-50%, -50%) scale(5.5); opacity: 0; }
        }
        #__antifan_agent_overlay__ {
          position: fixed !important;
          top: 0 !important;
          left: 0 !important;
          width: 100vw !important;
          height: 100vh !important;
          pointer-events: none !important;
          z-index: 2147483646 !important;
          overflow: hidden !important;
          border: none !important;
          box-shadow: none !important;
          box-sizing: border-box !important;
          opacity: 0 !important;
          transition: opacity 0.4s ease !important;
        }
        #__antifan_agent_overlay__.active {
          opacity: 1 !important;
        }
        #__antifan_agent_cursor__ {
          position: fixed !important;
          top: 0;
          left: 0;
          width: 36px !important;
          height: 36px !important;
          transform: translate(-4px, -2px) !important;
          transition: left 0.55s cubic-bezier(0.16, 1, 0.3, 1), top 0.55s cubic-bezier(0.16, 1, 0.3, 1), opacity 0.35s ease !important;
          pointer-events: none !important;
          z-index: 2147483647 !important;
          display: block !important;
          opacity: 0;
          will-change: left, top, transform;
        }
        #__antifan_agent_banner__ {
          position: fixed !important;
          top: 16px !important;
          left: 50% !important;
          transform: translateX(-50%) translateY(-30px);
          background: rgba(10, 18, 36, 0.96) !important;
          border: 1.5px solid #00f0ff !important;
          color: #ffffff !important;
          padding: 8px 20px !important;
          border-radius: 24px !important;
          font: 600 13px/1.3 system-ui, -apple-system, sans-serif !important;
          box-shadow: 0 12px 32px rgba(0, 0, 0, 0.75), 0 0 24px rgba(0, 240, 255, 0.4) !important;
          pointer-events: none !important;
          z-index: 2147483647 !important;
          opacity: 0;
          transition: all 0.28s cubic-bezier(0.2, 0.8, 0.2, 1) !important;
          display: flex !important;
          align-items: center !important;
          gap: 8px !important;
          backdrop-filter: blur(10px) !important;
        }
        #__antifan_agent_highlight__ {
          position: fixed !important;
          border: 2px solid #00f0ff !important;
          background: rgba(0, 240, 255, 0.12) !important;
          border-radius: 6px !important;
          box-shadow: 0 0 0 3px rgba(10, 15, 30, 0.85), 0 0 24px rgba(0, 240, 255, 0.5) !important;
          pointer-events: none !important;
          z-index: 2147483645 !important;
          display: none;
          opacity: 0;
          transition: all 0.2s cubic-bezier(0.2, 0.8, 0.2, 1), opacity 0.35s ease !important;
        }
      \`;
      (document.head || document.documentElement).appendChild(style);
    }
  }

  function ensureOverlay() {
    ensureStyles();
    let ov = document.getElementById(OVERLAY_ID);
    const parent = document.body || document.documentElement;
    if (!ov) {
      ov = document.createElement('div');
      ov.id = OVERLAY_ID;
      parent.appendChild(ov);
    } else if (ov.parentElement !== parent) {
      parent.appendChild(ov);
    }
    return ov;
  }

  function ensureCursor(ov) {
    let cur = document.getElementById(CURSOR_ID);
    if (!cur || cur.parentElement !== ov) {
      if (cur) cur.remove();
      cur = document.createElement('div');
      cur.id = CURSOR_ID;
      cur.innerHTML = \`
        <div style="position:relative;width:100%;height:100%;pointer-events:none;">
          <div style="position:absolute;top:2px;left:4px;width:16px;height:16px;border-radius:50%;background:rgba(0,240,255,0.4);box-shadow:0 0 16px rgba(0,240,255,0.9);animation:antifan_cursor_glow 1.6s infinite ease-in-out;"></div>
          <svg viewBox="0 0 24 24" width="32" height="32" style="filter: drop-shadow(0 4px 14px rgba(0, 240, 255, 0.95)) drop-shadow(0 0 4px #000);pointer-events:none;">
            <path d="M4 2 L20 12 L12 14 L8 22 Z" fill="#00f0ff" stroke="#ffffff" stroke-width="2" stroke-linejoin="round" />
          </svg>
          <div id="__antifan_cursor_badge__" style="position:absolute;top:-10px;left:28px;background:rgba(10,15,30,0.96);border:1.5px solid #00f0ff;color:#00f0ff;padding:3px 9px;border-radius:12px;font:700 11px/1.2 'JetBrains Mono', Consolas, monospace;white-space:nowrap;box-shadow:0 6px 16px rgba(0,0,0,0.8), 0 0 12px rgba(0,240,255,0.4);display:flex;align-items:center;gap:5px;backdrop-filter:blur(6px);pointer-events:none;">
            <span>🤖 Agent</span>
          </div>
        </div>
      \`;
      ov.appendChild(cur);
    }
    return cur;
  }

  function ensureBanner(ov) {
    let ban = document.getElementById(BANNER_ID);
    if (!ban || ban.parentElement !== ov) {
      if (ban) ban.remove();
      ban = document.createElement('div');
      ban.id = BANNER_ID;
      ov.appendChild(ban);
    }
    return ban;
  }

  function ensureHighlight(ov) {
    let hl = document.getElementById(HIGHLIGHT_ID);
    if (!hl || hl.parentElement !== ov) {
      if (hl) hl.remove();
      hl = document.createElement('div');
      hl.id = HIGHLIGHT_ID;
      ov.appendChild(hl);
    }
    return hl;
  }
  let bannerTimer = null;
  let cursorTimer = null;
  let highlightTimer = null;
  let agentIdleTimer = null;

  function activateOverlay() {
    const ov = ensureOverlay();
    ov.classList.add('active');
    clearTimeout(agentIdleTimer);
    scheduleAgentIdleFadeout(30000);
    return ov;
  }

  function scheduleAgentIdleFadeout(delayMs = 60000) {
    clearTimeout(agentIdleTimer);
    agentIdleTimer = setTimeout(() => {
      window.__antifanAgentClear();
    }, delayMs);
  }
  function scheduleHighlightFadeout(delayMs = 2500) {
    clearTimeout(highlightTimer);
    highlightTimer = setTimeout(() => {
      const hl = document.getElementById(HIGHLIGHT_ID);
      if (hl) {
        hl.style.opacity = '0';
        setTimeout(() => {
          if (hl && hl.style.opacity === '0') hl.style.display = 'none';
        }, 360);
      }
    }, delayMs);
  }
  function showBanner(text, icon = '🤖') {
    const ov = ensureOverlay();
    const ban = ensureBanner(ov);
    ban.innerHTML = \`<span style="font-size:16px;">\${icon}</span> <span>\${text}</span>\`;
    ban.style.opacity = '1';
    ban.style.transform = 'translateX(-50%) translateY(0)';
    if (bannerTimer) clearTimeout(bannerTimer);
    bannerTimer = setTimeout(() => {
      if (ban) {
        ban.style.opacity = '0';
        ban.style.transform = 'translateX(-50%) translateY(-30px)';
      }
    }, 3500);
  }

  function highlightElement(el) {
    if (!el) return;
    const ov = ensureOverlay();
    const hl = ensureHighlight(ov);
    const rect = el.getBoundingClientRect();
    if (highlightTimer) clearTimeout(highlightTimer);
    hl.style.display = 'block';
    hl.style.opacity = '1';
    hl.style.left = Math.max(0, rect.left - 3) + 'px';
    hl.style.top = Math.max(0, rect.top - 3) + 'px';
    hl.style.width = (rect.width + 6) + 'px';
    hl.style.height = (rect.height + 6) + 'px';
    scheduleHighlightFadeout(2500);
  }

  function createClickRipple(x, y) {
    const ov = ensureOverlay();
    const ripple = document.createElement('div');
    ripple.style.cssText = [
      'position: fixed !important',
      'left: ' + x + 'px !important',
      'top: ' + y + 'px !important',
      'width: 14px !important',
      'height: 14px !important',
      'border-radius: 50% !important',
      'background: rgba(0, 240, 255, 0.85) !important',
      'border: 2.5px solid #ffffff !important',
      'transform: translate(-50%, -50%) scale(1) !important',
      'pointer-events: none !important',
      'z-index: 2147483647 !important',
      'box-shadow: 0 0 20px #00f0ff !important',
      'transition: transform 0.5s cubic-bezier(0.1, 0.9, 0.2, 1), opacity 0.5s ease !important',
      'opacity: 1 !important',
    ].join(';');
    ov.appendChild(ripple);

    requestAnimationFrame(() => {
      ripple.style.transform = 'translate(-50%, -50%) scale(7.5)';
      ripple.style.opacity = '0';
    });

    setTimeout(() => ripple.remove(), 550);
  }

  // Ref Map cache for interactive snapshot
  if (!window.__antifanRefMap) {
    window.__antifanRefMap = new Map();
  }

  // Global element viewport rect resolver across nested iframes
  function getElementGlobalRect(el) {
    if (!el || typeof el.getBoundingClientRect !== 'function') return null;
    const rect = el.getBoundingClientRect();
    let currentWin = el.ownerDocument ? el.ownerDocument.defaultView : null;
    let offsetX = 0;
    let offsetY = 0;

    while (currentWin && currentWin !== window && currentWin.frameElement) {
      const frameEl = currentWin.frameElement;
      const frameRect = frameEl.getBoundingClientRect();
      offsetX += frameRect.left;
      offsetY += frameRect.top;
      currentWin = frameEl.ownerDocument ? frameEl.ownerDocument.defaultView : null;
    }

    return {
      left: rect.left + offsetX,
      top: rect.top + offsetY,
      right: rect.right + offsetX,
      bottom: rect.bottom + offsetY,
      width: rect.width,
      height: rect.height,
      centerX: rect.left + offsetX + rect.width / 2,
      centerY: rect.top + offsetY + rect.height / 2,
    };
  }

  // Deep selector helper for Shadow DOM & @ref resolution
  function querySelectorDeep(selectorOrRef) {
    if (!selectorOrRef) return null;
    const str = String(selectorOrRef).trim();
    if (str.startsWith('@e')) {
      if (window.__antifanRefMap && window.__antifanRefMap.has(str)) {
        const entry = window.__antifanRefMap.get(str);
        const node = entry && (entry.node || entry);
        if (node && node.isConnected) return node;
      }
      const tagged = document.querySelector('[data-antifan-ref="' + str + '"]');
      if (tagged) return tagged;
      const iframes = Array.from(document.querySelectorAll('iframe'));
      for (const ifr of iframes) {
        try {
          const doc = ifr.contentDocument || ifr.contentWindow?.document;
          if (doc) {
            const inFrame = doc.querySelector('[data-antifan-ref="' + str + '"]');
            if (inFrame) return inFrame;
          }
        } catch {}
      }
    }

    let el = null;
    try {
      el = document.querySelector(str);
    } catch {}
    if (el) return el;

    function searchShadow(root) {
      if (!root) return null;
      try {
        const direct = root.querySelector(str);
        if (direct) return direct;
      } catch {}
      const hosts = root.querySelectorAll('*');
      for (let i = 0; i < hosts.length; i++) {
        if (hosts[i].shadowRoot) {
          const res = searchShadow(hosts[i].shadowRoot);
          if (res) return res;
        }
      }
      return null;
    }
    return searchShadow(document);
  }

  window.__antifanAgentSnapshot = () => {
    if (!window.__antifanRefMap) window.__antifanRefMap = new Map();
    window.__antifanRefMap.clear();

    const clearOldRefs = (doc) => {
      try {
        doc.querySelectorAll('[data-antifan-ref]').forEach((node) => {
          node.removeAttribute('data-antifan-ref');
        });
      } catch {}
    };
    clearOldRefs(document);

    const selector = 'button, a[href], input, textarea, select, [role="button"], [role="link"], [role="tab"], [role="checkbox"], [role="menuitem"], [tabindex]:not([tabindex="-1"])';
    const lines = [];
    let refIndex = 1;

    const scanContainer = (container, rootDoc, framePath = '') => {
      if (!container) return;
      const elements = Array.from(container.querySelectorAll('*'));
      for (const node of elements) {
        if (node.id === OVERLAY_ID || node.id === CURSOR_ID || node.id === BANNER_ID || node.id === HIGHLIGHT_ID) continue;
        if (node.closest && node.closest('#' + OVERLAY_ID)) continue;

        if (node.shadowRoot) {
          scanContainer(node.shadowRoot, rootDoc, framePath);
        }

        if (node.matches && node.matches(selector)) {
          try {
            const rect = node.getBoundingClientRect();
            if (rect.width === 0 || rect.height === 0) continue;
            const style = (rootDoc.defaultView || window).getComputedStyle(node);
            if (style.visibility === 'hidden' || style.display === 'none' || style.opacity === '0') continue;

            const ref = '@e' + refIndex++;
            node.setAttribute('data-antifan-ref', ref);
            window.__antifanRefMap.set(ref, { node, framePath });

            const tag = node.tagName.toLowerCase();
            const role = node.getAttribute('role') || tag;
            const type = node.getAttribute('type') || '';
            const label = (node.innerText || node.getAttribute('aria-label') || node.getAttribute('placeholder') || node.getAttribute('title') || node.getAttribute('value') || '').trim().replace(/\\s+/g, ' ').slice(0, 60);
            const sec = node.closest('[data-section-id]')?.getAttribute('data-section-id') || undefined;
            const prod = node.closest('[data-product-id]')?.getAttribute('data-product-id') || undefined;
            const block = node.closest('[data-block-id]')?.getAttribute('data-block-id') || undefined;

            let line = ref + ' [' + role + (type ? ':' + type : '') + '] ' + (label ? '"' + label + '"' : '');
            const meta = [];
            if (node.id) meta.push('id: "' + node.id + '"');
            if (sec) meta.push('section: "' + sec + '"');
            if (prod) meta.push('product: "' + prod + '"');
            if (block) meta.push('block: "' + block + '"');
            if (framePath) meta.push('frame: "' + framePath + '"');
            if (meta.length > 0) {
              line += ' (' + meta.join(', ') + ')';
            }
            lines.push(line);
            if (lines.length >= 150) return;
          } catch {}
        }

        if (node.tagName && node.tagName.toLowerCase() === 'iframe') {
          try {
            const frameDoc = node.contentDocument || node.contentWindow?.document;
            if (frameDoc) {
              clearOldRefs(frameDoc);
              const frameId = node.id || node.name || ('iframe-' + lines.length);
              const nextPath = framePath ? framePath + ' > ' + frameId : frameId;
              scanContainer(frameDoc, frameDoc, nextPath);
            }
          } catch {}
        }
      }
    };

    scanContainer(document, document, '');
    return lines.join('\\n');
  };
  // ─── Kinematics: Cubic Bézier Curve & Fitts's Law Engine ───
  function getCubicBezierPoint(p0, p1, p2, p3, t) {
    const u = 1 - t;
    const tt = t * t;
    const uu = u * u;
    const uuu = uu * u;
    const ttt = tt * t;
    return {
      x: uuu * p0.x + 3 * uu * t * p1.x + 3 * u * tt * p2.x + ttt * p3.x,
      y: uuu * p0.y + 3 * uu * t * p1.y + 3 * u * tt * p2.y + ttt * p3.y,
    };
  }

  function generateBezierPath(start, end, numPoints = 25) {
    const dx = end.x - start.x;
    const dy = end.y - start.y;
    const dist = Math.hypot(dx, dy);
    if (dist < 4) {
      return [start, end];
    }

    // Generate organic perpendicular control points
    const perpX = -dy / dist;
    const perpY = dx / dist;
    const curveMagnitude = Math.min(60, dist * 0.25) * (Math.random() > 0.5 ? 1 : -1) * (0.4 + Math.random() * 0.6);

    const p1 = {
      x: start.x + dx * 0.3 + perpX * curveMagnitude,
      y: start.y + dy * 0.3 + perpY * curveMagnitude,
    };
    const p2 = {
      x: start.x + dx * 0.75 + perpX * (curveMagnitude * 0.5),
      y: start.y + dy * 0.75 + perpY * (curveMagnitude * 0.5),
    };

    const points = [];
    for (let i = 0; i <= numPoints; i++) {
      // Ease-in-out bell-shaped acceleration (Fitts's Law approximation)
      const linearT = i / numPoints;
      const easedT = linearT < 0.5 ? 2 * linearT * linearT : 1 - Math.pow(-2 * linearT + 2, 2) / 2;
      const pt = getCubicBezierPoint(start, p1, p2, end, easedT);
      // Add slight micro-jitter (tremor)
      if (i > 0 && i < numPoints) {
        pt.x += (Math.random() - 0.5) * 0.8;
        pt.y += (Math.random() - 0.5) * 0.8;
      }
      points.push(pt);
    }
    return points;
  }

  let activeTrajectoryCancel = null;
  let ambientWanderingTimer = null;

  function startAmbientWandering(cur) {
    stopAmbientWandering();
    function wander() {
      if (!cur || cur.style.opacity === '0' || cur.style.display === 'none') return;
      const curX = parseFloat(cur.style.left) || window.innerWidth / 2;
      const curY = parseFloat(cur.style.top) || window.innerHeight / 2;
      const driftX = (Math.random() - 0.5) * 8;
      const driftY = (Math.random() - 0.5) * 6;
      cur.style.transition = 'left 1.2s ease-in-out, top 1.2s ease-in-out';
      cur.style.left = (curX + driftX) + 'px';
      cur.style.top = (curY + driftY) + 'px';
      ambientWanderingTimer = setTimeout(wander, 1400 + Math.random() * 800);
    }
    ambientWanderingTimer = setTimeout(wander, 2000);
  }

  function stopAmbientWandering() {
    if (ambientWanderingTimer) {
      clearTimeout(ambientWanderingTimer);
      ambientWanderingTimer = null;
    }
  }

  window.__antifanAgentMove = (xOrSelector, y, label) => {
    let targetX = typeof xOrSelector === 'number' ? xOrSelector : null;
    let targetY = typeof y === 'number' ? y : null;
    let actionLabel = label;

    if (typeof xOrSelector === 'string' && xOrSelector) {
      const el = querySelectorDeep(xOrSelector);
      if (el) {
        el.scrollIntoView({ behavior: 'smooth', block: 'center', inline: 'center' });
        const r = el.getBoundingClientRect();
        targetX = r.left + r.width / 2;
        targetY = r.top + r.height / 2;
        if (typeof y === 'string' && !label) {
          actionLabel = y;
        }
      } else if (typeof targetX !== 'number' || typeof targetY !== 'number') {
        return false;
      }
    }

    if (typeof targetX !== 'number' || typeof targetY !== 'number') {
      return false;
    }

    const ov = activateOverlay();
    const cur = ensureCursor(ov);
    clearTimeout(cursorTimer);
    stopAmbientWandering();
    if (actionLabel) {
      const badge = cur.querySelector('#__antifan_cursor_badge__');
      if (badge) badge.innerHTML = '<span>🤖 ' + actionLabel + '</span>';
    }

    // If cursor was not initialized or is hidden, spawn nearby and smoothly glide in
    const isHidden = !cur.__antifanInitialized || cur.style.opacity === '0' || cur.style.display === 'none';
    if (isHidden) {
      cur.__antifanInitialized = true;
      cur.style.display = 'block';
      const startX = targetX > 150 ? targetX - 120 : targetX + 120;
      const startY = targetY > 150 ? targetY - 100 : targetY + 100;
      cur.style.transition = 'none';
      cur.style.left = startX + 'px';
      cur.style.top = startY + 'px';
      cur.style.opacity = '0.4';
      void cur.offsetHeight; // Force layout
      
      requestAnimationFrame(() => {
        cur.style.transition = 'left 0.55s cubic-bezier(0.16, 1, 0.3, 1), top 0.55s cubic-bezier(0.16, 1, 0.3, 1), opacity 0.35s ease';
        cur.style.opacity = '1';
        cur.style.left = targetX + 'px';
        cur.style.top = targetY + 'px';
      });
      scheduleAgentIdleFadeout(60000);
      startAmbientWandering(cur);
      return true;
    }

    // Smooth glide from current position to new target
    cur.style.display = 'block';
    cur.style.opacity = '1';
    cur.style.left = targetX + 'px';
    cur.style.top = targetY + 'px';
    scheduleAgentIdleFadeout(60000);
    startAmbientWandering(cur);
    return true;
  };

  window.__antifanAgentTrajectory = async (steps = [], options = {}) => {
    if (!Array.isArray(steps) || steps.length === 0) {
      return { success: false, executedSteps: 0, totalSteps: 0, reason: 'Empty steps array' };
    }

    if (activeTrajectoryCancel) {
      activeTrajectoryCancel();
      activeTrajectoryCancel = null;
    }

    let isCancelled = false;
    activeTrajectoryCancel = () => { isCancelled = true; };

    const ov = activateOverlay();
    const cur = ensureCursor(ov);
    cur.__antifanInitialized = true;
    cur.style.display = 'block';
    cur.style.opacity = '1';
    stopAmbientWandering();

    let currentX = parseFloat(cur.style.left) || window.innerWidth / 2;
    let currentY = parseFloat(cur.style.top) || window.innerHeight / 2;
    let executedCount = 0;

    const baseDuration = options.speed === 'fast' ? 220 : (options.speed === 'slow' ? 650 : 380);

    for (let idx = 0; idx < steps.length; idx++) {
      if (isCancelled) {
        return { success: false, executedSteps: executedCount, totalSteps: steps.length, reason: 'Cancelled by user or navigation' };
      }

      const step = steps[idx];
      let targetX = typeof step.x === 'number' ? step.x : null;
      let targetY = typeof step.y === 'number' ? step.y : null;
      let targetEl = null;

      const selector = step.target || step.selector;
      if (selector) {
        targetEl = querySelectorDeep(selector);
        if (targetEl) {
          if (options.smoothScroll !== false) {
            targetEl.scrollIntoView({ behavior: 'smooth', block: 'center', inline: 'center' });
          }
          const rect = targetEl.getBoundingClientRect();
          targetX = rect.left + rect.width / 2;
          targetY = rect.top + rect.height / 2;
        }
      }

      if (typeof targetX !== 'number' || typeof targetY !== 'number') {
        targetX = currentX;
        targetY = currentY;
      }

      // Update Badge & Banner
      const badgeLabel = step.label || step.action || ('Step ' + (idx + 1));
      const badge = cur.querySelector('#__antifan_cursor_badge__');
      if (badge) badge.innerHTML = '<span>🤖 ' + badgeLabel + '</span>';
      showBanner(badgeLabel, step.action === 'click' ? '👆' : (step.action === 'type' ? '⌨️' : (step.action === 'scroll' ? '📜' : '🎯')));

      // Generate and animate along Cubic Bézier curve
      const startPt = { x: currentX, y: currentY };
      const endPt = { x: targetX, y: targetY };
      const bezierPoints = generateBezierPath(startPt, endPt, 18);

      const stepDuration = Math.max(120, baseDuration * Math.min(1.5, Math.max(0.4, Math.hypot(endPt.x - startPt.x, endPt.y - startPt.y) / 400)));
      const timePerPoint = stepDuration / bezierPoints.length;

      for (let p = 0; p < bezierPoints.length; p++) {
        if (isCancelled) break;
        const pt = bezierPoints[p];
        cur.style.transition = 'none';
        cur.style.left = pt.x + 'px';
        cur.style.top = pt.y + 'px';
        await new Promise((r) => setTimeout(r, timePerPoint));
      }

      currentX = targetX;
      currentY = targetY;

      // Execute the waypoint action
      if (targetEl && (step.action === 'hover' || step.action === 'click' || step.action === 'type' || !step.action)) {
        highlightElement(targetEl);
      }

      if (step.action === 'click') {
        createClickRipple(targetX, targetY);
        if (targetEl) {
          targetEl.focus();
          targetEl.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, clientX: targetX, clientY: targetY }));
          targetEl.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true, clientX: targetX, clientY: targetY }));
          if (typeof targetEl.click === 'function') {
            targetEl.click();
          } else {
            targetEl.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, clientX: targetX, clientY: targetY }));
          }
        } else {
          const elAtPoint = document.elementFromPoint(targetX, targetY);
          if (elAtPoint) {
            if (typeof elAtPoint.click === 'function') {
              elAtPoint.click();
            } else {
              elAtPoint.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, clientX: targetX, clientY: targetY }));
            }
          }
        }
      } else if (step.action === 'type' && typeof step.text === 'string') {
        if (targetEl) {
          targetEl.focus();
          for (let c = 0; c < step.text.length; c++) {
            const ch = step.text[c];
            if ('value' in targetEl) {
              targetEl.value += ch;
              targetEl.dispatchEvent(new Event('input', { bubbles: true }));
              targetEl.dispatchEvent(new Event('change', { bubbles: true }));
            } else {
              targetEl.textContent += ch;
            }
            await new Promise((r) => setTimeout(r, 20));
          }
        }
      } else if (step.action === 'scroll' && typeof step.deltaY === 'number') {
        window.scrollBy({ top: step.deltaY, behavior: 'smooth' });
      }

      const dwell = typeof step.dwellMs === 'number' ? step.dwellMs : (step.action === 'click' ? 150 : 80);
      if (dwell > 0) {
        await new Promise((r) => setTimeout(r, dwell));
      }

      executedCount++;
    }

    activeTrajectoryCancel = null;
    scheduleAgentIdleFadeout(60000);
    startAmbientWandering(cur);

    return {
      success: true,
      executedSteps: executedCount,
      totalSteps: steps.length,
      finalPosition: { x: currentX, y: currentY },
    };
  };

  window.__antifanAgentClick = (selector, x, y, label) => {
    let targetX = x;
    let targetY = y;
    let targetEl = null;

    if (selector) {
      targetEl = querySelectorDeep(selector);
      if (targetEl) {
        if (typeof targetEl.scrollIntoView === 'function') {
          targetEl.scrollIntoView({ behavior: 'smooth', block: 'center', inline: 'center' });
        }
        const gRect = getElementGlobalRect(targetEl);
        if (gRect) {
          targetX = gRect.centerX;
          targetY = gRect.centerY;
        }
        highlightElement(targetEl);
      } else if (typeof targetX !== 'number' || typeof targetY !== 'number') {
        return false;
      }
    }

    if (typeof targetX === 'number' && typeof targetY === 'number') {
      window.__antifanAgentMove(targetX, targetY, label || 'Clicking...');
      showBanner(label || ('Clicking ' + (selector || 'at (' + Math.round(targetX) + ', ' + Math.round(targetY) + ')')), '👆');
      
      setTimeout(() => {
        createClickRipple(targetX, targetY);
        if (targetEl) {
          if (typeof targetEl.focus === 'function') targetEl.focus();
          targetEl.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, clientX: targetX, clientY: targetY }));
          targetEl.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true, clientX: targetX, clientY: targetY }));
          if (typeof targetEl.click === 'function') {
            targetEl.click();
          } else {
            targetEl.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, clientX: targetX, clientY: targetY }));
          }
        } else {
          const elAtPoint = document.elementFromPoint(targetX, targetY);
          if (elAtPoint) {
            if (typeof elAtPoint.click === 'function') {
              elAtPoint.click();
            } else {
              elAtPoint.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, clientX: targetX, clientY: targetY }));
            }
          }
        }
      }, 450);
      return true;
    }
    return false;
  };

  window.__antifanAgentHover = (selector, x, y, label) => {
    let targetX = x;
    let targetY = y;
    if (selector) {
      const el = querySelectorDeep(selector);
      if (el) {
        if (typeof el.scrollIntoView === 'function') {
          el.scrollIntoView({ behavior: 'smooth', block: 'center', inline: 'center' });
        }
        const gRect = getElementGlobalRect(el);
        if (gRect) {
          targetX = gRect.centerX;
          targetY = gRect.centerY;
        }
        highlightElement(el);
      } else if (typeof targetX !== 'number' || typeof targetY !== 'number') {
        return false;
      }
    }
    if (typeof targetX === 'number' && typeof targetY === 'number') {
      window.__antifanAgentMove(targetX, targetY, label || 'Hovering');
      showBanner(label || ('Hovering ' + (selector || 'at (' + Math.round(targetX) + ', ' + Math.round(targetY) + ')')), '👀');
      return true;
    }
    return false;
  };

  window.__antifanAgentType = async (selector, text, clear = false) => {
    const el = selector ? querySelectorDeep(selector) : document.activeElement;
    if (!el) return false;

    if (typeof el.scrollIntoView === 'function') {
      el.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
    const gRect = getElementGlobalRect(el);
    if (gRect) {
      window.__antifanAgentMove(gRect.centerX, gRect.centerY, 'Typing...');
    }
    showBanner('Typing: "' + text.slice(0, 32) + (text.length > 32 ? '...' : '') + '"', '⌨️');
    highlightElement(el);

    if (typeof el.focus === 'function') el.focus();
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
      await new Promise((resolve) => setTimeout(resolve, 30));
    }
    return true;
  };

  window.__antifanAgentScroll = (deltaY = 400, selector) => {
    if (selector) {
      const el = querySelectorDeep(selector);
      if (el) {
        el.scrollIntoView({ behavior: 'smooth', block: 'center' });
        showBanner('Scrolled to ' + selector, '📜');
        setTimeout(() => {
          const rect = el.getBoundingClientRect();
          window.__antifanAgentMove(rect.left + rect.width / 2, rect.top + rect.height / 2, 'Scrolled target');
        }, 320);
        return true;
      }
      return false;
    }
    window.__antifanAgentMove(Math.max(30, window.innerWidth / 2), Math.max(30, window.innerHeight / 2), 'Scrolling...');
    window.scrollBy({ top: deltaY, behavior: 'smooth' });
    showBanner('Scrolling ' + (deltaY > 0 ? 'down ' : 'up ') + Math.abs(deltaY) + 'px', '📜');
    return true;
  };
  window.__antifanAgentActive = () => {
    activateOverlay();
    return true;
  };
  window.__antifanAgentHighlight = (selector, label) => {
    if (!selector) return false;
    const el = querySelectorDeep(selector);
    if (el) {
      el.scrollIntoView({ behavior: 'smooth', block: 'center' });
      const rect = el.getBoundingClientRect();
      window.__antifanAgentMove(rect.left + rect.width / 2, rect.top + rect.height / 2, label || 'Inspecting...');
      highlightElement(el);
      showBanner(label || ('Highlighted ' + selector), '🎯');
      return true;
    }
    return false;
  };
  window.__antifanAgentClear = () => {
    stopAmbientWandering();
    clearTimeout(cursorTimer);
    clearTimeout(highlightTimer);
    clearTimeout(bannerTimer);
    clearTimeout(agentIdleTimer);
    const ov = document.getElementById(OVERLAY_ID);
    const cur = document.getElementById(CURSOR_ID);
    const hl = document.getElementById(HIGHLIGHT_ID);
    const ban = document.getElementById(BANNER_ID);
    if (ov) ov.classList.remove('active');
    if (cur) {
      cur.style.opacity = '0';
      setTimeout(() => {
        if (cur && cur.style.opacity === '0') cur.style.display = 'none';
      }, 400);
    }
    if (hl) {
      hl.style.opacity = '0';
      setTimeout(() => {
        if (hl && hl.style.opacity === '0') hl.style.display = 'none';
      }, 400);
    }
    if (ban) {
      ban.style.opacity = '0';
      ban.style.transform = 'translateX(-50%) translateY(-30px)';
    }
  };
})();`;
