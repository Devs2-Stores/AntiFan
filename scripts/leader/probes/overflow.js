// overflow.js - read-only probe for anti.browser.evaluate.
// MEASURES: horizontal overflow of the CURRENT viewport: documentElement/body scrollWidth vs
//   clientWidth, innerWidth, and up to 10 widest elements whose right edge exceeds the viewport.
// DOES NOT PROVE: anything about other viewport widths (set the viewport and run it once per
//   width), content that overflows only after interaction, or elements clipped by
//   overflow:hidden (they report no overflow but may hide content). Use anti.inspect.responsive_matrix
//   for the standard width sweep.
(() => {
  const de = document.documentElement;
  const b = document.body;
  const vw = de.clientWidth;
  const offenders = [];
  for (const el of document.querySelectorAll("body *")) {
    const r = el.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) continue;
    if (r.right > vw + 1) {
      const cs = getComputedStyle(el);
      if (cs.position === "fixed" || cs.visibility === "hidden" || cs.display === "none") continue;
      offenders.push({
        tag: el.tagName.toLowerCase(),
        id: el.id || null,
        cls: String(el.className && el.className.baseVal !== undefined ? el.className.baseVal : el.className || "").slice(0, 80),
        right: Math.round(r.right),
        width: Math.round(r.width),
      });
    }
  }
  offenders.sort((x, y) => y.right - x.right);
  return {
    innerWidth: innerWidth,
    clientWidth: vw,
    docScrollWidth: de.scrollWidth,
    bodyScrollWidth: b ? b.scrollWidth : null,
    overflowPx: Math.max(0, de.scrollWidth - vw),
    hasHorizontalOverflow: de.scrollWidth > vw + 1,
    offenders: offenders.slice(0, 10),
    offenderCount: offenders.length,
  };
})()
