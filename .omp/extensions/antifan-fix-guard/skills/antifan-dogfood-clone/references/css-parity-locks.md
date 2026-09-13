# Universal CSS Parity Locks Reference (`#antifan-clone-parity`)

## 1. Overview & Architectural Role
When modern dynamic framework attributes (Alpine, Vue, Livewire, Angular) are stripped from static DOM exports, declarative visual state bindings are lost.
The Core engine injects **Universal CSS Parity Locks** (`#antifan-clone-parity`) to ensure that:
1. Declarative toggle targets (`[data-antifan-target]`) are hidden until activated by user interaction.
2. Unhydrated modals, popups, overlays, drawers, and dropdowns do not leak onto the canvas or block viewports.
3. Activated modals and drawers receive proper centering, z-index layering, and viewport overflow containment.
4. Global horizontal overflow is strictly constrained across all viewports.

---

## 2. Universal Parity Stylesheet Specification

```css
<style id="antifan-clone-parity">
  /* 1. Global Viewport & Responsive Safety */
  html, body {
    max-width: 100vw !important;
    overflow-x: hidden !important;
  }

  /* 2. Universal Declarative Targets (Alpine x-show, Vue v-show synthesis) */
  [data-antifan-target]:not(.active) {
    display: none !important;
    opacity: 0 !important;
    visibility: hidden !important;
    pointer-events: none !important;
  }
  [data-antifan-target].active {
    display: block !important;
    opacity: 1 !important;
    visibility: visible !important;
    pointer-events: auto !important;
  }
  [data-antifan-toggle] {
    cursor: pointer !important;
  }

  /* 3. Universal Modals, Popups, Overlays & Drawers */
  .modal:not(.active):not(.show),
  .popup:not(.active):not(.show),
  .popover:not(.active):not(.show),
  .drawer:not(.active):not(.show),
  .dropdown-menu:not(.active):not(.show),
  .tooltip-content:not(.active):not(.show),
  [role="dialog"]:not(.active):not(.show):not([open]) {
    display: none !important;
    opacity: 0 !important;
    visibility: hidden !important;
    pointer-events: none !important;
  }

  .modal.active, .modal.show,
  .popup.active, .popup.show,
  .popover.active, .popover.show,
  .drawer.active, .drawer.show,
  .dropdown-menu.active, .dropdown-menu.show,
  .tooltip-content.active, .tooltip-content.show,
  [role="dialog"].active, [role="dialog"].show, [role="dialog"][open] {
    display: block !important;
    opacity: 1 !important;
    visibility: visible !important;
    pointer-events: auto !important;
  }

  /* 4. Active Fixed Overlays Layering */
  .modal.active, .modal.show, .popup.active, .popup.show {
    position: fixed !important;
    top: 0 !important;
    left: 0 !important;
    right: 0 !important;
    bottom: 0 !important;
    z-index: 100000 !important;
  }

  /* 5. Safe Mobile Viewport Scoping */
  @media (max-width: 991px) {
    .drawer.active, .drawer.show {
      position: fixed !important;
      top: 0 !important;
      left: 0 !important;
      height: 100vh !important;
      z-index: 99999 !important;
    }
  }
</style>
```

---

## 3. Core Invariants
* **Zero Site-Specific Selectors**: Parity rules in Core must target semantic standards (`[role]`, `[data-antifan-*]`, `.modal`, `.popup`, `.drawer`, `.dropdown-menu`) rather than benchmark-specific class names.
* **Cascade Priority**: Parity styles are injected at the end of `<head>`, ensuring they correctly override conflicting unhydrated layout rules while deferring to explicit inline styles when activated.
