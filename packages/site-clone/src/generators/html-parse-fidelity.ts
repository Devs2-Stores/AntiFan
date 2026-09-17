/**
 * HTML re-parse fidelity for captured DOM.
 *
 * A capture serializes a live DOM (Chromium `outerHTML`) and every consumer later
 * re-parses that markup as HTML text. The two structures are not the same thing:
 * the HTML tree builder auto-closes an open `<p>` when it meets a block-level start
 * tag, while a DOM built by a client framework happily parents one paragraph inside
 * another. Serializing `<p class="body"><p>item</p></p>` therefore re-parses as two
 * siblings, the inner text loses the inherited typography of the outer element, and
 * every affected block grows — an observed 9% document-height drift on a
 * Next.js/React menu page where 81 paragraphs nested inside a styled paragraph.
 *
 * The fix keeps the styling contract and drops only the auto-closing tag: a
 * hazardous paragraph is demoted to `<div>` with every attribute preserved. The
 * outer element is the one demoted, so the nested items keep their own tags and
 * classes and the box tree stays identical. Both tags are block-level boxes with
 * no user-agent margins, so a class-driven stylesheet (utility CSS) is
 * geometry-neutral; a stylesheet that styles a hazardous paragraph by tag name
 * (`p { margin-bottom: 1em }`) loses that rule on that single element — the
 * smaller of the two errors, and never a structural one.
 *
 * Nested `<a>`/`<button>`/`<form>` hit different parser repair paths (adoption
 * agency / button scope) and cannot be demoted without changing navigation or
 * control semantics, so they are intentionally not rewritten here.
 */

/** Start tags that close an open `<p>` in button scope (HTML tree construction). */
const PARAGRAPH_CLOSING_TAGS: readonly string[] = [
  'ADDRESS', 'ARTICLE', 'ASIDE', 'BLOCKQUOTE', 'CENTER', 'DETAILS', 'DIALOG', 'DIR',
  'DIV', 'DL', 'DT', 'DD', 'FIELDSET', 'FIGCAPTION', 'FIGURE', 'FOOTER', 'FORM',
  'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'HEADER', 'HGROUP', 'HR', 'LI', 'LISTING',
  'MAIN', 'MENU', 'NAV', 'OL', 'P', 'PLAINTEXT', 'PRE', 'SEARCH', 'SECTION',
  'SUMMARY', 'TABLE', 'UL', 'XMP',
];

/** Subtrees the HTML tree builder parses in foreign/separate content modes. */
const FOREIGN_CONTENT_TAGS: readonly string[] = ['SVG', 'MATH', 'TEMPLATE'];

/**
 * In-page ES5 source declaring `normalizeHtmlAutoclose(root)`, which demotes every
 * hazardous `<p>` under `root` and returns the number of rewritten elements.
 * Embed inside a larger injected script (no template literals: this string is
 * interpolated into one).
 */
export const HTML_AUTOCLOSE_NORMALIZER_SOURCE = `
function normalizeHtmlAutoclose(root) {
  if (!root || !root.querySelectorAll) return 0;
  var P_CLOSING = {${PARAGRAPH_CLOSING_TAGS.map((tag) => `${tag}: 1`).join(',')}};
  var FOREIGN = {${FOREIGN_CONTENT_TAGS.map((tag) => `${tag}: 1`).join(',')}};
  var hasHazard = function (node) {
    var children = node.children;
    for (var i = 0; i < children.length; i++) {
      var child = children[i];
      if (FOREIGN[child.tagName]) continue;
      if (P_CLOSING[child.tagName]) return true;
      if (hasHazard(child)) return true;
    }
    return false;
  };
  var owner = root.ownerDocument || document;
  var paragraphs = root.querySelectorAll('p');
  var renamed = 0;
  for (var p = 0; p < paragraphs.length; p++) {
    var paragraph = paragraphs[p];
    if (!hasHazard(paragraph)) continue;
    var replacement = owner.createElement('div');
    for (var a = 0; a < paragraph.attributes.length; a++) {
      var attr = paragraph.attributes[a];
      replacement.setAttribute(attr.name, attr.value);
    }
    while (paragraph.firstChild) replacement.appendChild(paragraph.firstChild);
    if (paragraph.parentNode) paragraph.parentNode.replaceChild(replacement, paragraph);
    renamed++;
  }
  return renamed;
}
`;
