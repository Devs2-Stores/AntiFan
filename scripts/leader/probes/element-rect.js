// element-rect.js - read-only probe for anti.browser.evaluate.
// USAGE: first run a separate evaluate that sets the selector, e.g.
//     window.__PROBE_SELECTOR = ".product-card img"
//   (state persists on the page until it navigates), then run this file's expression.
//   Optional: window.__PROBE_LIMIT = 5 (default 5 elements).
// MEASURES: for each match: visible rect (clipped to the viewport), aspect ratio (w/h),
//   naturalWidth/Height for <img>/<video>, computed object-fit/object-position, and whether
//   the box is display:none, visibility:hidden or fully outside the viewport.
// DOES NOT PROVE: that the image looks right (crop quality), that the rect is the same at other
//   viewport widths, or anything about lazy images that have not loaded yet (naturalWidth 0
//   means "not loaded", not "broken"). Scroll the element into view and re-run for those.
(() => {
  const sel = window.__PROBE_SELECTOR;
  if (!sel) return { error: "set window.__PROBE_SELECTOR first (separate evaluate call)" };
  let nodes;
  try {
    nodes = [...document.querySelectorAll(sel)];
  } catch (e) {
    return { error: `invalid selector: ${e.message}` };
  }
  const limit = Number(window.__PROBE_LIMIT) > 0 ? Number(window.__PROBE_LIMIT) : 5;
  const vw = document.documentElement.clientWidth;
  const vh = document.documentElement.clientHeight;
  const items = nodes.slice(0, limit).map((el) => {
    const r = el.getBoundingClientRect();
    const cs = getComputedStyle(el);
    const visW = Math.max(0, Math.min(r.right, vw) - Math.max(r.left, 0));
    const visH = Math.max(0, Math.min(r.bottom, vh) - Math.max(r.top, 0));
    const o = {
      tag: el.tagName.toLowerCase(),
      rect: { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width * 10) / 10, h: Math.round(r.height * 10) / 10 },
      visibleRect: { w: Math.round(visW), h: Math.round(visH) },
      aspectRatio: r.height ? Math.round((r.width / r.height) * 1000) / 1000 : null,
      display: cs.display,
      visibility: cs.visibility,
      objectFit: cs.objectFit,
      objectPosition: cs.objectPosition,
      outsideViewport: visW === 0 || visH === 0,
    };
    if (el instanceof HTMLImageElement) {
      o.naturalWidth = el.naturalWidth;
      o.naturalHeight = el.naturalHeight;
      o.complete = el.complete;
      o.src = (el.currentSrc || el.src || "").slice(0, 140);
    } else if (el instanceof HTMLVideoElement) {
      o.naturalWidth = el.videoWidth;
      o.naturalHeight = el.videoHeight;
      o.src = (el.currentSrc || el.src || "").slice(0, 140);
    }
    return o;
  });
  return { selector: sel, matchCount: nodes.length, viewport: { w: vw, h: vh }, items };
})()
