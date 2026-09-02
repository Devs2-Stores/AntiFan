/**
 * Hoplongtech Benchmark Modular Storefront Interactions
 * Matched to benchmark-hoplongtech/index.html markup
 */

export function initHoplongtechStorefront() {
  // 1. Hero Slider Interaction
  initHeroSlider();

  // 2. Category Submenu Hover
  initCategorySubmenu();

  // 3. Brand / Product Tabs
  initBrandTabs();

  // 4. Branch Selector Dropdown
  initBranchSelector();

  // 5. Video Popup Dialog
  initVideoPopup();

  // 6. Search Suggestion
  initSearchInput();

  console.log('✅ [Hoplongtech Storefront] Modular UI Initialized Successfully.');
}

function initHeroSlider() {
  const sContent = document.querySelector('.slide-content__detail .s-content');
  if (!sContent) return;

  const items = sContent.querySelectorAll('.item');
  if (!items.length) return;

  let currentIndex = 0;
  const totalSlides = items.length;
  const slideWidth = 775; // px

  const goToSlide = (idx) => {
    currentIndex = (idx + totalSlides) % totalSlides;
    sContent.style.transform = `translateX(-${currentIndex * slideWidth}px)`;
    sContent.style.transition = 'transform 0.5s ease-in-out';
  };

  // Autoplay loop (5000ms)
  let timer = setInterval(() => {
    goToSlide(currentIndex + 1);
  }, 5000);

  sContent.addEventListener('mouseenter', () => clearInterval(timer));
  sContent.addEventListener('mouseleave', () => {
    clearInterval(timer);
    timer = setInterval(() => goToSlide(currentIndex + 1), 5000);
  });
}

function initCategorySubmenu() {
  const categoryItems = document.querySelectorAll('.category-navigation__list ul li');
  const subMenu = document.getElementById('category-navigation__sub');
  const navContainer = document.querySelector('.category-navigation');

  if (!categoryItems.length || !subMenu) return;

  categoryItems.forEach(item => {
    item.addEventListener('mouseenter', () => {
      subMenu.classList.add('active');
    });
  });

  if (navContainer) {
    navContainer.addEventListener('mouseleave', () => {
      subMenu.classList.remove('active');
    });
  }
}

function initBrandTabs() {
  const tabs = document.querySelectorAll('.tabs .tab-item, .accessory-tabs li');
  tabs.forEach(tab => {
    tab.addEventListener('click', (e) => {
      e.preventDefault();
      tabs.forEach(t => t.classList.remove('active'));
      tab.classList.add('active');
    });
  });
}

function initBranchSelector() {
  const systermBtn = document.querySelector('.systerm .item-cta');
  const systermList = document.getElementById('systerm-list');
  if (!systermBtn || !systermList) return;

  systermBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    systermList.classList.toggle('active');
  });

  document.addEventListener('click', () => {
    systermList.classList.remove('active');
  });
}

function initVideoPopup() {
  const videoBtn = document.querySelector('.video-content__button');
  const videoPopup = document.getElementById('popup-video');
  if (!videoBtn || !videoPopup) return;

  const videoClose = videoPopup.querySelector('.popup-close');
  const videoIframe = videoPopup.querySelector('iframe');

  videoBtn.addEventListener('click', () => {
    videoPopup.style.display = 'flex';
    if (videoIframe) {
      videoIframe.src = 'https://www.youtube.com/embed/Nt2J6ZXPuw0?autoplay=1';
    }
  });

  if (videoClose) {
    videoClose.addEventListener('click', () => {
      videoPopup.style.display = 'none';
      if (videoIframe) videoIframe.src = '';
    });
  }
}

function initSearchInput() {
  const searchInput = document.querySelector('.search-form__input input');
  if (!searchInput) return;

  searchInput.addEventListener('focus', () => {
    const popular = document.querySelector('.search-popular');
    if (popular) popular.classList.add('is-focused');
  });

  searchInput.addEventListener('blur', () => {
    const popular = document.querySelector('.search-popular');
    if (popular) popular.classList.remove('is-focused');
  });
}

// Auto-run on DOM ready
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initHoplongtechStorefront);
} else {
  initHoplongtechStorefront();
}
