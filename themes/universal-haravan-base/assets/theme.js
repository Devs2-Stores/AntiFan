/**
 * Universal Haravan Base Theme — Vanilla JavaScript Controller
 * Zero external framework dependencies. Manages accessible UI interactions:
 * - Native scroll-snap carousels with [data-carousel] hooks
 * - Off-canvas drawers (Cart & Mobile menu) with ARIA state management
 * - Tabbed interfaces (Product tabs, metafield tabs) with keyboard accessibility
 * - Modal dialogs (Quickview) loaded from the ?view=quickview template fragment
 * - Product image thumbnail gallery switching
 */

(function () {
  'use strict';

  function initCarousels() {
    const carousels = document.querySelectorAll('[data-carousel]');
    carousels.forEach((wrapper) => {
      const container = wrapper.querySelector('[data-carousel-container]');
      const prevBtn = wrapper.querySelector('[data-carousel-prev]');
      const nextBtn = wrapper.querySelector('[data-carousel-next]');

      if (!container) return;

      const getScrollAmount = () => {
        const slide = container.querySelector('.carousel-slide');
        return slide ? slide.offsetWidth + 24 : container.offsetWidth * 0.8;
      };

      if (prevBtn) {
        prevBtn.addEventListener('click', () => {
          container.scrollBy({ left: -getScrollAmount(), behavior: 'smooth' });
        });
      }

      if (nextBtn) {
        nextBtn.addEventListener('click', () => {
          container.scrollBy({ left: getScrollAmount(), behavior: 'smooth' });
        });
      }
    });
  }

  function initDrawers() {
    const backdrop = document.querySelector('.drawer-backdrop');
    const triggers = document.querySelectorAll('[data-drawer-trigger]');
    const closeButtons = document.querySelectorAll('[data-drawer-close]');
    const allDrawers = document.querySelectorAll('.drawer');

    function closeAllDrawers() {
      allDrawers.forEach((drawer) => {
        drawer.classList.remove('is-active');
        drawer.setAttribute('aria-hidden', 'true');
      });
      triggers.forEach((btn) => btn.setAttribute('aria-expanded', 'false'));
      if (backdrop) backdrop.classList.remove('is-active');
      document.body.style.overflow = '';
    }

    triggers.forEach((trigger) => {
      trigger.addEventListener('click', (event) => {
        event.preventDefault();
        const targetId = trigger.getAttribute('data-drawer-trigger');
        const drawer = document.getElementById(targetId);
        if (!drawer) return;

        const isCurrentlyActive = drawer.classList.contains('is-active');
        if (isCurrentlyActive) {
          closeAllDrawers();
        } else {
          closeAllDrawers();
          drawer.classList.add('is-active');
          drawer.setAttribute('aria-hidden', 'false');
          trigger.setAttribute('aria-expanded', 'true');
          if (backdrop) backdrop.classList.add('is-active');
          document.body.style.overflow = 'hidden';

          // Focus the close button or first interactive element
          const closeBtn = drawer.querySelector('[data-drawer-close]');
          if (closeBtn) closeBtn.focus();
        }
      });
    });

    closeButtons.forEach((btn) => {
      btn.addEventListener('click', (event) => {
        event.preventDefault();
        closeAllDrawers();
      });
    });

    if (backdrop) {
      backdrop.addEventListener('click', closeAllDrawers);
    }

    // Escape key listener
    document.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') {
        closeAllDrawers();
      }
    });
  }

  function initTabs() {
    const tabLists = document.querySelectorAll('[role="tablist"]');
    tabLists.forEach((tabList) => {
      const tabs = tabList.querySelectorAll('[role="tab"]');
      tabs.forEach((tab) => {
        tab.addEventListener('click', (event) => {
          event.preventDefault();
          const targetPanelId = tab.getAttribute('aria-controls');
          const parentContainer = tab.closest('.tabs-parent') || document;

          // Deactivate all sibling tabs in this tablist
          tabs.forEach((t) => {
            t.classList.remove('is-active');
            t.setAttribute('aria-selected', 'false');
          });

          // Hide all tabpanels
          const panels = parentContainer.querySelectorAll('[role="tabpanel"]');
          panels.forEach((panel) => {
            panel.classList.remove('is-active');
            panel.setAttribute('hidden', 'hidden');
          });

          // Activate clicked tab and panel
          tab.classList.add('is-active');
          tab.setAttribute('aria-selected', 'true');

          const activePanel = document.getElementById(targetPanelId);
          if (activePanel) {
            activePanel.classList.add('is-active');
            activePanel.removeAttribute('hidden');
          }
        });
      });
    });
  }

  function initProductGallery() {
    const mainImage = document.getElementById('ProductMainImage');
    const thumbnails = document.querySelectorAll('[data-gallery-thumbnail]');

    if (!mainImage || thumbnails.length === 0) return;

    thumbnails.forEach((thumb) => {
      thumb.addEventListener('click', (event) => {
        event.preventDefault();
        const fullSrc = thumb.getAttribute('data-full-src');
        if (fullSrc) {
          mainImage.src = fullSrc;
          thumbnails.forEach((t) => t.classList.remove('is-active'));
          thumb.classList.add('is-active');
        }
      });
    });
  }

  /**
   * The quickview body comes from the `?view=quickview` template fragment, so the
   * modal shows exactly what the product page would render. A failed load states
   * the failure in the modal instead of leaving the loading placeholder up.
   */
  function loadQuickview(trigger, modal) {
    const handle = trigger.getAttribute('data-product-handle');
    const body = modal.querySelector('#QuickviewBody');
    if (!handle || !body) return;
    if (body.getAttribute('data-loaded-handle') === handle) return;

    const setStatus = (text, isError) => {
      body.textContent = '';
      const status = document.createElement('p');
      status.className = isError ? 'quickview-status quickview-error' : 'quickview-status';
      status.textContent = text;
      body.appendChild(status);
    };

    setStatus('Đang tải thông tin sản phẩm...', false);

    fetch('/products/' + encodeURIComponent(handle) + '?view=quickview', {
      headers: { 'X-Requested-With': 'XMLHttpRequest' },
    })
      .then((response) => {
        if (!response.ok) throw new Error('HTTP ' + response.status);
        return response.text();
      })
      .then((html) => {
        body.innerHTML = html;
        body.setAttribute('data-loaded-handle', handle);
      })
      .catch(() => {
        setStatus('Không tải được thông tin sản phẩm. Vui lòng mở trang chi tiết.', true);
      });
  }

  function initModals() {
    const triggers = document.querySelectorAll('[data-modal-trigger]');
    const closeButtons = document.querySelectorAll('[data-modal-close]');
    const modals = document.querySelectorAll('.modal-dialog');

    function closeAllModals() {
      modals.forEach((modal) => {
        modal.classList.remove('is-active');
        modal.setAttribute('aria-hidden', 'true');
      });
      document.body.style.overflow = '';
    }

    triggers.forEach((trigger) => {
      trigger.addEventListener('click', (event) => {
        event.preventDefault();
        const targetId = trigger.getAttribute('data-modal-trigger');
        const modal = document.getElementById(targetId);
        if (modal) {
          modal.classList.add('is-active');
          modal.setAttribute('aria-hidden', 'false');
          document.body.style.overflow = 'hidden';
          loadQuickview(trigger, modal);
        }
      });
    });

    closeButtons.forEach((btn) => {
      btn.addEventListener('click', (event) => {
        event.preventDefault();
        closeAllModals();
      });
    });

    modals.forEach((modal) => {
      modal.addEventListener('click', (event) => {
        if (event.target === modal) {
          closeAllModals();
        }
      });
    });
  }

  // Self-initialization on DOM ready
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => {
      initCarousels();
      initDrawers();
      initTabs();
      initProductGallery();
      initModals();
    });
  } else {
    initCarousels();
    initDrawers();
    initTabs();
    initProductGallery();
    initModals();
  }
})();
