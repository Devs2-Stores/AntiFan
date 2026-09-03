/**
 * ROAHTRIP HTML Specification Runtime Interaction Controller
 * Implements accessible, vanilla behavior without platform dependencies.
 */

document.addEventListener('DOMContentLoaded', () => {
  if ('scrollRestoration' in history) {
    history.scrollRestoration = 'manual';
  }
  initStickyHeader();
  initSlideshows();
  initDialogs();
  initMobileMenu();
  initMediaVideo();
});

/* 1. Sticky Header Controller */
function initStickyHeader() {
  const header = document.querySelector('.site-header');
  if (!header) return;

  const handleScroll = () => {
    if (window.scrollY > 40) {
      header.classList.remove('site-header--transparent');
      header.classList.add('site-header--solid');
    } else {
      header.classList.add('site-header--transparent');
      header.classList.remove('site-header--solid');
    }
  };

  window.addEventListener('scroll', handleScroll, { passive: true });
  handleScroll();
}

/* 2. Accessible Slideshow Controller */
function initSlideshows() {
  const slideshowSections = document.querySelectorAll('.section-slideshow');

  slideshowSections.forEach(section => {
    const slides = Array.from(section.querySelectorAll('.slideshow-slide'));
    const dots = Array.from(section.querySelectorAll('.slideshow-dot'));
    const toggleBtn = section.querySelector('.slideshow-toggle-play');

    if (slides.length <= 1) return;

    let currentIndex = 0;
    let isPlaying = true;
    let intervalId = null;

    const goToSlide = (index) => {
      slides[currentIndex].classList.remove('is-active');
      slides[currentIndex].setAttribute('aria-hidden', 'true');
      dots[currentIndex]?.classList.remove('is-active');
      dots[currentIndex]?.setAttribute('aria-selected', 'false');

      currentIndex = (index + slides.length) % slides.length;

      slides[currentIndex].classList.add('is-active');
      slides[currentIndex].setAttribute('aria-hidden', 'false');
      dots[currentIndex]?.classList.add('is-active');
      dots[currentIndex]?.setAttribute('aria-selected', 'true');
    };

    const nextSlide = () => goToSlide(currentIndex + 1);

    const startAutoplay = () => {
      clearInterval(intervalId);
      intervalId = setInterval(nextSlide, 5000);
      isPlaying = true;
      if (toggleBtn) {
        toggleBtn.setAttribute('aria-label', 'Pause slideshow');
        toggleBtn.innerHTML = `
          <svg width="14" height="14" viewBox="0 0 14 14" fill="currentColor">
            <rect x="2" y="2" width="3" height="10" rx="1" />
            <rect x="9" y="2" width="3" height="10" rx="1" />
          </svg>`;
      }
    };

    const stopAutoplay = () => {
      clearInterval(intervalId);
      intervalId = null;
      isPlaying = false;
      if (toggleBtn) {
        toggleBtn.setAttribute('aria-label', 'Play slideshow');
        toggleBtn.innerHTML = `
          <svg width="14" height="14" viewBox="0 0 14 14" fill="currentColor">
            <polygon points="3,2 12,7 3,12" />
          </svg>`;
      }
    };

    dots.forEach((dot, idx) => {
      dot.addEventListener('click', () => {
        goToSlide(idx);
        if (isPlaying) startAutoplay(); // reset timer
      });
    });

    if (toggleBtn) {
      toggleBtn.addEventListener('click', () => {
        if (isPlaying) stopAutoplay();
        else startAutoplay();
      });
    }

    section.addEventListener('mouseenter', () => {
      clearInterval(intervalId);
    });

    section.addEventListener('mouseleave', () => {
      if (isPlaying) startAutoplay();
    });

    startAutoplay();
  });
}

/* 3. Modal & Drawer Dialogs */
function initDialogs() {
  // Search Modal
  const searchModal = document.getElementById('search-modal');
  const openSearchBtns = document.querySelectorAll('[data-action="open-search"]');
  const closeSearchBtns = document.querySelectorAll('[data-action="close-search"]');

  openSearchBtns.forEach(btn => {
    btn.addEventListener('click', () => {
      if (searchModal && typeof searchModal.showModal === 'function') {
        searchModal.showModal();
        const input = searchModal.querySelector('input[type="search"]');
        if (input) setTimeout(() => input.focus(), 50);
      }
    });
  });

  closeSearchBtns.forEach(btn => {
    btn.addEventListener('click', () => {
      if (searchModal) searchModal.close();
    });
  });

  if (searchModal) {
    searchModal.addEventListener('click', (e) => {
      const inner = searchModal.querySelector('.search-modal__inner');
      if (inner && !inner.contains(e.target)) {
        searchModal.close();
      }
    });
  }

  // Cart Drawer
  const cartDrawer = document.getElementById('cart-drawer');
  const openCartBtns = document.querySelectorAll('[data-action="open-cart"]');
  const closeCartBtns = document.querySelectorAll('[data-action="close-cart"]');

  openCartBtns.forEach(btn => {
    btn.addEventListener('click', () => {
      if (cartDrawer && typeof cartDrawer.showModal === 'function') {
        cartDrawer.showModal();
      }
    });
  });

  closeCartBtns.forEach(btn => {
    btn.addEventListener('click', () => {
      if (cartDrawer) cartDrawer.close();
    });
  });

  if (cartDrawer) {
    cartDrawer.addEventListener('click', (e) => {
      if (e.target === cartDrawer) {
        cartDrawer.close();
      }
    });
  }
}

/* 4. Mobile Navigation Drawer */
function initMobileMenu() {
  const menuBtn = document.querySelector('.site-header__menu-btn');
  const drawer = document.querySelector('.mobile-nav-drawer');

  if (!menuBtn || !drawer) return;

  menuBtn.addEventListener('click', () => {
    const isOpen = drawer.classList.toggle('is-open');
    menuBtn.setAttribute('aria-expanded', isOpen ? 'true' : 'false');
    document.body.style.overflow = isOpen ? 'hidden' : '';
  });
}

/* 5. Media Video Play/Pause Overlay */
function initMediaVideo() {
  const overlays = document.querySelectorAll('.media-play-overlay');

  overlays.forEach(overlay => {
    overlay.addEventListener('click', () => {
      const container = overlay.closest('.media-content-split__media, .unboxing-banner');
      const video = container?.querySelector('video');
      if (video) {
        if (video.paused) {
          video.play();
          overlay.style.opacity = '0';
          overlay.style.pointerEvents = 'none';
        } else {
          video.pause();
          overlay.style.opacity = '1';
          overlay.style.pointerEvents = 'auto';
        }
      }
    });
  });
}
