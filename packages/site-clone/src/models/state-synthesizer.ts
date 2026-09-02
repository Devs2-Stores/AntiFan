/**
 * Model 4: State Synthesizer
 * Generates robust, reversible, vanilla JS controllers for storefront interactive widgets
 */

export interface SynthesizedWidgetContract {
  widgetType: 'slider' | 'tabs' | 'modal' | 'dropdown' | 'accordion' | 'search';
  selector: string;
  jsCode: string;
}

export class StateSynthesizer {
  public generateStorefrontJs(): string {
    return `
/**
 * Haravan Storefront Interactive Runtime
 * Clean, modular, reversible Vanilla JS controllers
 */

document.addEventListener('DOMContentLoaded', () => {
  initHeroSlider();
  initCategorySubmenu();
  initBrandTabs();
  initBranchSelector();
  initVideoModal();
  initQuoteValidation();
});

// 1. Hero Slider Controller
function initHeroSlider() {
  const slider = document.querySelector('.slide-content__detail .s-content');
  if (!slider) return;

  const items = slider.querySelectorAll('.item, .s-content__item');
  if (items.length <= 1) return;

  let currentIndex = 0;
  const total = items.length;
  const slideWidth = 775;

  const goTo = (idx) => {
    currentIndex = (idx + total) % total;
    slider.style.transform = \`translateX(-\${currentIndex * slideWidth}px)\`;
    slider.style.transition = 'transform 0.4s cubic-bezier(0.25, 1, 0.5, 1)';
  };

  let timer = setInterval(() => goTo(currentIndex + 1), 5000);

  slider.addEventListener('mouseenter', () => clearInterval(timer));
  slider.addEventListener('mouseleave', () => {
    clearInterval(timer);
    timer = setInterval(() => goTo(currentIndex + 1), 5000);
  });
}

// 2. Category Navigation Hover & Multi-Level Submenu
function initCategorySubmenu() {
  const items = document.querySelectorAll('.category-navigation__list ul li');
  const subMenuContainer = document.getElementById('category-navigation__sub');
  const subMenus = subMenuContainer ? Array.from(subMenuContainer.querySelectorAll('.sub-menu')) : [];
  if (!items.length || !subMenuContainer) return;

  let hideTimer = null;

  const showSubMenu = (index) => {
    if (hideTimer) {
      clearTimeout(hideTimer);
      hideTimer = null;
    }
    subMenuContainer.classList.add('active');
    subMenus.forEach((sm, i) => {
      if (i === index) {
        sm.style.display = 'block';
        sm.classList.add('active');
      } else {
        sm.style.display = 'none';
        sm.classList.remove('active');
      }
    });
  };

  const hideAll = () => {
    hideTimer = setTimeout(() => {
      subMenuContainer.classList.remove('active');
      subMenus.forEach(sm => {
        sm.style.display = 'none';
        sm.classList.remove('active');
      });
    }, 120);
  };

  items.forEach((item, index) => {
    item.addEventListener('mouseenter', () => showSubMenu(index));
    item.addEventListener('mouseleave', () => hideAll());
  });

  subMenuContainer.addEventListener('mouseenter', () => {
    if (hideTimer) {
      clearTimeout(hideTimer);
      hideTimer = null;
    }
  });

  subMenuContainer.addEventListener('mouseleave', () => hideAll());
}

// 3. Brand Tabs Switcher
function initBrandTabs() {
  const tabs = document.querySelectorAll('.tabs .tab-item, .accessory-tabs li');
  if (!tabs.length) return;

  tabs.forEach(tab => {
    tab.addEventListener('click', (e) => {
      e.preventDefault();
      tabs.forEach(t => t.classList.remove('active'));
      tab.classList.add('active');
    });
  });
}

// 4. Branch Selector Dropdown
function initBranchSelector() {
  const btn = document.querySelector('.systerm .item-cta');
  const dropdown = document.getElementById('systerm-list');
  if (!btn || !dropdown) return;

  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    const isVisible = dropdown.style.display === 'block';
    dropdown.style.display = isVisible ? 'none' : 'block';
  });

  document.addEventListener('click', () => {
    dropdown.style.display = 'none';
  });
}

// 5. Video Popup Dialog (Click image, button, backdrop, close button, Esc key)
function initVideoModal() {
  const videoTriggers = document.querySelectorAll('.video-content, .video-content__button, .video-content__image');
  const popup = document.getElementById('popup-video');
  const closeBtn = popup ? popup.querySelector('.popup-close') : document.querySelector('.popup-close');
  const iframe = popup ? popup.querySelector('iframe') : null;

  const openModal = (e) => {
    if (e) e.preventDefault();
    if (!popup) return;
    popup.classList.add('active');
    popup.style.display = 'flex';
    if (iframe) {
      iframe.src = 'https://www.youtube.com/embed/Nt2J6ZXPuw0?autoplay=1';
    }
  };

  const closeModal = (e) => {
    if (e) e.preventDefault();
    if (!popup) return;
    popup.classList.remove('active');
    popup.style.display = 'none';
    if (iframe) {
      iframe.src = '';
    }
  };

  videoTriggers.forEach(trig => {
    trig.addEventListener('click', (e) => {
      // Avoid re-triggering if clicking inside popup
      if (popup && popup.contains(e.target)) return;
      openModal(e);
    });
  });

  if (closeBtn) {
    closeBtn.addEventListener('click', closeModal);
  }

  if (popup) {
    // Backdrop click closes popup
    popup.addEventListener('click', (e) => {
      if (e.target === popup) {
        closeModal(e);
      }
    });
  }

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && popup && popup.classList.contains('active')) {
      closeModal(e);
    }
  });
}

// 6. Fast Quote Form Validation
function initQuoteValidation() {
  const form = document.getElementById('quote-form');
  if (!form) return;

  form.addEventListener('submit', (e) => {
    const phoneInput = form.querySelector('input[type="tel"]');
    if (phoneInput && !/^[0-9]{9,11}$/.test(phoneInput.value.replace(/\\s+/g, ''))) {
      e.preventDefault();
      alert('Vui lòng nhập số điện thoại hợp lệ (9-11 chữ số).');
      phoneInput.focus();
    }
  });
}
    `.trim();
  }
}
