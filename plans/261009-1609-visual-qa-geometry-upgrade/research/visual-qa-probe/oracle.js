// PROTOTYPE oracle (throwaway): text-run + paint-order geometry, scroll-swept.
// Purpose: show which defects a text-level detector catches that box-level misses.
(() => {
  const vw = innerWidth, vh = innerHeight;
  const startY = scrollY;
  const out = { textCollision: [], coveredText: [], clippedText: [], flowOverlap: [] };
  const label = (el) => el.tagName.toLowerCase() + (el.className && typeof el.className === 'string' ? '.' + el.className.trim().split(/\s+/)[0] : '');
  const visible = (el) => el.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true });
  const range = document.createRange();
  const clipBox = (a) => {
    if (a === document.body) return { left: 0, right: vw, top: -Infinity, bottom: Infinity };
    const b = a.getBoundingClientRect();
    return { left: b.left + a.clientLeft, top: b.top + scrollY + a.clientTop, right: b.left + a.clientLeft + a.clientWidth, bottom: b.top + scrollY + a.clientTop + a.clientHeight };
  };
  // Portion of a line box that survives every overflow-clipping ancestor (hidden clamped lines → null).
  const visibleRect = (p, r) => {
    let v = { ...r };
    for (let a = p; a && a !== document.documentElement; a = a.parentElement) {
      const s = getComputedStyle(a);
      if (s.overflowX === 'visible' && s.overflowY === 'visible') continue;
      const b = clipBox(a);
      v = { left: Math.max(v.left, b.left), right: Math.min(v.right, b.right), top: Math.max(v.top, b.top), bottom: Math.min(v.bottom, b.bottom) };
      if (v.right - v.left < 1 || v.bottom - v.top < 1) return null;
    }
    v.width = v.right - v.left;
    v.height = v.bottom - v.top;
    return v;
  };

  const collectRuns = () => {
    const runs = [];
    const w = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    while (w.nextNode()) {
      const n = w.currentNode;
      if (!n.nodeValue.trim()) continue;
      const p = n.parentElement;
      if (!p || p.closest('script,style,noscript') || !visible(p)) continue;
      range.selectNodeContents(n);
      for (const r of range.getClientRects()) {
        if (r.width < 1 || r.height < 1) continue;
        const docR = { left: r.left, right: r.right, top: r.top + scrollY, bottom: r.bottom + scrollY, width: r.width, height: r.height };
        runs.push({ n, p, r: docR, vis: visibleRect(p, docR) });
      }
    }
    return runs;
  };
  const inter = (a, b) => Math.max(0, Math.min(a.right, b.right) - Math.max(a.left, b.left)) * Math.max(0, Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top));

  scrollTo(0, 0);
  const runs = collectRuns();

  // 1. text-vs-text: line boxes of different text nodes intersecting
  for (let i = 0; i < runs.length; i++) for (let j = i + 1; j < runs.length; j++) {
    const a = runs[i], b = runs[j];
    if (a.n === b.n || !a.vis || !b.vis) continue;
    const ia = inter(a.vis, b.vis);
    if (ia > 0.2 * Math.min(a.vis.width * a.vis.height, b.vis.width * b.vis.height)) {
      out.textCollision.push(`${label(a.p)} "${a.n.nodeValue.trim().slice(0, 24)}" x ${label(b.p)} "${b.n.nodeValue.trim().slice(0, 24)}"`);
    }
  }

  // 2. clipped text: line box partially cut by an overflow-clipping ancestor or the viewport edge
  const intended = (from, upto) => {
    for (let e = from; e; e = e.parentElement) {
      const s = getComputedStyle(e);
      if (s.textOverflow === 'ellipsis' || (s.webkitLineClamp && s.webkitLineClamp !== 'none')) return true;
      if (e === upto) break;
    }
    return false;
  };
  for (const run of runs) {
    const docRect = run.r;
    let clipped = null;
    for (let a = run.p; a && a !== document.documentElement; a = a.parentElement) {
      const s = getComputedStyle(a);
      if (s.overflowX === 'visible' && s.overflowY === 'visible') continue;
      if (/auto|scroll/.test(s.overflowX + s.overflowY)) break; // reachable by scrolling
      const box = clipBox(a);
      const overlaps = inter(docRect, box) > 0;
      const exceeds = docRect.left < box.left - 2 || docRect.right > box.right + 2 || docRect.top < box.top - 2 || docRect.bottom > box.bottom + 2;
      if (overlaps && exceeds && !intended(run.p, a)) { clipped = label(a); break; }
    }
    if (!clipped && (docRect.right > vw + 2 || docRect.left < -2) && docRect.left < vw) clipped = 'viewport';
    if (clipped) out.clippedText.push(`${label(run.p)} "${run.n.nodeValue.trim().slice(0, 24)}" cut by ${clipped}`);
  }

  // 3. covered text: paint-order hit test at line-box points, swept over the full page
  const opaque = (el) => {
    if (/^(IMG|VIDEO|CANVAS|SVG|IFRAME)$/.test(el.tagName)) return true;
    const s = getComputedStyle(el);
    if (s.backgroundImage !== 'none') return true;
    const m = s.backgroundColor.match(/rgba?\(([^)]+)\)/);
    if (!m) return false;
    const parts = m[1].split(',').map(Number);
    return (parts.length < 4 ? 1 : parts[3]) >= 0.5;
  };
  const docH = document.documentElement.scrollHeight;
  const seen = new Set();
  for (let y = 0; y < docH; y += vh) {
    scrollTo(0, y);
    for (const run of runs) {
      if (!run.vis) continue;
      const top = run.vis.top - scrollY, bottom = run.vis.bottom - scrollY;
      if (top < 0 || bottom > vh) continue;
      const cy = (top + bottom) / 2;
      for (const fx of [0.25, 0.5, 0.75]) {
        const cx = run.vis.left + run.vis.width * fx;
        if (cx < 0 || cx >= vw) continue;
        const hit = document.elementFromPoint(cx, cy);
        if (!hit || hit === run.p || run.p.contains(hit) || hit.contains(run.p)) continue;
        if (!opaque(hit)) continue;
        const key = run.n;
        if (seen.has(key)) continue;
        seen.add(key);
        out.coveredText.push(`${label(run.p)} "${run.n.nodeValue.trim().slice(0, 24)}" under ${label(hit)} @y=${Math.round(cy + scrollY)}`);
      }
    }
  }
  scrollTo(0, startY);

  // 4. in-flow siblings overlapping (negative margins / bad heights) — boxes, any depth
  for (const parent of [document.body, ...document.body.querySelectorAll('*')]) {
    const kids = [...parent.children].filter((k) => {
      const s = getComputedStyle(k);
      return visible(k) && (s.position === 'static' || s.position === 'relative') && s.float === 'none' && s.transform === 'none';
    });
    for (let i = 0; i < kids.length; i++) for (let j = i + 1; j < kids.length; j++) {
      const a = kids[i].getBoundingClientRect(), b = kids[j].getBoundingClientRect();
      const ix = Math.min(a.right, b.right) - Math.max(a.left, b.left);
      const iy = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
      if (ix > 4 && iy > 4) out.flowOverlap.push(`${label(kids[i])} x ${label(kids[j])} (${Math.round(ix)}x${Math.round(iy)}px)`);
    }
  }
  return out;
})()
