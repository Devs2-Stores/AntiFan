export interface LiquidErrorFinding {
  type: 'syntax_error' | 'missing_include' | 'translation_missing' | 'runtime_error';
  message: string;
  selector?: string;
  snippet?: string;
  location?: string;
}

export interface LiquidScanResult {
  hasErrors: boolean;
  errors: LiquidErrorFinding[];
  scannedElementsCount: number;
}

export class LiquidErrorScanner {
  /**
   * Browser injection script to scan live DOM for Liquid errors
   * Wrapped in self-executing IIFE for isolated evaluation (RT-01 mitigation)
   */
  public static getBrowserScanScript(): string {
    return `(() => {
      const EXCLUDED_SELECTORS = [
        '.rte',
        '.article__content',
        '.article-content',
        '.wysiwyg-content',
        '[data-user-content]',
        'textarea',
        'input',
        'pre',
        'code',
        'script',
        'style'
      ].join(', ');

      const ERROR_PATTERNS = [
        { type: 'syntax_error', regex: /Liquid syntax error(?:\\s*\\([^)]*\\))?:?\\s*([^<\\n\\r]+)/i },
        { type: 'missing_include', regex: /Liquid error(?:\\s*\\([^)]*\\))?:\\s*Could not find snippet\\s+['"]?([^'"\\s<]+)/i },
        { type: 'missing_include', regex: /Liquid error(?:\\s*\\([^)]*\\))?:\\s*Could not find (?:asset|file)\\s+['"]?([^'"\\s<]+)/i },
        { type: 'translation_missing', regex: /translation missing:\\s*([a-zA-Z0-9_.-]+)/i },
        { type: 'runtime_error', regex: /Liquid error(?:\\s*\\([^)]*\\))?:\\s*([^<\\n\\r]+)/i }
      ];

      const findings = [];
      let elementCount = 0;

      const walker = document.createTreeWalker(
        document.body || document.documentElement,
        NodeFilter.SHOW_TEXT,
        {
          acceptNode: (node) => {
            const parent = node.parentElement;
            if (!parent) return NodeFilter.FILTER_REJECT;
            if (parent.closest(EXCLUDED_SELECTORS)) return NodeFilter.FILTER_REJECT;
            const text = (node.textContent || '').trim();
            if (text.length < 5) return NodeFilter.FILTER_SKIP;
            return NodeFilter.FILTER_ACCEPT;
          }
        }
      );

      let currentNode = walker.nextNode();
      while (currentNode) {
        elementCount++;
        const text = currentNode.textContent || '';
        for (const pattern of ERROR_PATTERNS) {
          const match = text.match(pattern.regex);
          if (match) {
            const el = currentNode.parentElement;
            let selector = el ? el.tagName.toLowerCase() : '';
            if (el && el.id) selector += '#' + el.id;
            else if (el && el.className && typeof el.className === 'string') {
              selector += '.' + el.className.trim().split(/\\s+/).slice(0, 2).join('.');
            }

            findings.push({
              type: pattern.type,
              message: match[0].trim(),
              selector: selector || undefined,
              snippet: text.substring(0, 150).trim()
            });
            break;
          }
        }
        currentNode = walker.nextNode();
      }

      // Check comment nodes for Liquid trace dumps
      const commentWalker = document.createTreeWalker(
        document.body || document.documentElement,
        NodeFilter.SHOW_COMMENT
      );
      let commentNode = commentWalker.nextNode();
      while (commentNode) {
        const commentText = commentNode.textContent || '';
        if (commentText.includes('Liquid error:') || commentText.includes('Liquid syntax error:')) {
          findings.push({
            type: 'runtime_error',
            message: 'Liquid error found in HTML comment: ' + commentText.substring(0, 100).trim(),
            snippet: commentText.substring(0, 150).trim()
          });
        }
        commentNode = commentWalker.nextNode();
      }

      return {
        hasErrors: findings.length > 0,
        errors: findings,
        scannedElementsCount: elementCount
      };
    })()`;
  }

  /**
   * Static scan on raw HTML string (for offline analysis)
   */
  public static scanHtmlString(html: string): LiquidScanResult {
    const findings: LiquidErrorFinding[] = [];
    if (!html || html.trim().length === 0) {
      return { hasErrors: false, errors: [], scannedElementsCount: 0 };
    }

    // Strip excluded tags like <pre>, <code>, <textarea>, <script>, <style>
    const sanitizedHtml = html
      .replace(/<(pre|code|textarea|script|style)[\s\S]*?<\/\1>/gi, '')
      .replace(/<[^>]*class="[^"]*(?:rte|article__content|wysiwyg)[^"]*"[\s\S]*?<\/[a-z]+>/gi, '');

    const patterns: Array<{ type: LiquidErrorFinding['type']; regex: RegExp }> = [
      { type: 'syntax_error', regex: /Liquid syntax error(?:\s*\([^)]*\))?:?\s*([^<\n\r]+)/gi },
      { type: 'missing_include', regex: /Liquid error(?:\s*\([^)]*\))?:\s*Could not find snippet\s+['"]?([^'"\s<]+)/gi },
      { type: 'missing_include', regex: /Liquid error(?:\s*\([^)]*\))?:\s*Could not find (?:asset|file)\s+['"]?([^'"\s<]+)/gi },
      { type: 'translation_missing', regex: /translation missing:\s*([a-zA-Z0-9_.-]+)/gi },
      { type: 'runtime_error', regex: /Liquid error(?:\s*\([^)]*\))?:\s*([^<\n\r]+)/gi },
    ];

    const indexedFindings: Array<{ index: number; length: number; finding: LiquidErrorFinding }> = [];
    for (const pat of patterns) {
      let match: RegExpExecArray | null;
      while ((match = pat.regex.exec(sanitizedHtml)) !== null) {
        const matchStart = match.index;
        const matchEnd = match.index + match[0].length;
        // If already covered by a more specific pattern, skip
        const alreadyCovered = indexedFindings.some(
          (f) => Math.max(f.index, matchStart) < Math.min(f.index + f.length, matchEnd)
        );
        if (!alreadyCovered) {
          indexedFindings.push({
            index: match.index,
            length: match[0].length,
            finding: {
              type: pat.type,
              message: match[0].trim(),
              snippet: match[0].trim(),
            },
          });
        }
      }
    }
    indexedFindings.sort((a, b) => a.index - b.index);
    for (const item of indexedFindings) {
      findings.push(item.finding);
    }

    return {
      hasErrors: findings.length > 0,
      errors: findings,
      scannedElementsCount: 1,
    };
  }
}
