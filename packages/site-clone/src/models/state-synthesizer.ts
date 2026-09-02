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

// 2. Category Navigation Hover & Click
function initCategorySubmenu() {
  const items = document.querySelectorAll('.category-navigation__list ul li');
  const subMenu = document.getElementById('category-navigation__sub');
  if (!items.length || !subMenu) return;

  items.forEach(item => {
    item.addEventListener('mouseenter', () => {
      subMenu.classList.add('active');
    });
  });

  const nav = document.querySelector('.category-navigation');
  if (nav) {
    nav.addEventListener('mouseleave', () => {
      subMenu.classList.remove('active');
    });
  }
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

// 5. Video Popup Dialog
function initVideoModal() {
  const videoBtn = document.querySelector('.video-content__button');
  const popup = document.getElementById('popup-video');
  const closeBtn = document.querySelector('.popup-close');
  const iframe = popup ? popup.querySelector('iframe') : null;

  if (videoBtn && popup) {
    videoBtn.addEventListener('click', (e) => {
      e.preventDefault();
      popup.style.display = 'flex';
      if (iframe) iframe.src = 'https://www.youtube.com/embed/Nt2J6ZX牢?autoplay=1';
    });
  }

  if (closeBtn && popup) {
    closeBtn.addEventListener('click', () => {
      popup.style.display = 'none';
      if (iframe) iframe.src = '';
    });
  }
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
