/**
 * Hoplongtech Modular Storefront Interactions
 * Haravan-Ready Vanilla JS Architecture
 */
function initHoplongStorefront() {
  // Category Submenu Interactions
  const categoryNav = document.querySelector('.category-navigation');
  const categoryItems = document.querySelectorAll('.category-navigation__list ul li');
  const subMenuContainer = document.getElementById('category-navigation__sub');
  const subMenus = subMenuContainer ? Array.from(subMenuContainer.querySelectorAll('.sub-menu')) : [];

  if (categoryItems.length && subMenuContainer) {
    let hideTimer = null;

    const showSubMenu = (index) => {
      if (hideTimer) {
        clearTimeout(hideTimer);
        hideTimer = null;
      }
      subMenuContainer.classList.add('active');
      subMenus.forEach((sm, smIdx) => {
        if (smIdx === index) {
          sm.style.display = 'block';
        } else {
          sm.style.display = 'none';
        }
      });
    };

    const hideAll = () => {
      hideTimer = setTimeout(() => {
        subMenuContainer.classList.remove('active');
        subMenus.forEach(sm => {
          sm.style.display = 'none';
        });
      }, 100);
    };

    categoryItems.forEach((item, index) => {
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
  // Accessory Tabs Switching
  const accessoryTabs = document.querySelectorAll('.accessory-tabs li');
  if (accessoryTabs.length) {
    accessoryTabs.forEach(tab => {
      tab.addEventListener('click', (e) => {
        e.preventDefault();
        accessoryTabs.forEach(t => t.classList.remove('active'));
        tab.classList.add('active');
      });
    });
  }

  // Branch Selector Dropdown
  const systermBtn = document.querySelector('.systerm .item-cta');
  const systermList = document.getElementById('systerm-list');
  if (systermBtn && systermList) {
    systermBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      systermList.classList.toggle('active');
    });

    document.addEventListener('click', () => {
      systermList.classList.remove('active');
    });
  }

  // Video Popup Handler (Image, button, backdrop, close button, Esc key)
  const videoTriggers = document.querySelectorAll('.video-content, .video-content__button, .video-content__image, .video-content__image img');
  const videoPopup = document.getElementById('popup-video');
  const videoClose = videoPopup ? videoPopup.querySelector('.popup-close') : null;
  const videoIframe = videoPopup ? videoPopup.querySelector('iframe') : null;

  const openVideoModal = (e) => {
    if (e) e.preventDefault();
    if (!videoPopup) return;
    videoPopup.classList.add('active');
    videoPopup.style.display = 'flex';
    if (videoIframe) {
      videoIframe.src = 'https://www.youtube.com/embed/Nt2J6ZXPuw0?autoplay=1';
    }
  };

  const closeVideoModal = (e) => {
    if (e) e.preventDefault();
    if (!videoPopup) return;
    videoPopup.classList.remove('active');
    videoPopup.style.display = 'none';
    if (videoIframe) {
      videoIframe.src = '';
    }
  };

  videoTriggers.forEach(trig => {
    trig.addEventListener('click', (e) => {
      if (videoPopup && videoPopup.contains(e.target)) return;
      openVideoModal(e);
    });
  });

  if (videoClose) {
    videoClose.addEventListener('click', closeVideoModal);
  }

  if (videoPopup) {
    videoPopup.addEventListener('click', (e) => {
      if (e.target === videoPopup) {
        closeVideoModal(e);
      }
    });
  }

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && videoPopup && videoPopup.classList.contains('active')) {
      closeVideoModal(e);
    }
  });

  console.log('[Hoplongtech Haravan Storefront] Modular UI initialized.');
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initHoplongStorefront);
} else {
  initHoplongStorefront();
}