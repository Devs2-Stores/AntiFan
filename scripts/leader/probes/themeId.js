// themeId.js - read-only probe for anti.browser.evaluate on a storefront tab.
// MEASURES: which theme the page was actually rendered from: Shopify.theme (id, name, role,
//   schema_name) or Haravan.theme (id, name, role when exposed), plus location.href and the
//   ?themeid=/preview_theme_id= query the Leader asked for.
// DOES NOT PROVE: that a given file or setting is part of that theme, that the theme is
//   unpublished, or that the CDN already serves the latest push. Compare `id` with the
//   job's bound theme id; a mismatch means every other measurement on this tab is void.
(() => {
  const q = new URLSearchParams(location.search);
  const out = {
    href: location.href,
    requested: q.get("themeid") || q.get("preview_theme_id") || q.get("theme_id") || null,
  };
  try {
    if (typeof Shopify !== "undefined" && Shopify.theme) {
      out.platform = "shopify";
      out.theme = {
        id: Shopify.theme.id ?? null,
        name: Shopify.theme.name ?? null,
        role: Shopify.theme.role ?? null,
        schema_name: Shopify.theme.schema_name ?? null,
      };
    } else if (typeof Haravan !== "undefined" && Haravan.theme) {
      out.platform = "haravan";
      out.theme = {
        id: Haravan.theme.id ?? null,
        name: Haravan.theme.name ?? null,
        role: Haravan.theme.role ?? null,
      };
    } else {
      out.platform = null;
      out.theme = null;
      out.note = "neither Shopify.theme nor Haravan.theme exists on this page";
    }
  } catch (e) {
    out.error = String(e && e.message ? e.message : e);
  }
  return out;
})()
