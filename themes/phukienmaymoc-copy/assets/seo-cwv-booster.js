/**
 * SEO CWV Booster — v4.0.0
 * Fix v4: Xóa addPreconnects() — đã chuyển server-side vào seo-pro-master.liquid
 *         Preconnect trong JS là quá muộn, phải render trong HTML <head> mới hiệu quả
 */

(function () {
  'use strict';

  // 1. Native Lazy Loading cho ảnh dưới fold
  function applyLazyLoading() {
    if (!('loading' in HTMLImageElement.prototype)) return;
    document.querySelectorAll('img:not([loading])').forEach(function (img) {
      var rect = img.getBoundingClientRect();
      if (rect.top >= window.innerHeight) {
        img.setAttribute('loading', 'lazy');
      }
    });
  }

  // 2. CLS Fix — gán width/height cho ảnh không có dimension
  function fixCLS() {
    document.querySelectorAll('img:not([width]):not([height])').forEach(function (img) {
      img.addEventListener('load', function () {
        if (!this.naturalWidth) return;
        this.setAttribute('width', this.naturalWidth);
        this.setAttribute('height', this.naturalHeight);
      });
    });
  }

  // 4. INP — Yield main thread khi idle
  function improveINP() {
    var yieldToMain = (typeof scheduler !== 'undefined' && scheduler.postTask)
      ? function (fn) { scheduler.postTask(fn, { priority: 'background' }); }
      : function (fn) { setTimeout(fn, 0); };
    document.addEventListener('click', function () {
      yieldToMain(applyLazyLoading);
    }, { once: true, passive: true });
  }

  // 5. [MỚI v3] Prefetch page khi user hover link sản phẩm/danh mục
  // Giảm thời gian chuyển trang, cải thiện perceived performance
  var prefetched = new Set();
  function setupPrefetchOnHover() {
    var selector = 'a[href*="/products/"], a[href*="/collections/"], a[href*="/blogs/"]';

    function prefetchURL(url) {
      if (prefetched.has(url)) return;
      // Chỉ prefetch URL cùng domain
      if (!url.startsWith(window.location.origin) && !url.startsWith('/')) return;
      prefetched.add(url);
      var link = document.createElement('link');
      link.rel = 'prefetch';
      link.href = url;
      link.as = 'document';
      document.head.appendChild(link);
    }

    // Dùng event delegation để không tốn memory listener
    var hoverTimer = null;
    document.addEventListener('mouseover', function (e) {
      var anchor = e.target.closest(selector);
      if (!anchor || !anchor.href) return;
      // Delay 150ms để tránh prefetch khi user chỉ lướt chuột qua
      hoverTimer = setTimeout(function () {
        prefetchURL(anchor.href);
      }, 150);
    }, { passive: true });

    document.addEventListener('mouseout', function (e) {
      var anchor = e.target.closest(selector);
      if (anchor && hoverTimer) {
        clearTimeout(hoverTimer);
        hoverTimer = null;
      }
    }, { passive: true });

    // Touch devices: prefetch khi touchstart (intent rõ hơn)
    document.addEventListener('touchstart', function (e) {
      var anchor = e.target.closest(selector);
      if (anchor && anchor.href) prefetchURL(anchor.href);
    }, { passive: true });
  }

  // Khởi động
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function () {
      applyLazyLoading();
      fixCLS();
      improveINP();
      setupPrefetchOnHover();
    });
  } else {
    applyLazyLoading();
    fixCLS();
    improveINP();
    setupPrefetchOnHover();
  }

})();
