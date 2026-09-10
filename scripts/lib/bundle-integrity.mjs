/**
 * Bundle integrity gates: what may never reach a published clone bundle.
 *
 * Both checks are read-only and path-based so the campaign can refuse a bundle
 * before it is minted. They are pure enough to test against fixtures, which
 * matters because one is a fail-closed refusal: a false negative publishes a
 * defective bundle, and a false positive stops the campaign for a healthy one.
 */
import fs from 'node:fs';

/**
 * Markers written by the harness itself, never by the storefront.
 *
 * `data-antifan-pinned` is written by the settle guard onto exactly the nodes whose
 * inline styles it overwrote with `!important`; `data-antifan-pw-hooked` is written
 * by the app's page-world bridge onto live forms. Either one in a bundle means
 * harness state survived into what is supposed to be the site's own markup, where
 * the pin would override the clone's CSS and pin its sliders permanently.
 *
 * The prefix is deliberately not the test: `data-antifan-hover`,
 * `data-antifan-modal`, `data-antifan-dropdown-panel` and `data-antifan-src` are
 * emitted by the clone's own synthesized runtime and are legitimate content.
 */
export const HARNESS_RESIDUE_MARKERS = ['data-antifan-pinned', 'data-antifan-pw-hooked', '__antifanGuard', 'antifan-agent'];

export function detectHarnessResidue(entryPath) {
  let html = '';
  try {
    html = fs.readFileSync(entryPath, 'utf8');
  } catch (e) {
    return [`entry-unreadable:${String(e && e.message ? e.message : e).slice(0, 80)}`];
  }
  return HARNESS_RESIDUE_MARKERS.filter((marker) => html.includes(marker));
}

/**
 * Body attributes that select the source layout, missing from the built clone.
 *
 * The reference switches to its phone rendering through `<body data-device="mobile">`,
 * so a bundle that drops the attribute renders the desktop document at 390: measured
 * as a 42% taller mobile page whose section, card and image counts still matched, which
 * surfaced as an unreasoned height delta instead of the wiring defect it was. Harness
 * markers are excluded from the expectation because the dumper strips them on purpose.
 */
export function detectLostLayoutSwitch(dumpPath, entryPath) {
  const built = new Set(bodyDataAttributes(entryPath));
  return bodyDataAttributes(dumpPath).filter((name) => !built.has(name));
}

function bodyDataAttributes(file) {
  let html = '';
  try {
    html = fs.readFileSync(file, 'utf8');
  } catch {
    return [];
  }
  const tag = html.match(/<body\b([^>]*)>/i);
  if (!tag) return [];
  return [...tag[1].matchAll(/([a-zA-Z_:][-a-zA-Z0-9_:.]*)(?=\s*=|\s|$)/g)]
    .map((match) => match[1].toLowerCase())
    .filter((name) => name.startsWith('data-') && !name.startsWith('data-antifan'));
}
