/**
 * AntiFan Browser Desktop — Server Crash Scanner
 * Detects fatal platform-level 500/502/503/520-526 crash pages across Haravan,
 * Shopify, Sapo, Cloudflare, and raw backend runtime dumps.
 */

export interface ServerCrashFinding {
  type: 'server_500' | 'bad_gateway_502' | 'service_unavailable_503' | 'gateway_timeout_504' | 'cloudflare_crash' | 'runtime_crash';
  provider: 'haravan' | 'shopify' | 'sapo' | 'cloudflare' | 'runtime' | 'generic';
  title?: string;
  traceId?: string;
  message: string;
  snippet?: string;
}

export interface ServerCrashScanResult {
  hasCrash: boolean;
  errorsCount: number;
  findings: ServerCrashFinding[];
}

export class ServerCrashScanner {
  /**
   * Browser injection script to scan live DOM for server crash and 500 error pages.
   * Wrapped in self-executing IIFE for isolated evaluation in Isolated World.
   */
  public static getBrowserScanScript(): string {
    return `(() => {
      const findings = [];
      const title = (document.title || '').trim();
      const bodyText = (document.body?.innerText || '').substring(0, 10000);

      // Check if we are inside a benign rich text article or blog container
      function isBenignContent(node) {
        if (!node || node.nodeType !== 1) return false;
        return Boolean(node.closest('.rte, article, .post-content, .blog-content, textarea, .toast, .notification'));
      }

      // 1. Haravan 500 Crash Page Detection
      // Signature: "Có gì đó không ổn !" / "Server Error 500" + TraceId
      const hrvTraceMatch = bodyText.match(/TraceId:\\s*([a-f0-9]{16,64})/i);
      const isHrvTitle = /Có gì đó không ổn\\s*!/i.test(title) || /Server Error 500/i.test(title) || /500\\s*-\\s*Server Error/i.test(title);
      const hrvHeading = Array.from(document.querySelectorAll('h1, h2, h3, .error-title, .server-error')).find(el => 
        !isBenignContent(el) && (/Có gì đó không ổn/i.test(el.textContent || '') || /Server Error 500/i.test(el.textContent || ''))
      );

      if (hrvTraceMatch || (isHrvTitle && hrvHeading)) {
        findings.push({
          type: 'server_500',
          provider: 'haravan',
          title: title || 'Có gì đó không ổn !',
          traceId: hrvTraceMatch ? hrvTraceMatch[1] : undefined,
          message: 'Haravan Server Error 500 crash page detected' + (hrvTraceMatch ? ' (TraceId: ' + hrvTraceMatch[1] + ')' : ''),
          snippet: (hrvHeading?.textContent || title || '').trim()
        });
      }

      // 2. Shopify 500 Crash Page Detection
      // Signature: "500 Internal Server Error" / "Shopify Server Error" / "Liquid error (line ..."
      const isShopifyTitle = /500 Internal Server Error/i.test(title) || /Shopify Server Error/i.test(title);
      const shopifyHeading = Array.from(document.querySelectorAll('h1, h2, h3, .error-title')).find(el =>
        !isBenignContent(el) && (/500 Internal Server Error/i.test(el.textContent || '') || /Shopify Server Error/i.test(el.textContent || ''))
      );
      const shopifyFatalLiquid = bodyText.match(/Liquid error \\(line \\d+\\):\\s*([^\\n\\r<]+)/i);

      if (isShopifyTitle || shopifyHeading || shopifyFatalLiquid) {
        findings.push({
          type: 'server_500',
          provider: 'shopify',
          title: title || 'Shopify 500 Server Error',
          message: 'Shopify 500 Internal Server Error page detected',
          snippet: (shopifyHeading?.textContent || shopifyFatalLiquid?.[0] || title || '').trim()
        });
      }

      // 3. Sapo / Bizweb 500 Crash Detection
      // Signature: "500 - Lỗi máy chủ" / "500 Lỗi máy chủ" / "Hệ thống đang bận"
      const isSapoTitle = /500\\s*-\\s*Lỗi máy chủ/i.test(title) || /500 Lỗi máy chủ/i.test(title);
      const sapoHeading = Array.from(document.querySelectorAll('h1, h2, h3, .error-title')).find(el =>
        !isBenignContent(el) && (/500\\s*-\\s*Lỗi máy chủ/i.test(el.textContent || '') || /Hệ thống đang bận/i.test(el.textContent || ''))
      );

      if (isSapoTitle || sapoHeading) {
        findings.push({
          type: 'server_500',
          provider: 'sapo',
          title: title || '500 - Lỗi máy chủ',
          message: 'Sapo / Bizweb 500 Server Error page detected',
          snippet: (sapoHeading?.textContent || title || '').trim()
        });
      }

      // 4. Cloudflare & Edge Gateway Crash Detection
      // Signature: Ray ID + Error 520/521/522/524/502/503/504
      const cfRayMatch = bodyText.match(/Ray ID:\\s*([a-f0-9]{12,32})/i);
      const cfErrorDetails = document.querySelector('#cf-wrapper, .cf-error-details, .cf-error-overview');
      const cfErrorMatch = bodyText.match(/Error\\s*(520|521|522|523|524|525|526|502|503|504)/i);

      if (cfErrorDetails || (cfRayMatch && cfErrorMatch)) {
        findings.push({
          type: 'cloudflare_crash',
          provider: 'cloudflare',
          title: title || 'Cloudflare Gateway Error',
          traceId: cfRayMatch ? cfRayMatch[1] : undefined,
          message: 'Cloudflare / Edge Gateway crash detected (' + (cfErrorMatch ? cfErrorMatch[0] : '5xx') + ')',
          snippet: (cfRayMatch ? 'Ray ID: ' + cfRayMatch[1] : title || '').trim()
        });
      }

      // 5. Raw Backend Runtime Crash Dumps
      if (
        bodyText.includes('UnhandledPromiseRejection') ||
        bodyText.includes('Fatal error:') ||
        bodyText.includes('Traceback (most recent call last):')
      ) {
        findings.push({
          type: 'runtime_crash',
          provider: 'runtime',
          title: title || 'Runtime Error Dump',
          message: 'Fatal runtime exception or unhandled traceback dumped to page',
          snippet: bodyText.substring(0, 150).trim()
        });
      }

      return {
        hasCrash: findings.length > 0,
        errorsCount: findings.length,
        findings
      };
    })()`;
  }

  /**
   * Static HTML string scanner for offline or fallback analysis.
   * Uses anchored regex patterns and ignores <article> or <textarea> blocks.
   */
  public static scanHtmlString(html: string): ServerCrashScanResult {
    if (!html || typeof html !== 'string') {
      return { hasCrash: false, errorsCount: 0, findings: [] };
    }

    const findings: ServerCrashFinding[] = [];

    // Strip article, textarea, and blog content to avoid false positives
    const sanitizedHtml = html
      .replace(/<article\b[^>]*>[\s\S]*?<\/article>/gi, '')
      .replace(/<textarea\b[^>]*>[\s\S]*?<\/textarea>/gi, '')
      .replace(/<div\b[^>]*class="[^"]*(?:rte|post-content|blog-content)[^"]*"[^>]*>[\s\S]*?<\/div>/gi, '');

    // Extract title tag
    const titleMatch = sanitizedHtml.match(/<title\b[^>]*>([^<]+)<\/title>/i);
    const title = (titleMatch && titleMatch[1]) ? titleMatch[1].trim() : '';

    // 1. Haravan 500 Check
    const hrvTraceMatch = sanitizedHtml.match(/TraceId:\s*([a-f0-9]{16,64})/i);
    const isHrvTitle = /Có gì đó không ổn\s*!/i.test(title) || /Server Error 500/i.test(title) || /500\s*-\s*Server Error/i.test(title);
    const hasHrvHeading = /<h[1-3]\b[^>]*>[^<]*(?:Có gì đó không ổn|Server Error 500)[^<]*<\/h[1-3]>/i.test(sanitizedHtml);

    if (hrvTraceMatch || (isHrvTitle && hasHrvHeading)) {
      findings.push({
        type: 'server_500',
        provider: 'haravan',
        title: title || 'Có gì đó không ổn !',
        traceId: hrvTraceMatch ? hrvTraceMatch[1] : undefined,
        message: 'Haravan Server Error 500 crash page detected' + (hrvTraceMatch ? ` (TraceId: ${hrvTraceMatch[1]})` : ''),
        snippet: title || 'Haravan 500'
      });
    }

    // 2. Shopify 500 Check
    const isShopifyTitle = /500 Internal Server Error/i.test(title) || /Shopify Server Error/i.test(title);
    const hasShopifyHeading = /<h[1-3]\b[^>]*>[^<]*(?:500 Internal Server Error|Shopify Server Error)[^<]*<\/h[1-3]>/i.test(sanitizedHtml);
    const shopifyFatalLiquid = sanitizedHtml.match(/Liquid error \(line \d+\):\s*([^<\n\r]+)/i);

    if (isShopifyTitle || hasShopifyHeading || shopifyFatalLiquid) {
      findings.push({
        type: 'server_500',
        provider: 'shopify',
        title: title || 'Shopify 500 Server Error',
        message: 'Shopify 500 Internal Server Error page detected',
        snippet: shopifyFatalLiquid ? shopifyFatalLiquid[0] : title || 'Shopify 500'
      });
    }

    // 3. Sapo 500 Check
    const isSapoTitle = /500\s*-\s*Lỗi máy chủ/i.test(title) || /500 Lỗi máy chủ/i.test(title);
    const hasSapoHeading = /<h[1-3]\b[^>]*>[^<]*(?:500\s*-\s*Lỗi máy chủ|Hệ thống đang bận)[^<]*<\/h[1-3]>/i.test(sanitizedHtml);

    if (isSapoTitle || hasSapoHeading) {
      findings.push({
        type: 'server_500',
        provider: 'sapo',
        title: title || '500 - Lỗi máy chủ',
        message: 'Sapo / Bizweb 500 Server Error page detected',
        snippet: title || 'Sapo 500'
      });
    }

    // 4. Cloudflare 5xx Gateway Check
    const cfRayMatch = sanitizedHtml.match(/Ray ID:\s*([a-f0-9]{12,32})/i);
    const hasCfWrapper = /id=["']cf-wrapper["']|class=["'][^"']*cf-error-details[^"']*["']/i.test(sanitizedHtml);
    const cfErrorMatch = sanitizedHtml.match(/Error\s*(520|521|522|523|524|525|526|502|503|504)/i);

    if (hasCfWrapper || (cfRayMatch && cfErrorMatch)) {
      findings.push({
        type: 'cloudflare_crash',
        provider: 'cloudflare',
        title: title || 'Cloudflare Gateway Error',
        traceId: cfRayMatch ? cfRayMatch[1] : undefined,
        message: `Cloudflare / Edge Gateway crash detected (${cfErrorMatch ? cfErrorMatch[0] : '5xx'})`,
        snippet: cfRayMatch ? `Ray ID: ${cfRayMatch[1]}` : title || 'Cloudflare Error'
      });
    }

    // 5. Raw Backend Runtime Crash Dumps
    if (
      sanitizedHtml.includes('UnhandledPromiseRejection') ||
      sanitizedHtml.includes('Fatal error:') ||
      sanitizedHtml.includes('Traceback (most recent call last):')
    ) {
      findings.push({
        type: 'runtime_crash',
        provider: 'runtime',
        title: title || 'Runtime Error Dump',
        message: 'Fatal runtime exception or unhandled traceback dumped to page',
        snippet: 'Fatal runtime dump detected'
      });
    }

    return {
      hasCrash: findings.length > 0,
      errorsCount: findings.length,
      findings
    };
  }
}
