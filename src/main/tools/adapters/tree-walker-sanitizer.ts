/**
 * Isolated TreeWalker Sanitizer Adapter for AntiFan Browser Desktop
 * Strips dynamic server-side rendering (SSR) metadata blobs (Livewire, Alpine, Nuxt)
 * directly in browser memory before exporting clean static themes.
 */

export interface TreeWalkerSanitizerOptions {
  stripLivewire?: boolean;
  stripAlpine?: boolean;
  stripComments?: boolean;
  stripModals?: boolean;
  selector?: string;
}

export function buildTreeWalkerSanitizerScript(options: TreeWalkerSanitizerOptions = {}): string {
  const {
    stripLivewire = true,
    stripAlpine = true,
    stripComments = true,
    stripModals = true,
    selector = '',
  } = options;

  return `
    (() => {
      const isFullDoc = !${JSON.stringify(selector)};
      const root = isFullDoc ? document.documentElement : document.querySelector(${JSON.stringify(selector)});
      if (!root) return '';
      const clone = root.cloneNode(true);

      const sanitizeElementAttributes = (el) => {
        if (!el || !el.attributes) return;
        if (el.id === 'category-navigation__sub' && !el.classList.contains('category-navigation__sub')) {
          el.classList.add('category-navigation__sub');
        }
        const attrsToRemove = [];
        for (let i = 0; i < el.attributes.length; i++) {
          const attr = el.attributes[i];
          const name = attr.name.toLowerCase();
          const val = attr.value || '';

          if (el.tagName === 'IFRAME' && (name === ':data-src' || name === ':src' || name === 'data-src' || name === 'src')) {
            const ytMatch = val.match(/(https?:\\/\\/(?:www\\.)?(?:youtube\\.com|youtu\\.be)\\/[^"'\\s)]+)/i);
            if (ytMatch && (!el.getAttribute('data-src') || el.getAttribute('data-src') === '')) {
              el.setAttribute('data-src', ytMatch[1]);
              el.setAttribute('src', '');
            }
          }

          ${stripLivewire ? `
            if (
              name.startsWith('wire:') ||
              name.startsWith('data-wire-') ||
              name === 'wire:snapshot' ||
              name === 'wire:effects' ||
              name === 'wire:id' ||
              name === 'wire:memo' ||
              name === 'wire:initial-data'
            ) {
              attrsToRemove.push(attr.name);
            }
          ` : ''}

          ${stripAlpine ? `
            if (name.startsWith('x-') || name.startsWith('@') || name.startsWith(':') || name.startsWith('x-data') || name.startsWith('x-bind') || name.startsWith('x-on:')) {
              attrsToRemove.push(attr.name);
            }
          ` : ''}

          if (name.startsWith('data-server-rendered') || name.startsWith('ng-reflect-')) {
            attrsToRemove.push(attr.name);
          }
        }

        for (const attrName of attrsToRemove) {
          el.removeAttribute(attrName);
        }
      };
      // Hide or strip unhydrated SSR/Livewire modals and popups that block viewports
      if (${stripModals}) {
        const modalSelectors = [
          '.modal.show',
          '.fade.show',
          '.modal-backdrop',
          '.popup-backdrop',
          '.fancybox__container'
        ];
        for (const sel of modalSelectors) {
          const modals = clone.querySelectorAll ? clone.querySelectorAll(sel) : [];
          for (const m of Array.from(modals)) {
            try {
              if (m && m.style) m.style.setProperty('display', 'none', 'important');
            } catch {}
          }
        }
      }

      // Convert lazy images to eager so pre-capture quiescence never hangs
      const lazyImgs = clone.querySelectorAll ? clone.querySelectorAll('img[loading="lazy"]') : [];
      for (const img of Array.from(lazyImgs)) {
        try {
          img.setAttribute('loading', 'eager');
        } catch {}
      }
      // Strip Livewire and runtime backend scripts that fail or hang offline
      ${stripLivewire ? `
        const livewireScripts = clone.querySelectorAll ? clone.querySelectorAll('script[src*="livewire"], script[data-csrf], script[data-update-uri]') : [];
        for (const s of Array.from(livewireScripts)) {
          try { s.remove(); } catch {}
        }
      ` : ''}

      // Strip third-party trackers, analytics, and non-essential third-party iframes
      const trackerElements = clone.querySelectorAll ? clone.querySelectorAll('script[src*="googletagmanager"], script[src*="google-analytics"], script[src*="clarity"], script[src*="tawk.to"], script[src*="facebook.net"], iframe[src*="googletagmanager"], iframe[src*="tawk.to"], iframe[src*="facebook.com"]') : [];
      for (const t of Array.from(trackerElements)) {
        try { t.remove(); } catch {}
      }

      // Neutralize autoplay sliders so offline viewports and captures are deterministic
      const autoplaySliders = clone.querySelectorAll ? clone.querySelectorAll('[data-autoplay="1"], [data-autoplay="true"]') : [];
      for (const s of Array.from(autoplaySliders)) {
        try { s.setAttribute('data-autoplay', '0'); } catch {}
      }

      // Sanitize root element itself
      if (clone.nodeType === Node.ELEMENT_NODE) {
        sanitizeElementAttributes(clone);
      }

      const walker = document.createTreeWalker(
        clone,
        NodeFilter.SHOW_ELEMENT | ${stripComments ? 'NodeFilter.SHOW_COMMENT' : '0'},
        null
      );

      const nodesToRemove = [];
      let currentNode;

      while ((currentNode = walker.nextNode())) {
        if (currentNode.nodeType === Node.COMMENT_NODE) {
          nodesToRemove.push(currentNode);
          continue;
        }

        if (currentNode.nodeType === Node.ELEMENT_NODE) {
          sanitizeElementAttributes(currentNode);
        }
      }

      for (const node of nodesToRemove) {
        if (node.parentNode) {
          node.parentNode.removeChild(node);
        }
      }

      if (isFullDoc) {
        if (!clone.querySelector('#antifan-clone-parity')) {
          const head = clone.querySelector('head') || clone;
          const parityStyle = document.createElement('style');
          parityStyle.id = 'antifan-clone-parity';
          parityStyle.textContent = \`
    /* Global responsive safety */
    html, body { max-width: 100vw !important; overflow-x: hidden !important; }
    /* Loading suggest spinner control */
    .loading-suggest { display: none !important; }
    .search-form__input.loading .loading-suggest { display: block !important; }
    /* Category Dropdown Navigation Parity */
    #category-navigation__sub, .category-navigation__sub {
      position: absolute !important;
      width: 100% !important;
      left: 0 !important;
      top: 0 !important;
      background-color: #fff !important;
      z-index: 1000 !important;
      padding: 0 20px 0 240px !important;
      height: 100% !important;
      max-height: 100% !important;
      box-sizing: border-box !important;
      transition: opacity 0.2s ease, visibility 0.2s ease !important;
    }
    #category-navigation__sub:not(.active), .category-navigation__sub:not(.active) {
      opacity: 0 !important;
      visibility: hidden !important;
      display: none !important;
      pointer-events: none !important;
    }
    #category-navigation__sub.active, .category-navigation__sub.active {
      opacity: 1 !important;
      visibility: visible !important;
      display: block !important;
      pointer-events: auto !important;
    }
    #category-navigation__sub .sub-menu, .category-navigation__sub .sub-menu {
      width: 100% !important;
      height: 100% !important;
      box-shadow: -4px 0 3px -4px rgba(0, 0, 0, 0.2) !important;
      padding: 20px 10px 20px 15px !important;
      box-sizing: border-box !important;
    }
    #category-navigation__sub ul.menu-child, .category-navigation__sub ul.menu-child {
      display: flex !important;
      flex-wrap: wrap !important;
      width: 100% !important;
      height: calc(100% - 10px) !important;
      overflow-y: auto !important;
      list-style: none !important;
      margin: 0 !important;
      padding: 0 !important;
    }
    #category-navigation__sub ul.menu-child > li, .category-navigation__sub ul.menu-child > li {
      flex: 0 0 25% !important;
      max-width: 25% !important;
      box-sizing: border-box !important;
      padding: 0 10px 15px 0 !important;
    }
    #category-navigation__sub ul.menu-child .has-child, .category-navigation__sub ul.menu-child .has-child {
      color: #3590ce !important;
      font-weight: 700 !important;
      display: block !important;
      margin-bottom: 8px !important;
    }
    #category-navigation__sub ul.menu-child .lv2 ul, .category-navigation__sub ul.menu-child .lv2 ul {
      list-style: none !important;
      margin: 0 !important;
      padding: 0 !important;
    }
    #category-navigation__sub ul.menu-child .lv2 li a, .category-navigation__sub ul.menu-child .lv2 li a {
      color: #767676 !important;
      font-size: 14px !important;
      display: block !important;
      padding: 4px 0 !important;
    }
    #category-navigation__sub ul.menu-child .lv2 li a:hover, .category-navigation__sub ul.menu-child .lv2 li a:hover {
      color: #3590ce !important;
    }
    /* Mobile drawer navigation parity locks */
    .category-navigation__block.show {
      opacity: 1 !important;
      visibility: visible !important;
      display: block !important;
    }
    .category-navigation__block.show .category-navigation {
      display: block !important;
      visibility: visible !important;
      opacity: 1 !important;
    }
    .category-navigation__header .bottom .back.show {
      display: block !important;
      visibility: visible !important;
      opacity: 1 !important;
    }
    .category-navigation__list > ul > li.show > .child-lv1 {
      display: block !important;
      visibility: visible !important;
      opacity: 1 !important;
    }
    .child-lv1 > li.show > .child-lv2 {
      display: block !important;
      visibility: visible !important;
      opacity: 1 !important;
    }
    /* Unhydrated modals & popups parity locks */
    #popup-login:not(.active), #popup-video:not(.active), .popup:not(.active), .modal:not(.active) {
      display: none !important;
      opacity: 0 !important;
      visibility: hidden !important;
      pointer-events: none !important;
    }
    #popup-login.active, .popup.active, .modal.active {
      display: flex !important;
      visibility: visible !important;
      opacity: 1 !important;
      pointer-events: auto !important;
    }
    #popup-video.active {
      display: flex !important;
      align-items: center !important;
      justify-content: center !important;
      position: fixed !important;
      top: 0 !important;
      left: 0 !important;
      right: 0 !important;
      bottom: 0 !important;
      width: 100vw !important;
      height: 100vh !important;
      background: rgba(0, 0, 0, 0.75) !important;
      z-index: 99999 !important;
      opacity: 1 !important;
      visibility: visible !important;
      pointer-events: auto !important;
    }
    #popup-video .popup-content {
      position: relative !important;
      width: 90% !important;
      max-width: 960px !important;
      background: #000 !important;
      border-radius: 8px !important;
      padding: 0 !important;
      overflow: visible !important;
      box-shadow: 0 20px 40px rgba(0, 0, 0, 0.6) !important;
    }
    #popup-video .popup-content__wrap {
      position: relative !important;
      width: 100% !important;
      padding-bottom: 56.25% !important;
      height: 0 !important;
      border-radius: 8px !important;
      overflow: hidden !important;
    }
    #popup-video iframe {
      position: absolute !important;
      top: 0 !important;
      left: 0 !important;
      width: 100% !important;
      height: 100% !important;
      border: none !important;
    }
    #popup-video .popup-close {
      position: absolute !important;
      top: -38px !important;
      right: 0 !important;
      cursor: pointer !important;
      z-index: 100001 !important;
      display: flex !important;
      align-items: center !important;
      justify-content: center !important;
      width: 32px !important;
      height: 32px !important;
      background: rgba(255, 255, 255, 0.3) !important;
      border-radius: 50% !important;
      transition: background 0.2s !important;
    }
    #popup-video .popup-close:hover {
      background: rgba(255, 255, 255, 0.6) !important;
    }
    /* Safe mobile scope */
    @media (max-width: 991px) {
      .slide-content > .category-navigation { display: none !important; }
      .category-navigation__block .category-navigation { display: block !important; }
    }
\`;
          head.appendChild(parityStyle);
        }

        if (!clone.querySelector('#antifan-clone-interactivity')) {
          const body = clone.querySelector('body') || clone;
          const scriptEl = document.createElement('script');
          scriptEl.id = 'antifan-clone-interactivity';
          scriptEl.textContent = \`
  document.addEventListener('DOMContentLoaded', function() {
    var navItems = document.querySelectorAll('.category-navigation__list ul li, .category-navigation__main li, .category-navigation ul li');
    var subContainer = document.getElementById('category-navigation__sub');
    var subMenus = subContainer ? subContainer.querySelectorAll('.sub-menu') : [];
    if (navItems.length && subMenus.length && subContainer) {
      navItems.forEach(function(item, idx) {
        item.addEventListener('mouseenter', function() {
          subContainer.classList.add('active');
          subMenus.forEach(function(m, mIdx) {
            m.style.display = (mIdx === idx) ? 'block' : 'none';
          });
        });
      });
      var navWrap = document.querySelector('.category-navigation');
      if (navWrap) {
        navWrap.addEventListener('mouseleave', function() {
          subContainer.classList.remove('active');
          subMenus.forEach(function(m) { m.style.display = 'none'; });
        });
      }
    }

    var mobileBtns = document.querySelectorAll('.menu-mobile, [data-toggle="menu-mobile"]');
    var mobileDrawer = document.querySelector('.category-navigation__block');
    var drawerCloseBtn = document.querySelector('.category-navigation__header .close, .category-navigation__block .close');
    var drawerBackBtn = document.querySelector('.category-navigation__header .bottom .back, .category-navigation__block .back');

    if (mobileBtns.length && mobileDrawer) {
      mobileBtns.forEach(function(btn) {
        btn.addEventListener('click', function(e) {
          e.preventDefault();
          mobileDrawer.classList.add('show');
          document.body.style.overflow = 'hidden';
        });
      });
    }

    if (drawerCloseBtn && mobileDrawer) {
      drawerCloseBtn.addEventListener('click', function(e) {
        e.preventDefault();
        mobileDrawer.classList.remove('show');
        document.body.style.overflow = '';
      });
    }

    if (mobileDrawer) {
      mobileDrawer.addEventListener('click', function(e) {
        if (e.target === mobileDrawer) {
          mobileDrawer.classList.remove('show');
          document.body.style.overflow = '';
        }
      });
    }

    var l1Spans = document.querySelectorAll('.category-navigation__list > ul > li > p > span, .category-navigation__list > ul > li > p > a ~ span');
    l1Spans.forEach(function(span) {
      span.addEventListener('click', function(e) {
        e.preventDefault();
        e.stopPropagation();
        var parentLi = span.closest('li');
        if (parentLi) {
          document.querySelectorAll('.category-navigation__list > ul > li.show').forEach(function(li) {
            if (li !== parentLi) li.classList.remove('show');
          });
          parentLi.classList.add('show');
          if (drawerBackBtn) drawerBackBtn.classList.add('show');
        }
      });
    });

    if (drawerBackBtn) {
      drawerBackBtn.addEventListener('click', function(e) {
        e.preventDefault();
        drawerBackBtn.classList.remove('show');
        document.querySelectorAll('.category-navigation__list > ul > li.show').forEach(function(li) {
          li.classList.remove('show');
        });
      });
    }

    var l2Spans = document.querySelectorAll('.child-lv1 > li > p > span, .child-lv1 > li > p > a ~ span');
    l2Spans.forEach(function(span) {
      span.addEventListener('click', function(e) {
        e.preventDefault();
        e.stopPropagation();
        var parentLi = span.closest('li');
        if (parentLi) {
          parentLi.classList.toggle('show');
        }
      });
    });

    var videoBtns = document.querySelectorAll('.video-content__button, [data-fancybox="video"], [href*="youtube.com"], [href*="youtu.be"]');
    var videoPopup = document.getElementById('popup-video');
    if (videoPopup) {
      videoBtns.forEach(function(btn) {
        btn.addEventListener('click', function(e) {
          e.preventDefault();
          videoPopup.classList.add('active');
          var iframe = videoPopup.querySelector('iframe');
          if (iframe) {
            var rawSrc = iframe.getAttribute('data-src') || iframe.getAttribute('src') || 'https://www.youtube.com/embed/Nt2J6ZXPuw0';
            iframe.src = rawSrc.includes('?') ? rawSrc + '&autoplay=1' : rawSrc + '?autoplay=1';
          }
        });
      });
      var closeVideo = videoPopup.querySelector('.popup-close');
      if (closeVideo) {
        closeVideo.addEventListener('click', function() {
          videoPopup.classList.remove('active');
          var iframe = videoPopup.querySelector('iframe');
          if (iframe) iframe.src = '';
        });
      }
      videoPopup.addEventListener('click', function(e) {
        if (e.target === videoPopup) {
          videoPopup.classList.remove('active');
          var iframe = videoPopup.querySelector('iframe');
          if (iframe) iframe.src = '';
        }
      });
    }

    var loginBtns = document.querySelectorAll('.open-login, [href*="/login"]');
    var loginPopup = document.getElementById('popup-login');
    if (loginPopup) {
      loginBtns.forEach(function(btn) {
        btn.addEventListener('click', function(e) {
          e.preventDefault();
          loginPopup.classList.add('active');
        });
      });
      var closeLogin = loginPopup.querySelector('.popup-close');
      if (closeLogin) {
        closeLogin.addEventListener('click', function() {
          loginPopup.classList.remove('active');
        });
      }
      loginPopup.addEventListener('click', function(e) {
        if (e.target === loginPopup) {
          loginPopup.classList.remove('active');
        }
      });
    }

    var searchInput = document.querySelector('.search-form__input input');
    var searchSuggest = document.getElementById('suggest');
    if (searchInput && searchSuggest) {
      searchInput.addEventListener('focus', function() { searchSuggest.classList.add('active'); });
      searchInput.addEventListener('click', function(e) { e.stopPropagation(); });
      document.addEventListener('click', function(e) {
        var target = e.target;
        if (target && typeof target.closest === 'function' && !target.closest('.main-header__search')) {
          searchSuggest.classList.remove('active');
        }
      });
    }
  });
\`;
          body.appendChild(scriptEl);
        }
      }

      // Serialized markup is re-parsed by every consumer, and the HTML tree builder
      // auto-closes an open <p> at the next block-level start tag, while a client-built
      // DOM may nest one paragraph inside another. Demoting only the hazardous
      // paragraph preserves the nesting and the typography its items inherit.
      // Canonical rule table: packages/site-clone/src/generators/html-parse-fidelity.ts
      var normalizeHtmlAutoclose = function (root) {
        if (!root || !root.querySelectorAll) return 0;
        var P_CLOSING = {ADDRESS:1,ARTICLE:1,ASIDE:1,BLOCKQUOTE:1,CENTER:1,DETAILS:1,DIALOG:1,DIR:1,DIV:1,DL:1,DT:1,DD:1,FIELDSET:1,FIGCAPTION:1,FIGURE:1,FOOTER:1,FORM:1,H1:1,H2:1,H3:1,H4:1,H5:1,H6:1,HEADER:1,HGROUP:1,HR:1,LI:1,LISTING:1,MAIN:1,MENU:1,NAV:1,OL:1,P:1,PLAINTEXT:1,PRE:1,SEARCH:1,SECTION:1,SUMMARY:1,TABLE:1,UL:1,XMP:1};
        var FOREIGN = {SVG:1,MATH:1,TEMPLATE:1};
        var hasHazard = function (node) {
          var children = node.children;
          for (var i = 0; i < children.length; i++) {
            var child = children[i];
            if (FOREIGN[child.tagName]) continue;
            if (P_CLOSING[child.tagName]) return true;
            if (hasHazard(child)) return true;
          }
          return false;
        };
        var owner = root.ownerDocument || document;
        var paragraphs = root.querySelectorAll('p');
        var renamed = 0;
        for (var p = 0; p < paragraphs.length; p++) {
          var paragraph = paragraphs[p];
          if (!hasHazard(paragraph)) continue;
          var replacement = owner.createElement('div');
          for (var a = 0; a < paragraph.attributes.length; a++) {
            var attr = paragraph.attributes[a];
            replacement.setAttribute(attr.name, attr.value);
          }
          while (paragraph.firstChild) replacement.appendChild(paragraph.firstChild);
          if (paragraph.parentNode) paragraph.parentNode.replaceChild(replacement, paragraph);
          renamed++;
        }
        return renamed;
      };
      normalizeHtmlAutoclose(clone);

      return (isFullDoc ? '<!DOCTYPE html>\\n' : '') + clone.outerHTML;
    })()
  `;
}
