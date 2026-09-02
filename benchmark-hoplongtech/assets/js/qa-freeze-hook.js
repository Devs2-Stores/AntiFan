/**
 * AntiFan Pre-Visual QA Freeze & Masking Utility
 * Automatically stabilizes carousels, timers, and external floating widgets before visual capture.
 */
(function() {
  window.__antiFreezeState = function() {
    try {
      // 1. Clear all active timer intervals and timeouts
      let highestIntervalId = window.setInterval(() => {}, 9999);
      for (let i = 1; i <= highestIntervalId; i++) {
        window.clearInterval(i);
        window.clearTimeout(i);
      }

      // 2. Freeze Swiper carousels to frame 0
      document.querySelectorAll('.swiper-container, .swiper, .slide-content .swiper').forEach(el => {
        if (el.swiper) {
          if (el.swiper.autoplay && typeof el.swiper.autoplay.stop === 'function') {
            el.swiper.autoplay.stop();
          }
          if (typeof el.swiper.slideTo === 'function') {
            el.swiper.slideTo(0, 0, false);
          }
        }
      });

      // 3. Freeze custom transform sliders (Alpine.js / Livewire)
      const sContent = document.querySelector('.slide-content__detail .s-content');
      if (sContent) {
        sContent.style.transform = 'translateX(0px)';
        sContent.style.transition = 'none';
      }

      const dots = document.querySelectorAll('.slide-content__detail .dot');
      dots.forEach((d, idx) => {
        if (idx === 0) d.classList.add('active');
        else d.classList.remove('active');
      });

      // 4. Purge 3rd-party floating widgets (Tawk.to, Zalo, Facebook, Ads)
      document.querySelectorAll('[id*="tawk"], [class*="tawk"], [id*="zalo"], [id*="fb-root"], iframe, .notice-cart').forEach(el => {
        el.style.display = 'none';
      });

      // 5. Reset scroll position to top-left
      window.scrollTo(0, 0);

      return {
        frozen: true,
        timestamp: Date.now(),
        scrollX: window.scrollX,
        scrollY: window.scrollY
      };
    } catch (err) {
      return {
        frozen: false,
        error: String(err)
      };
    }
  };

  console.log('[AntiFan QA] Pre-Visual QA Freeze Hook loaded.');
})();
