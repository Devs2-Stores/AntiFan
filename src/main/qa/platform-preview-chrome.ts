/**
 * The platform's own storefront preview furniture (Haravan admin/preview bar,
 * Sapo/Bizweb theme previewer, the AntiFan override style). It is never theme
 * content: every scanner, probe and capture guard must skip or hide the same
 * set, so the list lives in exactly one place.
 */
export const PLATFORM_PREVIEW_CHROME_SELECTORS: readonly string[] = Object.freeze([
  '#preview-bar-iframe',
  '[id*="preview-bar"]',
  '.preview-bar',
  'ul.preview-cta',
  '#haravan-notification',
  '.hrv-admin-bar',
  '#admin-bar-iframe',
  '#admin_bar_iframe',
  '#bizweb-theme-previewer',
  '#PBarNextFrameWrapper',
  'iframe[src*="admin/preview_bar"]',
  'iframe[src*="preview_bar"]',
  '.haravan-preview-bar',
]);

/** The selector list as one comma-joined string, ready for `closest()` / `querySelectorAll()` / CSS. */
export const PLATFORM_PREVIEW_CHROME: string = PLATFORM_PREVIEW_CHROME_SELECTORS.join(', ');
