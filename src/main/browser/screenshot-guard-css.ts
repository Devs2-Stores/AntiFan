/**
 * The stylesheet a capture injects while it rasterizes: AntiFan's own agent overlays and
 * the platform's preview furniture are hidden, and secret fields stop showing what they hold.
 */
import { PLATFORM_PREVIEW_CHROME_SELECTORS } from '../qa/platform-preview-chrome';

/** Id of the `<style>` element; a capture removes it again by this id. */
export const SCREENSHOT_GUARD_STYLE_ID = '__antifan_screenshot_guard__';

/** Marker the agent puts on an input it types a secret into. */
export const SECRET_FIELD_ATTRIBUTE = 'data-antifan-secret';

/** AntiFan's own agent overlay nodes, which never belong in evidence. */
export const ANTIFAN_OVERLAY_SELECTORS: readonly string[] = Object.freeze([
  '#__antifan_agent_overlay__',
  '#__antifan_agent_cursor__',
  '#__antifan_agent_highlight__',
  '#__antifan_agent_banner__',
  '[data-antifan-agent-cursor]',
]);

/** Fields whose content must not reach a screenshot. */
export const SECRET_FIELD_SELECTORS: readonly string[] = Object.freeze([
  'input[type="password"]',
  `[${SECRET_FIELD_ATTRIBUTE}]`,
]);

/**
 * Screenshot-guard CSS. Overlay and preview-chrome nodes are removed from the raster; a secret
 * field keeps its box but paints neither its text nor a text-shadow copy of it, and renders the
 * glyphs it does draw (a revealed password) as discs. This hides the pixels only — the DOM keeps
 * the value, so a script the caller runs can still read it.
 */
export function buildScreenshotGuardCss(): string {
  const hidden = [...ANTIFAN_OVERLAY_SELECTORS, ...PLATFORM_PREVIEW_CHROME_SELECTORS].join(', ');
  const secret = SECRET_FIELD_SELECTORS.join(', ');
  return `${hidden} { display: none !important; visibility: hidden !important; opacity: 0 !important; pointer-events: none !important; } `
    + `${secret} { color: transparent !important; -webkit-text-security: disc !important; text-shadow: none !important; caret-color: transparent !important; }`;
}

/**
 * Page-script statements that install the guard style once (a style already present is kept).
 * They are spliced into the capture's own overlay-suppression script.
 */
export function buildScreenshotGuardInstallSnippet(): string {
  return `let st = document.getElementById(${JSON.stringify(SCREENSHOT_GUARD_STYLE_ID)});
            if (!st && (document.head || document.documentElement)) {
              st = document.createElement('style');
              st.id = ${JSON.stringify(SCREENSHOT_GUARD_STYLE_ID)};
              st.textContent = ${JSON.stringify(buildScreenshotGuardCss())};
              (document.head || document.documentElement).appendChild(st);
            }`;
}

/**
 * Isolated-world script that marks the focused field as a secret (see SECRET_FIELD_ATTRIBUTE)
 * before the agent types into it, so a screenshot taken while the text is on screen hides it.
 * It looks through open shadow roots; it never reads or returns the field's value.
 */
export function buildSecretFieldMarkScript(): string {
  return `(() => {
  let el = document.activeElement;
  while (el && el.shadowRoot && el.shadowRoot.activeElement) el = el.shadowRoot.activeElement;
  if (!el || el === document.body || typeof el.setAttribute !== 'function') return false;
  el.setAttribute(${JSON.stringify(SECRET_FIELD_ATTRIBUTE)}, '1');
  return true;
})()`;
}
