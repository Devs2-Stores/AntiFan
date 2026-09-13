import type { InteractionBrowser } from './interaction-suite.js';

export interface MaterializationResult {
  height: number;
  images: number;
  pendingImages: number;
  passes: number;
}

function delay(ms: number): Promise<void> {
  return new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });
}

/**
 * Generic, platform-agnostic interaction surface materializer.
 *
 * Executes a progressive native wheel scroll walk through expanding document height,
 * eagerizes lazy media, awaits image decoding, and verifies DOM/height stability and
 * placeholder resolution before returning. Bounded to 180s and 8 passes.
 * Fails closed by throwing on unsettled conditions.
 */
export async function materializeInteractionSurface(
  browser: InteractionBrowser
): Promise<MaterializationResult> {
  const startMs = Date.now();
  const maxTimeoutMs = 180_000;
  const maxPasses = 8;
  const scrollStepPx = 250;
  const stepDwellMs = 60;

  try {
    // Initialize mutation and hydration observer in page context
    await browser.evaluate(`(() => {
      if (window.__antifan_mat_initialized) return;
      window.__antifan_mat_initialized = true;
      window.__antifan_mutation_count = 0;
      window.__antifan_last_mutation = Date.now();
      const observer = new MutationObserver((mutations) => {
        window.__antifan_mutation_count += mutations.length;
        window.__antifan_last_mutation = Date.now();
      });
      observer.observe(document.documentElement, {
        childList: true,
        subtree: true,
        attributes: true,
        characterData: true,
      });
      window.__antifan_observer = observer;
      // Eagerize any lazy images encountered so far
      document.querySelectorAll('img[loading="lazy"]').forEach(img => {
        try { img.loading = 'eager'; } catch {}
      });
    })()`);

    // Query initial dimensions
    let metrics = (await browser.evaluate(`(() => ({
      viewportWidth: window.innerWidth || 1440,
      viewportHeight: window.innerHeight || 900,
      scrollHeight: Math.max(document.documentElement.scrollHeight, document.body.scrollHeight),
    }))()`)) as { viewportWidth: number; viewportHeight: number; scrollHeight: number };

    const targetX = Math.max(10, Math.round(metrics.viewportWidth / 2));
    const targetY = Math.max(10, Math.round(metrics.viewportHeight / 2));

    let currentPass = 0;
    let lastObservedHeight = metrics.scrollHeight;

    while (currentPass < maxPasses && (Date.now() - startMs) < maxTimeoutMs) {
      currentPass++;

      // Measure live scroll height before walking down
      metrics = (await browser.evaluate(`(() => ({
        viewportWidth: window.innerWidth || 1440,
        viewportHeight: window.innerHeight || 900,
        scrollHeight: Math.max(document.documentElement.scrollHeight, document.body.scrollHeight),
      }))()`)) as { viewportWidth: number; viewportHeight: number; scrollHeight: number };

      let currentHeight = metrics.scrollHeight;
      let currentScrollY = 0;

      // Progressive native wheel scroll walk top to bottom
      while (currentScrollY < currentHeight && (Date.now() - startMs) < maxTimeoutMs) {
        await browser.scroll(targetX, targetY, scrollStepPx);
        await delay(stepDwellMs);
        currentScrollY += scrollStepPx;

        // Check if document height expanded dynamically
        const liveHeight = (await browser.evaluate(
          `Math.max(document.documentElement.scrollHeight, document.body.scrollHeight)`
        )) as number;
        if (liveHeight > currentHeight) {
          currentHeight = liveHeight;
        }
      }

      // Bottom dwell to allow lazy AJAX / Livewire / SSR hydration to trigger
      await delay(1500);

      // Eagerize any newly mounted lazy images
      await browser.evaluate(`(() => {
        document.querySelectorAll('img[loading="lazy"]').forEach(img => {
          try { img.loading = 'eager'; } catch {}
        });
      })()`);

      // Check if new content expanded height significantly
      const postBottomHeight = (await browser.evaluate(
        `Math.max(document.documentElement.scrollHeight, document.body.scrollHeight)`
      )) as number;

      // Return to top natively
      let currentY = (await browser.evaluate(`window.scrollY || window.pageYOffset || 0`)) as number;
      while (currentY > 0) {
        const stepUp = Math.min(currentY, scrollStepPx * 2);
        await browser.scroll(targetX, targetY, -stepUp);
        await delay(25);
        const nextY = (await browser.evaluate(`window.scrollY || window.pageYOffset || 0`)) as number;
        if (nextY >= currentY) {
          await browser.evaluate(`window.scrollTo(0, 0)`);
          break;
        }
        currentY = nextY;
      }
      await delay(300);

      // Check height convergence between passes
      if (currentPass >= 2 && Math.abs(postBottomHeight - lastObservedHeight) < 50) {
        lastObservedHeight = postBottomHeight;
        break;
      }

      lastObservedHeight = postBottomHeight;
    }

    // Await image decode across all images in DOM
    const imageStatus = (await browser.evaluate(`(async () => {
      const images = Array.from(document.querySelectorAll('img'));
      const promises = images.map(async (img) => {
        if (!img.src && (img.dataset.src || img.getAttribute('data-src'))) {
          img.src = img.dataset.src || img.getAttribute('data-src') || '';
        }
        if (img.complete) {
          if (typeof img.decode === 'function') {
            try { await img.decode(); } catch {}
          }
          return img.naturalWidth > 0;
        }
        return new Promise((resolve) => {
          const timer = setTimeout(() => resolve(false), 3000);
          const onFinish = async () => {
            clearTimeout(timer);
            if (typeof img.decode === 'function') {
              try { await img.decode(); } catch {}
            }
            resolve(img.naturalWidth > 0);
          };
          img.addEventListener('load', onFinish, { once: true });
          img.addEventListener('error', () => { clearTimeout(timer); resolve(false); }, { once: true });
        });
      });
      const results = await Promise.all(promises);
      const loaded = results.filter(Boolean).length;
      return { total: images.length, loaded, pending: images.length - loaded };
    })()`)) as { total: number; loaded: number; pending: number };

    // Stability convergence check: height and DOM mutation quiet period
    let stableConvergence = false;
    let finalHeight = lastObservedHeight;

    for (let attempt = 0; attempt < 8; attempt++) {
      await delay(350);
      const stability = (await browser.evaluate(`(() => {
        const height = Math.max(document.documentElement.scrollHeight, document.body.scrollHeight);
        const htmlLen = document.documentElement.outerHTML.length;
        const quietMs = Date.now() - (window.__antifan_last_mutation || 0);
        return { height, htmlLen, quietMs };
      })()`)) as { height: number; htmlLen: number; quietMs: number };

      if (Math.abs(stability.height - finalHeight) === 0 && stability.quietMs >= 350) {
        stableConvergence = true;
        finalHeight = stability.height;
        break;
      }
      finalHeight = stability.height;
    }

    // Check generic loading placeholders / skeleton elements (not site-specific)
    const activePlaceholders = (await browser.evaluate(`(() => {
      const selectors = [
        '.skeleton',
        '.skeleton-loading',
        '.loading-skeleton',
        '.card-skeleton',
        '.product-skeleton',
        '.shimmer',
        '.placeholder-loading',
        '.loading-placeholder',
        '.lazy-placeholder',
        '[data-placeholder="true"]',
        '[data-skeleton="true"]',
        'svg.loading',
        'svg.skeleton',
        'svg[class*="skeleton"]',
        'svg[class*="loading"]',
        '[aria-busy="true"]',
      ];
      const found = [];
      for (const sel of selectors) {
        try {
          document.querySelectorAll(sel).forEach(el => {
            const style = window.getComputedStyle(el);
            if (style.display !== 'none' && style.visibility !== 'hidden' && style.opacity !== '0') {
              const rect = el.getBoundingClientRect();
              if (rect.width > 0 && rect.height > 0) {
                found.push(sel);
              }
            }
          });
        } catch {}
      }
      // Also check wire:loading / wire:placeholder via attribute check
      try {
        document.querySelectorAll('*').forEach(el => {
          if (el.hasAttribute('wire:loading') || el.hasAttribute('wire:placeholder')) {
            const style = window.getComputedStyle(el);
            if (style.display !== 'none' && style.visibility !== 'hidden' && style.opacity !== '0') {
              const rect = el.getBoundingClientRect();
              if (rect.width > 0 && rect.height > 0) {
                found.push('wire:loading/placeholder');
              }
            }
          }
        });
      } catch {}
      return found;
    })()`)) as string[];

    // Ensure final scroll position is at the top of the page
    let currentY = (await browser.evaluate(`window.scrollY || window.pageYOffset || 0`)) as number;
    while (currentY > 0) {
      const stepUp = Math.min(currentY, scrollStepPx * 2);
      await browser.scroll(targetX, targetY, -stepUp);
      await delay(25);
      const nextY = (await browser.evaluate(`window.scrollY || window.pageYOffset || 0`)) as number;
      if (nextY >= currentY) {
        await browser.evaluate(`window.scrollTo(0, 0)`);
        break;
      }
      currentY = nextY;
    }
    await delay(200);

    // Fail-closed settlement checks: never report false success on unsettled states
    if (!stableConvergence) {
      throw new Error(
        `Materialization unsettled: DOM/height failed to stabilize within convergence window after ${currentPass} passes`
      );
    }

    if (finalHeight <= 0) {
      throw new Error('Materialization unsettled: document height is 0 (page failed to render)');
    }

    if (imageStatus.pending > 0) {
      throw new Error(
        `Materialization unsettled: ${imageStatus.pending} of ${imageStatus.total} image(s) failed to decode or timed out`
      );
    }

    if (activePlaceholders.length > 0) {
      throw new Error(
        `Materialization unsettled: ${activePlaceholders.length} active skeleton placeholder(s) still present (${activePlaceholders.slice(0, 5).join(', ')})`
      );
    }

    return {
      height: finalHeight,
      images: imageStatus.total,
      pendingImages: imageStatus.pending,
      passes: currentPass,
    };
  } finally {
    try {
      await browser.evaluate(`(() => {
        if (window.__antifan_observer) {
          try { window.__antifan_observer.disconnect(); } catch {}
          delete window.__antifan_observer;
        }
        delete window.__antifan_mat_initialized;
        delete window.__antifan_mutation_count;
        delete window.__antifan_last_mutation;
      })()`);
    } catch {}
  }
}
