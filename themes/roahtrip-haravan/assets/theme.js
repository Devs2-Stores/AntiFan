/**
 * Roahtrip Haravan Theme - Main JavaScript Controller
 * Vanilla JS ES6 - High Performance & Lightweight
 */

document.addEventListener('DOMContentLoaded', () => {
  initHeader();
  initMobileMenu();
  initCartDrawer();
  initSearchModal();
  initSlideshows();
  initProductCards();
  initVideoShowcase();
});

/* ==========================================================================
   1. Header Sticky & Scroll Detection
   ========================================================================== */
function initHeader() {
  const header = document.querySelector('[data-header]');
  if (!header) return;

  const handleScroll = () => {
    if (window.scrollY > 20) {
      header.classList.add('is-scrolled');
    } else {
      header.classList.remove('is-scrolled');
    }
  };

  window.addEventListener('scroll', handleScroll, { passive: true });
  handleScroll();
}

/* ==========================================================================
   2. Mobile Navigation Drawer
   ========================================================================== */
function initMobileMenu() {
  const trigger = document.querySelector('[data-mobile-menu-trigger]');
  const drawer = document.getElementById('MobileNavDrawer');
  const closeBtns = document.querySelectorAll('[data-mobile-menu-close]');
  if (!trigger || !drawer) return;

  const openDrawer = () => {
    drawer.classList.add('is-open');
    drawer.setAttribute('aria-hidden', 'false');
    document.body.classList.add('scroll-locked');
  };

  const closeDrawer = () => {
    drawer.classList.remove('is-open');
    drawer.setAttribute('aria-hidden', 'true');
    document.body.classList.remove('scroll-locked');
  };

  trigger.addEventListener('click', openDrawer);
  closeBtns.forEach(btn => btn.addEventListener('click', closeDrawer));

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && drawer.classList.contains('is-open')) {
      closeDrawer();
    }
  });
}

/* ==========================================================================
   3. Cart Drawer & AJAX Cart Operations
   ========================================================================== */
function initCartDrawer() {
  const drawer = document.getElementById('CartDrawer');
  const triggers = document.querySelectorAll('[data-cart-trigger]');
  const closeBtns = document.querySelectorAll('[data-drawer-close]');
  if (!drawer) return;

  const openDrawer = () => {
    drawer.classList.add('is-open');
    drawer.setAttribute('aria-hidden', 'false');
    document.body.classList.add('scroll-locked');
  };

  const closeDrawer = () => {
    drawer.classList.remove('is-open');
    drawer.setAttribute('aria-hidden', 'true');
    document.body.classList.remove('scroll-locked');
  };

  triggers.forEach(t => t.addEventListener('click', (e) => {
    e.preventDefault();
    openDrawer();
  }));

  closeBtns.forEach(btn => btn.addEventListener('click', closeDrawer));

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && drawer.classList.contains('is-open')) {
      closeDrawer();
    }
  });

  // Intercept Add To Cart Form Submissions (AJAX)
  document.addEventListener('submit', async (e) => {
    const form = e.target.closest('form[action*="/cart/add"], [data-card-form], [data-product-form]');
    if (!form) return;

    e.preventDefault();
    const submitBtn = form.querySelector('[type="submit"], [data-add-button]');
    const originalText = submitBtn ? submitBtn.innerText : '';
    if (submitBtn) {
      submitBtn.disabled = true;
      submitBtn.innerText = 'Adding...';
    }

    try {
      const formData = new FormData(form);
      const res = await fetch('/cart/add.js', {
        method: 'POST',
        body: formData,
        headers: { 'Accept': 'application/json' }
      });

      if (res.ok) {
        await refreshCart();
        openDrawer();
      } else {
        const err = await res.json();
        alert(err.description || 'Could not add product to cart.');
      }
    } catch (err) {
      console.error('Add to cart error:', err);
    } finally {
      if (submitBtn) {
        submitBtn.disabled = false;
        submitBtn.innerText = originalText;
      }
    }
  });

  // Handle Cart Item Quantity Changes & Removals
  drawer.addEventListener('click', async (e) => {
    const changeBtn = e.target.closest('[data-qty-change]');
    const removeBtn = e.target.closest('[data-remove-item]');

    if (changeBtn) {
      const variantId = changeBtn.dataset.variantId;
      const delta = parseInt(changeBtn.dataset.qtyChange, 10);
      const itemEl = changeBtn.closest('[data-line-item-id]');
      const currentQty = parseInt(itemEl.querySelector('[data-item-qty]').innerText, 10);
      const newQty = Math.max(0, currentQty + delta);
      await updateCartQuantity(variantId, newQty);
    } else if (removeBtn) {
      const variantId = removeBtn.dataset.variantId;
      await updateCartQuantity(variantId, 0);
    }
  });

  async function updateCartQuantity(id, quantity) {
    try {
      await fetch('/cart/change.js', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
        body: JSON.stringify({ id, quantity })
      });
      await refreshCart();
    } catch (err) {
      console.error('Update cart error:', err);
    }
  }

  async function refreshCart() {
    try {
      const res = await fetch('/cart.js');
      const cart = await res.json();

      // Update badge counts
      document.querySelectorAll('[data-cart-count]').forEach(el => {
        el.innerText = cart.item_count;
      });

      // Update Subtotal
      const subtotalEl = drawer.querySelector('[data-cart-subtotal]');
      if (subtotalEl) {
        subtotalEl.innerText = formatMoney(cart.total_price);
      }

      // Update Items List HTML
      const itemsContainer = drawer.querySelector('[data-cart-items]');
      const footerEl = drawer.querySelector('[data-cart-footer]');

      if (cart.item_count === 0) {
        if (footerEl) footerEl.style.display = 'none';
        if (itemsContainer) {
          itemsContainer.innerHTML = `
            <div class="cart-drawer__empty text-center py-16">
              <div class="w-16 h-16 mx-auto mb-4 bg-neutral-100 rounded-full flex items-center justify-center text-neutral-400">
                <svg class="w-8 h-8" fill="none" viewBox="0 0 20 20" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" d="M3.392 6.875h13.216v8.016c0 .567-.224 1.11-.623 1.511a2.127 2.127 0 0 1-1.503.625H5.518c-.563 0-1.104-.225-1.503-.625a2.14 2.14 0 0 1-.623-1.511V6.875Z"/></svg>
              </div>
              <p class="text-neutral-500 text-sm mb-6">Your shopping cart is currently empty.</p>
              <button type="button" class="bg-black text-white px-6 py-2.5 rounded-lg text-xs font-semibold uppercase tracking-wider hover:bg-neutral-800 transition-colors" data-drawer-close>
                Start Shopping
              </button>
            </div>
          `;
          itemsContainer.querySelector('[data-drawer-close]').addEventListener('click', closeDrawer);
        }
      } else {
        if (footerEl) footerEl.style.display = 'block';
        if (itemsContainer) {
          itemsContainer.innerHTML = cart.items.map(item => `
            <div class="cart-drawer__item py-4 flex space-x-4" data-line-item-id="${item.id}">
              <img src="${item.featured_image ? item.featured_image.url : ''}" alt="${item.title}" class="w-20 h-20 object-cover rounded-lg bg-neutral-100 border border-neutral-200 flex-shrink-0">
              <div class="flex-1 min-w-0">
                <h4 class="text-sm font-semibold text-neutral-900 truncate">
                  <a href="${item.url}" class="hover:underline">${item.product_title}</a>
                </h4>
                ${item.variant_title ? `<p class="text-xs text-neutral-500 mt-0.5">${item.variant_title}</p>` : ''}
                <div class="text-sm font-bold text-neutral-900 mt-1.5">${formatMoney(item.line_price)}</div>
                <div class="flex items-center justify-between mt-3">
                  <div class="inline-flex items-center border border-neutral-200 rounded-md">
                    <button type="button" class="px-2.5 py-1 text-neutral-500 hover:text-black hover:bg-neutral-50" data-qty-change="-1" data-variant-id="${item.id}">-</button>
                    <span class="px-3 text-xs font-semibold text-neutral-900" data-item-qty="${item.quantity}">${item.quantity}</span>
                    <button type="button" class="px-2.5 py-1 text-neutral-500 hover:text-black hover:bg-neutral-50" data-qty-change="1" data-variant-id="${item.id}">+</button>
                  </div>
                  <button type="button" class="text-xs text-neutral-400 hover:text-red-600 transition-colors" data-remove-item data-variant-id="${item.id}">Remove</button>
                </div>
              </div>
            </div>
          `).join('');
        }
      }
    } catch (err) {
      console.error('Refresh cart error:', err);
    }
  }

  function formatMoney(cents) {
    return '$' + (cents / 100).toFixed(2) + ' USD';
  }
}

/* ==========================================================================
   4. Search Modal
   ========================================================================== */
function initSearchModal() {
  const modal = document.getElementById('SearchModal');
  const triggers = document.querySelectorAll('[data-search-trigger]');
  const closeBtns = document.querySelectorAll('[data-search-close]');
  const input = document.getElementById('SearchModalInput');
  if (!modal) return;

  const openModal = () => {
    modal.classList.add('is-open');
    modal.setAttribute('aria-hidden', 'false');
    document.body.classList.add('scroll-locked');
    if (input) setTimeout(() => input.focus(), 100);
  };

  const closeModal = () => {
    modal.classList.remove('is-open');
    modal.setAttribute('aria-hidden', 'true');
    document.body.classList.remove('scroll-locked');
  };

  triggers.forEach(t => t.addEventListener('click', (e) => {
    e.preventDefault();
    openModal();
  }));

  closeBtns.forEach(b => b.addEventListener('click', closeModal));

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && modal.classList.contains('is-open')) {
      closeModal();
    }
  });
}

/* ==========================================================================
   5. Accessible Slideshows / Carousels
   ========================================================================== */
function initSlideshows() {
  const slideshows = document.querySelectorAll('[data-slideshow]');
  slideshows.forEach(section => {
    const track = section.querySelector('[data-carousel-track]');
    const slides = section.querySelectorAll('[data-slide]');
    const prevBtn = section.querySelector('[data-carousel-prev]');
    const nextBtn = section.querySelector('[data-carousel-next]');
    const dots = section.querySelectorAll('[data-dot]');
    if (!track || slides.length === 0) return;

    let currentIndex = 0;
    const totalSlides = slides.length;
    let autoPlayTimer = null;

    const goToSlide = (index) => {
      currentIndex = (index + totalSlides) % totalSlides;
      track.style.transform = `translateX(-${currentIndex * 100}%)`;

      dots.forEach((dot, idx) => {
        if (idx === currentIndex) {
          dot.classList.add('active');
        } else {
          dot.classList.remove('active');
        }
      });
    };

    if (prevBtn) prevBtn.addEventListener('click', () => {
      goToSlide(currentIndex - 1);
      resetAutoPlay();
    });

    if (nextBtn) nextBtn.addEventListener('click', () => {
      goToSlide(currentIndex + 1);
      resetAutoPlay();
    });

    dots.forEach(dot => {
      dot.addEventListener('click', () => {
        const target = parseInt(dot.dataset.dot, 10);
        goToSlide(target);
        resetAutoPlay();
      });
    });

    // Touch swipe gestures
    let startX = 0;
    let isDragging = false;

    track.addEventListener('touchstart', (e) => {
      startX = e.touches[0].clientX;
      isDragging = true;
    }, { passive: true });

    track.addEventListener('touchend', (e) => {
      if (!isDragging) return;
      const endX = e.changedTouches[0].clientX;
      const diffX = startX - endX;
      if (Math.abs(diffX) > 40) {
        if (diffX > 0) goToSlide(currentIndex + 1);
        else goToSlide(currentIndex - 1);
        resetAutoPlay();
      }
      isDragging = false;
    }, { passive: true });

    // Autoplay
    const startAutoPlay = () => {
      autoPlayTimer = setInterval(() => {
        goToSlide(currentIndex + 1);
      }, 5000);
    };

    const resetAutoPlay = () => {
      clearInterval(autoPlayTimer);
      startAutoPlay();
    };

    section.addEventListener('mouseenter', () => {
      clearInterval(autoPlayTimer);
    });

    section.addEventListener('mouseleave', () => {
      startAutoPlay();
    });

    startAutoPlay();
  });
}

/* ==========================================================================
   6. Product Cards Variant Switcher
   ========================================================================== */
function initProductCards() {
  const cards = document.querySelectorAll('[data-product-card]');
  cards.forEach(card => {
    const pills = card.querySelectorAll('[data-variant-id]');
    const hiddenInput = card.querySelector('[data-card-variant-id]');
    const priceDisplay = card.querySelector('[data-price]');

    pills.forEach(pill => {
      pill.addEventListener('click', () => {
        pills.forEach(p => {
          p.classList.remove('border-black', 'bg-black', 'text-white', 'active');
          p.classList.add('border-neutral-200', 'text-neutral-700');
        });

        pill.classList.add('border-black', 'bg-black', 'text-white', 'active');
        pill.classList.remove('border-neutral-200', 'text-neutral-700');

        if (hiddenInput && pill.dataset.variantId) {
          hiddenInput.value = pill.dataset.variantId;
        }

        if (priceDisplay && pill.dataset.variantPrice) {
          priceDisplay.innerText = pill.dataset.variantPrice;
        }
      });
    });
  });
}

/* ==========================================================================
   7. Media Showcase Video Player
   ========================================================================== */
function initVideoShowcase() {
  const wrappers = document.querySelectorAll('[data-video-wrapper]');
  wrappers.forEach(wrapper => {
    const video = wrapper.querySelector('[data-video-element]');
    const playBtn = wrapper.querySelector('[data-video-play-btn]');
    if (!video || !playBtn) return;

    const togglePlay = () => {
      if (video.paused) {
        video.play();
        wrapper.setAttribute('data-playing', 'true');
      } else {
        video.pause();
        wrapper.setAttribute('data-playing', 'false');
      }
    };

    playBtn.addEventListener('click', togglePlay);
    video.addEventListener('click', togglePlay);

    video.addEventListener('ended', () => {
      wrapper.setAttribute('data-playing', 'false');
    });
  });
}
