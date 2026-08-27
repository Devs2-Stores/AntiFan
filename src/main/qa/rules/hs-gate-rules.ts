import { EcommercePlatform } from '../scanners/platform-detector';

export type HsRuleSeverity = 'error' | 'warning' | 'info';
export interface HsRuleViolation { ruleId: string; ruleTitle: string; severity: HsRuleSeverity; platform: EcommercePlatform; message: string; selector?: string; snippet?: string; recommendation: string; }
export interface CartContractTelemetry { observedRequests: Array<{ url: string; method?: string }>; forms: Array<{ action: string; method: string; variantField?: string; contactEmailField?: string }>; contracts: { add: boolean; change: boolean; read: boolean }; }
export interface HsEvaluationResult { passed: boolean; totalViolations: number; errorsCount: number; warningsCount: number; violations: HsRuleViolation[]; cartTelemetry?: CartContractTelemetry; }

function makeResult(violations: HsRuleViolation[], cartTelemetry?: CartContractTelemetry): HsEvaluationResult {
  const errorsCount = violations.filter((item) => item.severity === 'error').length;
  return { passed: errorsCount === 0, totalViolations: violations.length, errorsCount, warningsCount: violations.filter((item) => item.severity === 'warning').length, violations, cartTelemetry };
}
function compact(value: string): string { return value.replace(/\s+/g, ' ').trim().slice(0, 300); }
function makeViolation(platform: EcommercePlatform, ruleId: string, ruleTitle: string, severity: HsRuleSeverity, message: string, recommendation: string, selector?: string, snippet?: string): HsRuleViolation { return { platform, ruleId, ruleTitle, severity, message, recommendation, selector, snippet }; }
function attr(markup: string, name: string): string { return markup.match(new RegExp(`\\b${name}\\s*=\\s*["']([^"']*)["']`, 'i'))?.[1] || ''; }

function evaluateMarkup(html: string, platform: EcommercePlatform): HsEvaluationResult {
  if (!html || platform === 'unknown') return makeResult([]);
  const violations: HsRuleViolation[] = [];
  const forms = [...html.matchAll(/<form\b[^>]*>[\s\S]*?<\/form\s*>/gi)].map((match) => match[0]);
  for (const form of forms) {
    const action = attr(form, 'action').toLowerCase();
    if (/\/cart\/add(?:\.js)?(?:[/?#]|$)/i.test(action)) {
      const hasId = /\b(?:input|select)\b[^>]*\bname\s*=\s*["']id["']/i.test(form);
      const hasVariantId = /\b(?:input|select)\b[^>]*\bname\s*=\s*["']variantid["']/i.test(form);
      if (platform === 'sapo' && hasId && !hasVariantId) violations.push(makeViolation(platform, 'HS-01', 'Sapo Cart Variant ID Contract', 'error', 'Sapo add-to-cart form uses name="id" instead of name="variantId"', 'Use name="variantId" for Sapo cart forms', 'form[action*="/cart/add"]', compact(form)));
      if ((platform === 'haravan' || platform === 'shopify') && hasVariantId && !hasId) violations.push(makeViolation(platform, 'HS-01', `${platform.toUpperCase()} Cart Variant ID Contract`, 'error', `${platform.toUpperCase()} add-to-cart form uses name="variantId" instead of name="id"`, `Use name="id" for ${platform} cart forms`, 'form[action*="/cart/add"]', compact(form)));
    }
    if (/contact/i.test(action)) {
      const hasEmail = /\bname\s*=\s*["']contact\[email\]["']/i.test(form);
      if (platform === 'sapo' && /\/contact(?:[/?#]|$)/i.test(action) && !/\/postcontact(?:[/?#]|$)/i.test(action)) violations.push(makeViolation(platform, 'HS-02', 'Sapo Contact Form Endpoint', 'error', 'Contact form posts to /contact instead of Sapo /postcontact', 'Change the form action to /postcontact', 'form[action*="contact"]', compact(form)));
      if ((platform === 'haravan' || platform === 'shopify') && /\/postcontact(?:[/?#]|$)/i.test(action)) violations.push(makeViolation(platform, 'HS-02', `${platform.toUpperCase()} Contact Form Endpoint`, 'error', `Contact form posts to /postcontact instead of ${platform} /contact`, `Change the form action to /contact for ${platform}`, 'form[action*="postcontact"]', compact(form)));
      if (!hasEmail) violations.push(makeViolation(platform, 'HS-02', 'Contact Form Email Contract', 'error', 'Contact form does not contain name="contact[email]"', 'Add an email field named contact[email]', 'form[action*="contact"]', compact(form)));
    }
    if (platform === 'sapo' && /comment/i.test(action) && /\bname\s*=\s*["'](?:author|comment\[author\]|email|comment\[email\]|body|comment\[body\])["']/i.test(form)) violations.push(makeViolation(platform, 'HS-03', 'Sapo Comment Field Casing', 'warning', 'Sapo blog comment form uses lowercase field names instead of Author, Email, Body', 'Use capitalized Author, Email, Body field names', 'form[action*="comment"]', compact(form)));
  }
  if (/deleteAddress/i.test(html) && !/(?:function\s+deleteAddress|(?:window\.)?deleteAddress\s*=)/i.test(html)) violations.push(makeViolation(platform, 'HS-04', 'Customer Address Deletion Handler', 'warning', 'Static scan cannot confirm a deleteAddress handler exists; it may load from an external script — run the live Theme QA check to verify at runtime', 'Run the live check and confirm deleteAddress is defined, or use the platform-supported address deletion API', '[onclick*="deleteAddress"]'));
  const images = [...html.matchAll(/<img\b[^>]*>/gi)].map((match) => match[0]);
  const cdn = platform === 'haravan' ? /https?:\/\/[^"'\s>]*hstatic\.net\//i : platform === 'sapo' ? /https?:\/\/[^"'\s>]*(?:bizweb\.dktcdn\.net|dktcdn\.net)\//i : /https?:\/\/[^"'\s>]*cdn\.shopify\.com\//i;
  for (const image of images) { const src = attr(image, 'src'); if (src && (images.length === 1 || /featured|product/i.test(image)) && !cdn.test(src)) { violations.push(makeViolation(platform, 'HS-05', 'Featured Image CDN URL', 'warning', 'Featured image does not use an absolute platform CDN URL', 'Use an absolute URL served from the platform CDN', 'img', compact(image))); break; } }
  for (const script of [...html.matchAll(/<script\b[^>]*>/gi)].map((match) => match[0])) { if (/(analytics|gtag|googletagmanager|facebook|hotjar|pagespeed|startoptimize)/i.test(script) && !/(data-nops|data-pagespeed|startoptimize|noscript|noPS)/i.test(script)) violations.push(makeViolation(platform, 'HS-06', 'Analytics and Performance Guard', 'warning', 'Analytics or heavy performance script is not marked with noPS or StartOptimize guard', 'Add the project noPS/StartOptimize guard before loading non-critical scripts', 'script', compact(script))); }
  return makeResult(violations);
}

export class HsGateRules {
  public static getBrowserEvaluationScript(platform: EcommercePlatform): string {
    return `(() => {
      const platform = ${JSON.stringify(platform)};
      const violations = [];
      const add = (ruleId, ruleTitle, severity, message, recommendation, selector) => violations.push({ ruleId, ruleTitle, severity, platform, message, recommendation, selector });
      const forms = Array.from(document.querySelectorAll('form'));
      for (const form of forms) {
        const action = (form.getAttribute('action') || '').toLowerCase();
        if (/\\/cart\\/add(?:\\.js)?(?:[/?#]|$)/i.test(action)) {
          const id = form.querySelector('[name="id"]'); const variantId = form.querySelector('[name="variantId"]');
          if (platform === 'sapo' && id && !variantId) add('HS-01', 'Sapo Cart Variant ID Contract', 'error', 'Sapo add-to-cart form uses name="id" instead of name="variantId"', 'Use name="variantId" for Sapo cart forms', 'form[action*="/cart/add"]');
          if ((platform === 'haravan' || platform === 'shopify') && variantId && !id) add('HS-01', platform.toUpperCase() + ' Cart Variant ID Contract', 'error', platform.toUpperCase() + ' add-to-cart form uses name="variantId" instead of name="id"', 'Use name="id" for ' + platform + ' cart forms', 'form[action*="/cart/add"]');
        }
        if (/contact/i.test(action)) {
          if (platform === 'sapo' && /\\/contact(?:[/?#]|$)/i.test(action) && !/\\/postcontact(?:[/?#]|$)/i.test(action)) add('HS-02', 'Sapo Contact Form Endpoint', 'error', 'Contact form posts to /contact instead of Sapo /postcontact', 'Change the form action to /postcontact', 'form[action*="contact"]');
          if ((platform === 'haravan' || platform === 'shopify') && /\\/postcontact(?:[/?#]|$)/i.test(action)) add('HS-02', platform.toUpperCase() + ' Contact Form Endpoint', 'error', 'Contact form posts to /postcontact instead of ' + platform + ' /contact', 'Change the form action to /contact', 'form[action*="postcontact"]');
          if (!form.querySelector('[name="contact[email]"]')) add('HS-02', 'Contact Form Email Contract', 'error', 'Contact form does not contain name="contact[email]"', 'Add an email field named contact[email]', 'form[action*="contact"]');
        }
        if (platform === 'sapo' && /comment/i.test(action) && form.querySelector('[name="author"], [name="comment[author]"], [name="email"], [name="comment[email]"], [name="body"], [name="comment[body]"]')) add('HS-03', 'Sapo Comment Field Casing', 'warning', 'Sapo blog comment form uses lowercase field names instead of Author, Email, Body', 'Use capitalized Author, Email, Body field names', 'form[action*="comment"]');
      }
      for (const button of Array.from(document.querySelectorAll('[onclick*="deleteAddress"], [href*="deleteAddress"], [data-delete-address]'))) { const text = (button.getAttribute('onclick') || '') + ' ' + (button.getAttribute('href') || ''); if (/deleteAddress/i.test(text) && typeof window.deleteAddress !== 'function') add('HS-04', 'Customer Address Deletion Handler', 'error', 'Customer address deletion references deleteAddress but no handler is defined', 'Define deleteAddress or use the platform-supported address deletion API', '[onclick*="deleteAddress"]'); }
      const allImages = Array.from(document.querySelectorAll('img')); const images = allImages.filter((img) => /featured|product/i.test(img.className || '') || allImages.length === 1); const cdn = platform === 'haravan' ? /(^|\\.)hstatic\\.net\\//i : platform === 'sapo' ? /(^|\\.)(bizweb\\.dktcdn\\.net|dktcdn\\.net)\\//i : /(^|\\.)cdn\\.shopify\\.com\\//i';
      for (const image of images) { const src = image.getAttribute('src') || ''; if (src && (!/^https?:\\/\\//i.test(src) || !cdn.test(src))) { add('HS-05', 'Featured Image CDN URL', 'warning', 'Featured image does not use an absolute platform CDN URL', 'Use an absolute URL served from the platform CDN', 'img'); break; } }
      for (const script of Array.from(document.querySelectorAll('script[src]'))) { const src = script.getAttribute('src') || ''; if (/(analytics|gtag|googletagmanager|facebook|hotjar|pagespeed|startoptimize)/i.test(src) && !/(data-nops|data-pagespeed|startoptimize|noscript|noPS)/i.test(script.outerHTML)) add('HS-06', 'Analytics and Performance Guard', 'warning', 'Analytics or heavy performance script is not marked with noPS or StartOptimize guard', 'Add the project noPS/StartOptimize guard', 'script'); }
      const urls = performance.getEntriesByType('resource').map((entry) => entry.name).filter((url) => /\\/cart(?:\\/add|\\/change)?(?:\\.js)?(?:[/?#]|$)/i.test(url));
      const cartTelemetry = { observedRequests: urls.map((url) => ({ url, method: 'GET' })), forms: forms.map((form) => ({ action: form.getAttribute('action') || '', method: (form.getAttribute('method') || 'get').toUpperCase(), variantField: form.querySelector('[name="id"], [name="variantId"]')?.getAttribute('name') || undefined, contactEmailField: form.querySelector('[name="contact[email]"], [name="email"], [name="Email"]')?.getAttribute('name') || undefined })).filter((item) => /cart|contact/i.test(item.action) || item.variantField || item.contactEmailField), contracts: { add: urls.some((url) => /\\/cart\\/add(?:\\.js)?(?:[/?#]|$)/i.test(url)), change: urls.some((url) => /\\/cart\\/change(?:\\.js)?(?:[/?#]|$)/i.test(url)), read: urls.some((url) => /\\/cart(?:\\.js)?(?:[/?#]|$)/i.test(url)) } };
      const errorsCount = violations.filter((item) => item.severity === 'error').length;
      return { passed: errorsCount === 0, totalViolations: violations.length, errorsCount, warningsCount: violations.filter((item) => item.severity === 'warning').length, violations, cartTelemetry };
    })()`;
  }
  public static getBrowserCartAssertionScript(): string { return `(() => { const urls = performance.getEntriesByType('resource').map((entry) => entry.name).filter((url) => /\\/cart(?:\\/add|\\/change)?(?:\\.js)?(?:[/?#]|$)/i.test(url)); return { observedRequests: urls.map((url) => ({ url, method: 'GET' })), contracts: { add: urls.some((url) => /\\/cart\\/add(?:\\.js)?(?:[/?#]|$)/i.test(url)), change: urls.some((url) => /\\/cart\\/change(?:\\.js)?(?:[/?#]|$)/i.test(url)), read: urls.some((url) => /\\/cart(?:\\.js)?(?:[/?#]|$)/i.test(url)) } }; })()`; }
  public static evaluateCartTelemetry(value: unknown): CartContractTelemetry {
    const input = value && typeof value === 'object' ? value as Record<string, unknown> : {};
    const observedRequests = Array.isArray(input.observedRequests)
      ? input.observedRequests.filter((item): item is { url: string; method?: string } => Boolean(item && typeof item === 'object' && typeof (item as Record<string, unknown>).url === 'string'))
      : [];
    const forms = Array.isArray(input.forms)
      ? input.forms.filter((item): item is CartContractTelemetry['forms'][number] => Boolean(item && typeof item === 'object' && typeof (item as Record<string, unknown>).action === 'string' && typeof (item as Record<string, unknown>).method === 'string'))
      : [];
    const urls = observedRequests.map((item) => item.url);
    return {
      observedRequests,
      forms,
      contracts: {
        add: urls.some((url) => /\/cart\/add(?:\.js)?(?:[/?#]|$)/i.test(url)),
        change: urls.some((url) => /\/cart\/change(?:\.js)?(?:[/?#]|$)/i.test(url)),
        read: urls.some((url) => /\/cart(?:\.js)?(?:[/?#]|$)/i.test(url)),
      },
    };
  }
  public static evaluateHtml(html: string, platform: EcommercePlatform): HsEvaluationResult { return evaluateMarkup(html, platform); }
}
