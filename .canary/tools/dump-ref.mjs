/**
 * Dump the hydrated reference DOM to disk via the control-plane RPC (no MCP
 * result-size truncation).
 *
 * Sanitation (reference-capture hygiene, applied to the detached clone only):
 *   - AntiFan-injected runtime nodes (normalize style, agent overlay)
 *   - session-scoped secrets: csrf meta/token inputs, `data-csrf` attributes
 *   - third-party executable integrations that are not storefront structure:
 *     Tawk.to live chat, Google Tag Manager / gtag / Google Analytics, and the
 *     widget DOM/styles they inject at runtime (random-id fixed iframes).
 * Everything else — site markup, site CSS/JS, images, fonts, video, Livewire
 * hydration state — is preserved verbatim.
 *
 * Usage: node .canary/tools/dump-ref.mjs <tabId> <outHtml> [sanitize]
 */
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { call } from './lib-rpc.mjs';

const [, , tabId, outHtml, sanitizeArg] = process.argv;
if (!tabId || !outHtml) {
  console.error('usage: dump-ref.mjs <tabId> <outHtml> [sanitize]');
  process.exit(2);
}
const sanitize = sanitizeArg !== 'raw';

const expression = `(() => {
  const clone = document.documentElement.cloneNode(true);
  const removed = [];
  const note = (n, why) => removed.push(why + ':' + n.tagName + (n.id ? '#' + n.id : '') + (n.getAttribute && n.getAttribute('src') ? '[' + n.getAttribute('src').slice(0, 60) + ']' : ''));
  const drop = (nodes, why) => { nodes.forEach((n) => { note(n, why); n.remove(); }); };

  // 1. AntiFan-injected runtime state
  drop(Array.from(clone.querySelectorAll('[id^="__antifan"], [class*="antifan-agent"]')), 'antifan');

  if (${sanitize}) {
    // 2. Session-scoped secrets
    drop(Array.from(clone.querySelectorAll('meta[name="csrf-token"], meta[name="csrf-param"]')), 'secret-meta');
    Array.from(clone.querySelectorAll('input[name="_token"], input[name="csrf-token"]')).forEach((n) => {
      if (n.getAttribute('value')) { n.setAttribute('value', ''); removed.push('secret-value:INPUT' + (n.name ? '[' + n.name + ']' : '')); }
    });
    Array.from(clone.querySelectorAll('[data-csrf]')).forEach((n) => { n.removeAttribute('data-csrf'); removed.push('secret-attr:' + n.tagName); });

    // 3. Third-party executable integrations (non-storefront structure)
    const thirdPartySrc = /(?:^|\\/\\/|\\.)(?:tawk\\.to|googletagmanager\\.com|google-analytics\\.com|googlesyndication\\.com|doubleclick\\.net|facebook\\.net|connect\\.facebook\\.net)\\//i;
    drop(Array.from(clone.querySelectorAll('script[src]')).filter((s) => thirdPartySrc.test(s.getAttribute('src') || '')), 'third-party-script');
    drop(Array.from(clone.querySelectorAll('link[href]')).filter((l) => thirdPartySrc.test(l.getAttribute('href') || '')), 'third-party-link');
    Array.from(clone.querySelectorAll('script:not([src])')).forEach((s) => {
      const t = s.textContent || '';
      if (/Tawk_API|Tawk_LoadStart|googletagmanager|gtag\\(|Google Tag Manager|google-analytics|dataLayer\\.push/.test(t)) { note(s, 'third-party-inline'); s.remove(); }
    });
    drop(Array.from(clone.querySelectorAll('noscript')).filter((n) => /googletagmanager|google-analytics|tawk/i.test(n.innerHTML || '')), 'third-party-noscript');

    // 4. Runtime-injected widget DOM: fixed iframes + random-id containers (tawk bubble, etc.)
    drop(Array.from(clone.querySelectorAll('iframe')).filter((f) => {
      const src = f.getAttribute('src') || '';
      const srcdoc = f.getAttribute('srcdoc') || '';
      return src === 'about:blank' || srcdoc === '<html></html>' || srcdoc === '<html><head></head><body></body></html>';
    }), 'injected-iframe');
    drop(Array.from(clone.querySelectorAll('[id]')).filter((n) => /^[a-z0-9]{10,}\\d{10,}$/.test(n.id) && !n.querySelector('section,header,footer,nav,main,article')), 'injected-random-id');
    Array.from(clone.querySelectorAll('style')).forEach((s) => {
      const t = s.textContent || '';
      if (/#gitndsip|tawkMaxOpen|tawk-button-hover|\\.tawk-/.test(t)) { note(s, 'injected-style'); s.remove(); }
    });
  }

  return JSON.stringify({
    removed,
    sanitized: ${sanitize},
    url: location.href,
    clientWidth: document.documentElement.clientWidth,
    docHeight: Math.max(document.documentElement.scrollHeight, document.body.scrollHeight),
    sections: Array.from(document.querySelectorAll('section')).map((s) => (typeof s.className === 'string' ? s.className.split(/\\s+/)[0] : '')),
    productItems: document.querySelectorAll('.product-list__item').length,
    images: document.images.length,
    html: '<!DOCTYPE html>\\n' + clone.outerHTML,
  });
})()`;

const raw = await call('anti.browser.evaluate', { tabId, expression }, 180000);
const payload = typeof raw === 'string' ? JSON.parse(raw) : raw;
fs.mkdirSync(path.dirname(path.resolve(outHtml)), { recursive: true });
fs.writeFileSync(outHtml, payload.html);
console.log(JSON.stringify({
  ok: true,
  out: path.resolve(outHtml),
  sanitized: payload.sanitized,
  url: payload.url,
  removed: payload.removed,
  clientWidth: payload.clientWidth,
  docHeight: payload.docHeight,
  sections: payload.sections,
  productItems: payload.productItems,
  images: payload.images,
  bytes: Buffer.byteLength(payload.html),
  sha256: createHash('sha256').update(payload.html).digest('hex'),
}, null, 2));
