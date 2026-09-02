/**
 * Isolated TreeWalker Sanitizer Adapter for AntiFan Browser Desktop
 * Strips dynamic server-side rendering (SSR) metadata blobs (Livewire, Alpine, Nuxt)
 * directly in browser memory before exporting clean static themes.
 */

export interface TreeWalkerSanitizerOptions {
  stripLivewire?: boolean;
  stripAlpine?: boolean;
  stripComments?: boolean;
  selector?: string;
}

export function buildTreeWalkerSanitizerScript(options: TreeWalkerSanitizerOptions = {}): string {
  const {
    stripLivewire = true,
    stripAlpine = false,
    stripComments = true,
    selector = '',
  } = options;

  return `
    (() => {
      const isFullDoc = !${JSON.stringify(selector)};
      const root = isFullDoc ? document.documentElement : document.querySelector(${JSON.stringify(selector)});
      if (!root) return '';
      const clone = root.cloneNode(true);

      const sanitizeElementAttributes = (el) => {
        if (!el || !el.attributes) return;
        const attrsToRemove = [];
        for (let i = 0; i < el.attributes.length; i++) {
          const attr = el.attributes[i];
          const name = attr.name.toLowerCase();

          ${stripLivewire ? `
            if (
              name.startsWith('wire:') ||
              name.startsWith('data-wire-') ||
              name === 'wire:snapshot' ||
              name === 'wire:effects' ||
              name === 'wire:id' ||
              name === 'wire:memo' ||
              name === 'wire:initial-data'
            ) {
              attrsToRemove.push(attr.name);
            }
          ` : ''}

          ${stripAlpine ? `
            if (name.startsWith('x-data') || name.startsWith('x-bind') || name.startsWith('x-on:')) {
              attrsToRemove.push(attr.name);
            }
          ` : ''}

          if (name.startsWith('data-server-rendered') || name.startsWith('ng-reflect-')) {
            attrsToRemove.push(attr.name);
          }
        }

        for (const attrName of attrsToRemove) {
          el.removeAttribute(attrName);
        }
      };

      // Sanitize root element itself
      if (clone.nodeType === Node.ELEMENT_NODE) {
        sanitizeElementAttributes(clone);
      }

      const walker = document.createTreeWalker(
        clone,
        NodeFilter.SHOW_ELEMENT | ${stripComments ? 'NodeFilter.SHOW_COMMENT' : '0'},
        null
      );

      const nodesToRemove = [];
      let currentNode;

      while ((currentNode = walker.nextNode())) {
        if (currentNode.nodeType === Node.COMMENT_NODE) {
          nodesToRemove.push(currentNode);
          continue;
        }

        if (currentNode.nodeType === Node.ELEMENT_NODE) {
          sanitizeElementAttributes(currentNode);
        }
      }

      for (const node of nodesToRemove) {
        if (node.parentNode) {
          node.parentNode.removeChild(node);
        }
      }

      return (isFullDoc ? '<!DOCTYPE html>\\n' : '') + clone.outerHTML;
    })()
  `;
}
