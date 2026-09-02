/**
 * Parser: DOM Token Tree Parser
 * Full tree parser supporting raw-text elements (script, style, textarea), nested tags, void elements, attribute maps, and hierarchy traversal
 */

export interface ParsedElementNode {
  tag: string;
  attributes: Record<string, string>;
  children: Array<ParsedElementNode | string>;
  innerHtml: string;
  outerHtml: string;
}

export class DomTreeParser {
  private static VOID_TAGS = new Set([
    'area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input',
    'link', 'meta', 'param', 'source', 'track', 'wbr'
  ]);

  private static RAW_TEXT_TAGS = new Set([
    'script', 'style', 'textarea', 'title'
  ]);

  public static parse(html: string): ParsedElementNode {
    const root: ParsedElementNode = {
      tag: 'root',
      attributes: {},
      children: [],
      innerHtml: html,
      outerHtml: html
    };

    const stack: { node: ParsedElementNode; startPos: number; contentStartPos: number }[] = [
      { node: root, startPos: 0, contentStartPos: 0 }
    ];

    let cursor = 0;
    const len = html.length;

    while (cursor < len) {
      const nextOpen = html.indexOf('<', cursor);
      if (nextOpen === -1) {
        const text = html.slice(cursor).trim();
        if (text) stack[stack.length - 1].node.children.push(text);
        break;
      }

      // Preceding text
      if (nextOpen > cursor) {
        const text = html.slice(cursor, nextOpen).trim();
        if (text) stack[stack.length - 1].node.children.push(text);
      }

      // Skip HTML comments <!-- ... -->
      if (html.startsWith('<!--', nextOpen)) {
        const commentEnd = html.indexOf('-->', nextOpen + 4);
        if (commentEnd === -1) break;
        cursor = commentEnd + 3;
        continue;
      }

      // Closing tag </tag>
      if (html[nextOpen + 1] === '/') {
        const closeEnd = html.indexOf('>', nextOpen + 2);
        if (closeEnd === -1) break;
        const tag = html.slice(nextOpen + 2, closeEnd).trim().toLowerCase();

        // Match stack top or search stack for closest matching tag
        for (let i = stack.length - 1; i > 0; i--) {
          if (stack[i].node.tag === tag) {
            const popped = stack[i];
            popped.node.innerHtml = html.slice(popped.contentStartPos, nextOpen);
            popped.node.outerHtml = html.slice(popped.startPos, closeEnd + 1);
            stack.splice(i);
            break;
          }
        }
        cursor = closeEnd + 1;
        continue;
      }

      // Opening tag <tag ...>
      let tagClose = -1;
      let inQuote: string | null = null;
      for (let i = nextOpen + 1; i < len; i++) {
        const char = html[i];
        if (inQuote) {
          if (char === inQuote) inQuote = null;
        } else if (char === '"' || char === "'") {
          inQuote = char;
        } else if (char === '>') {
          tagClose = i;
          break;
        }
      }

      if (tagClose === -1) break;

      const tagRaw = html.slice(nextOpen + 1, tagClose).trim();
      const isSelfClosing = tagRaw.endsWith('/') || this.isVoidTag(tagRaw.split(/\s+/)[0]);
      const cleanRaw = tagRaw.endsWith('/') ? tagRaw.slice(0, -1).trim() : tagRaw;

      const firstSpace = cleanRaw.search(/\s/);
      const tagName = (firstSpace === -1 ? cleanRaw : cleanRaw.slice(0, firstSpace)).toLowerCase();
      const attrStr = firstSpace === -1 ? '' : cleanRaw.slice(firstSpace + 1);
      const attributes = this.parseAttributes(attrStr);

      const node: ParsedElementNode = {
        tag: tagName,
        attributes,
        children: [],
        innerHtml: '',
        outerHtml: ''
      };

      stack[stack.length - 1].node.children.push(node);

      if (!isSelfClosing && !this.isVoidTag(tagName)) {
        // Special case: Raw text elements (script, style, textarea, title)
        if (this.isRawTextTag(tagName)) {
          const closingTag = `</${tagName}>`;
          const rawEnd = html.toLowerCase().indexOf(closingTag, tagClose + 1);
          if (rawEnd !== -1) {
            const rawText = html.slice(tagClose + 1, rawEnd);
            node.children.push(rawText);
            node.innerHtml = rawText;
            node.outerHtml = html.slice(nextOpen, rawEnd + closingTag.length);
            cursor = rawEnd + closingTag.length;
            continue;
          }
        }

        stack.push({
          node,
          startPos: nextOpen,
          contentStartPos: tagClose + 1
        });
      } else {
        node.outerHtml = html.slice(nextOpen, tagClose + 1);
      }

      cursor = tagClose + 1;
    }

    // Seal unclosed root tags
    while (stack.length > 1) {
      const top = stack.pop()!;
      top.node.innerHtml = html.slice(top.contentStartPos);
      top.node.outerHtml = html.slice(top.startPos);
    }

    return root;
  }

  public static findByTag(root: ParsedElementNode, tag: string): ParsedElementNode[] {
    const target = tag.toLowerCase();
    const results: ParsedElementNode[] = [];
    const walk = (node: ParsedElementNode) => {
      if (node.tag === target) {
        results.push(node);
      }
      for (const child of node.children) {
        if (typeof child !== 'string') {
          walk(child);
        }
      }
    };
    walk(root);
    return results;
  }

  public static findByClass(root: ParsedElementNode, className: string): ParsedElementNode[] {
    const results: ParsedElementNode[] = [];
    const walk = (node: ParsedElementNode) => {
      const nodeClass = node.attributes['class'] || '';
      const classes = nodeClass.split(/\s+/);
      if (classes.includes(className)) {
        results.push(node);
      }
      for (const child of node.children) {
        if (typeof child !== 'string') {
          walk(child);
        }
      }
    };
    walk(root);
    return results;
  }

  public static extractText(node: ParsedElementNode): string {
    let text = '';
    const walk = (current: ParsedElementNode) => {
      for (const child of current.children) {
        if (typeof child === 'string') {
          text += ' ' + child;
        } else {
          walk(child);
        }
      }
    };
    walk(node);
    return text.replace(/\s+/g, ' ').trim();
  }

  private static isVoidTag(tag: string): boolean {
    return this.VOID_TAGS.has(tag.toLowerCase());
  }

  private static isRawTextTag(tag: string): boolean {
    return this.RAW_TEXT_TAGS.has(tag.toLowerCase());
  }

  private static parseAttributes(attrStr: string): Record<string, string> {
    const attrs: Record<string, string> = {};
    const regex = /([a-zA-Z0-9_:-]+)(?:=(?:"([^"]*)"|'([^']*)'|([^>\s]+)))?/g;
    let match: RegExpExecArray | null;

    while ((match = regex.exec(attrStr)) !== null) {
      const name = match[1].toLowerCase();
      const value = match[2] ?? match[3] ?? match[4] ?? '';
      attrs[name] = value;
    }

    return attrs;
  }
}
