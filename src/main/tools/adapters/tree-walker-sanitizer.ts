/**
 * Isolated TreeWalker Sanitizer Adapter for AntiFan Browser Desktop
 * Strips dynamic server-side rendering (SSR) metadata blobs (Livewire, Alpine, Nuxt)
 * directly in browser memory before exporting clean static themes.
 */

export interface TreeWalkerSanitizerOptions {
  stripLivewire?: boolean;
  stripAlpine?: boolean;
  stripComments?: boolean;
  stripModals?: boolean;
  selector?: string;
}

export function buildTreeWalkerSanitizerScript(options: TreeWalkerSanitizerOptions = {}): string {
  const {
    stripLivewire = true,
    stripAlpine = true,
    stripComments = true,
    stripModals = true,
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
            if (name.startsWith('x-') || name.startsWith('@') || name.startsWith(':') || name.startsWith('x-data') || name.startsWith('x-bind') || name.startsWith('x-on:')) {
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
      // Hide or strip unhydrated SSR/Livewire modals and popups that block viewports
      if (${stripModals}) {
        const modalSelectors = [
          '#popup-login',
          '#popup-video',
          '.popup-login',
          '.popup-video',
          '.modal.show',
          '.fade.show',
          '.modal-backdrop',
          '.popup-backdrop',
          '.fancybox__container'
        ];
        for (const sel of modalSelectors) {
          const modals = clone.querySelectorAll ? clone.querySelectorAll(sel) : [];
          for (const m of Array.from(modals)) {
            try {
              if (m && m.style) m.style.setProperty('display', 'none', 'important');
            } catch {}
          }
        }
      }

      // Convert lazy images to eager so pre-capture quiescence never hangs
      const lazyImgs = clone.querySelectorAll ? clone.querySelectorAll('img[loading="lazy"]') : [];
      for (const img of Array.from(lazyImgs)) {
        try {
          img.setAttribute('loading', 'eager');
        } catch {}
      }
      // Strip Livewire and runtime backend scripts that fail or hang offline
      ${stripLivewire ? `
        const livewireScripts = clone.querySelectorAll ? clone.querySelectorAll('script[src*="livewire"], script[data-csrf], script[data-update-uri]') : [];
        for (const s of Array.from(livewireScripts)) {
          try { s.remove(); } catch {}
        }
      ` : ''}

      // Neutralize autoplay sliders so offline viewports and captures are deterministic
      const autoplaySliders = clone.querySelectorAll ? clone.querySelectorAll('[data-autoplay="1"], [data-autoplay="true"]') : [];
      for (const s of Array.from(autoplaySliders)) {
        try { s.setAttribute('data-autoplay', '0'); } catch {}
      }

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
