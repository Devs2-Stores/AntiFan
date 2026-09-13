# Universal Vanilla Interactivity Specification (`#antifan-clone-interactivity`)

## 1. Lifecycle Architecture & ReadyState Pattern
Dynamic scripts injected into static clones may evaluate either before or after `DOMContentLoaded`.
To guarantee reliable listener binding across all browser runtimes:
```javascript
function initAntifanInteractivity() {
  // Bind all interactive engines
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initAntifanInteractivity);
} else {
  initAntifanInteractivity();
}
```

---

## 2. Universal Declarative Toggle Engine
Synthesized by Core from Alpine (`@click="var = !var"`, `x-show="var"`), Vue (`v-on:click`, `v-show`), and Livewire.
Wires any `[data-antifan-toggle]` to its matching `[data-antifan-target]`:
```javascript
var togglers = document.querySelectorAll('[data-antifan-toggle]');
togglers.forEach(function(btn) {
  btn.addEventListener('click', function(e) {
    e.preventDefault();
    e.stopPropagation();
    var key = btn.getAttribute('data-antifan-toggle');
    if (!key) return;

    // Search within closest contextual container first, then document
    var scope = btn.closest('.form-row, .row, .card, .dropdown, .nav, .menu, form') || document;
    var targets = scope.querySelectorAll('[data-antifan-target="' + key + '"]');
    if (!targets.length) {
      targets = document.querySelectorAll('[data-antifan-target="' + key + '"]');
    }

    targets.forEach(function(target) {
      var willBeActive = !target.classList.contains('active');
      if (willBeActive) {
        target.classList.add('active');
        target.style.removeProperty('display');
        target.style.display = 'block';
      } else {
        target.classList.remove('active');
        target.style.display = 'none';
      }
    });
  });
});
```

---

## 3. Universal Outside-Click Dismissal
Automatically dismisses active declarative targets, popovers, tooltips, and dropdowns when user clicks outside:
```javascript
document.addEventListener('click', function(e) {
  var activeTargets = document.querySelectorAll('[data-antifan-target].active, [data-antifan-outside].active');
  activeTargets.forEach(function(target) {
    var key = target.getAttribute('data-antifan-target') || target.getAttribute('data-antifan-outside');
    var matchingToggle = document.querySelector('[data-antifan-toggle="' + key + '"]');
    if (e.target !== target && !target.contains(e.target) && (!matchingToggle || !matchingToggle.contains(e.target))) {
      target.classList.remove('active');
      target.style.display = 'none';
    }
  });
});
```

---

## 4. Universal Modal Dialog & Drawer Engine
Supports HTML5, Bootstrap, and ARIA modal specifications:
```javascript
var modalOpeners = document.querySelectorAll('[data-toggle="modal"], [data-bs-toggle="modal"], [data-modal-target], [data-antifan-modal]');
modalOpeners.forEach(function(opener) {
  opener.addEventListener('click', function(e) {
    e.preventDefault();
    var targetSel = opener.getAttribute('data-target') || opener.getAttribute('data-bs-target') || opener.getAttribute('data-modal-target') || opener.getAttribute('href');
    var modal = targetSel && targetSel.startsWith('#') ? document.querySelector(targetSel) : null;
    if (modal) {
      modal.classList.add('active', 'show');
      modal.style.removeProperty('display');
      document.body.classList.add('modal-open');
      var iframe = modal.querySelector('iframe[data-src]');
      if (iframe) {
        var rawSrc = iframe.getAttribute('data-src');
        if (rawSrc) iframe.src = rawSrc.includes('?') ? rawSrc + '&autoplay=1' : rawSrc + '?autoplay=1';
      }
    }
  });
});

var modalClosers = document.querySelectorAll('.modal-close, .popup-close, .close, [data-dismiss], [data-bs-dismiss], [aria-label="Close"], [aria-label="close"]');
modalClosers.forEach(function(closer) {
  closer.addEventListener('click', function(e) {
    e.preventDefault();
    var modal = closer.closest('.modal, .popup, .drawer, [role="dialog"]');
    if (modal) {
      modal.classList.remove('active', 'show');
      document.body.classList.remove('modal-open');
      var iframe = modal.querySelector('iframe');
      if (iframe) iframe.src = 'about:blank';
    }
  });
});
```

---

## 5. Universal Dropdowns & Navigation Menus
```javascript
var dropdownToggles = document.querySelectorAll('.dropdown-toggle, [data-toggle="dropdown"], [data-bs-toggle="dropdown"], .has-dropdown');
dropdownToggles.forEach(function(drop) {
  drop.addEventListener('mouseenter', function() {
    var menu = drop.querySelector('.dropdown-menu, .submenu, [data-dropdown-panel]');
    if (menu) menu.classList.add('active', 'show');
  });
  drop.addEventListener('mouseleave', function() {
    var menu = drop.querySelector('.dropdown-menu, .submenu, [data-dropdown-panel]');
    if (menu) menu.classList.remove('active', 'show');
  });
});
```
