/**
 * Model 4: State Synthesizer
 * Decoupled interaction & state modeling and declarative storefront runtime generation
 */
import type { StorefrontControllerContract } from './clone-ir.js';

export interface StateTransitionModel {
  id?: string;
  sectionId?: string;
  widgetType: 'carousel' | 'dropdown' | 'modal' | 'drawer' | 'tabs' | 'form_validation';
  triggerEvent: 'click' | 'mouseover' | 'mouseout' | 'keydown' | 'focus';
  targetSelector: string;
  triggerSelector: string;
  stateDelta: {
    property?: string;
    active: boolean;
  };
  ariaDelta?: {
    attribute: 'aria-expanded' | 'aria-hidden' | 'aria-selected';
    to: string;
  };
  effectType: 'class_toggle' | 'visibility_toggle' | 'media_pause' | 'focus_trap' | 'css_scroll_snap';
}

export interface SynthesizedWidgetContract {
  widgetType: 'slider' | 'tabs' | 'modal' | 'dropdown' | 'accordion' | 'search';
  selector: string;
  jsCode: string;
}
export class StateSynthesizer {
  /**
   * Generates the universal, event-delegated declarative micro-runtime
   * Replaces all hardcoded widget scripts with HTML data-attribute driven controllers
   */
  public generateDeclarativeRuntime(): string {
    return `(() => {
  if (window.__antifan_rt) return;
  window.__antifan_rt = true;
  const q = (s) => { try { return s ? document.querySelector(s) : null; } catch { return null; } };
  document.addEventListener('click', (e) => {
    const t = e.target.closest('[data-antifan-toggle]'); if (!t) return;
    const target = q(t.getAttribute('data-antifan-target') || t.getAttribute('data-antifan-toggle')) || t.nextElementSibling; if (!target) return;
    const cls = t.getAttribute('data-antifan-class') || 'active', grp = t.getAttribute('data-antifan-group');
    if (grp) {
      document.querySelectorAll('[data-antifan-group]').forEach((o) => {
        if (o !== t && o.getAttribute('data-antifan-group') === grp) {
          o.classList.remove(cls); o.setAttribute('aria-expanded', 'false');
          const sib = q(o.getAttribute('data-antifan-target') || o.getAttribute('data-antifan-toggle'));
          if (sib) { sib.classList.remove(cls); sib.setAttribute('aria-hidden', 'true'); }
        }
      });
    }
    const active = target.classList.toggle(cls);
    t.classList.toggle(cls, active); t.setAttribute('aria-expanded', String(active)); target.setAttribute('aria-hidden', String(!active));
  });
  let hTimer = null;
  document.addEventListener('mouseover', (e) => {
    const t = e.target.closest('[data-antifan-hover]') || e.target.closest('[data-antifan-dropdown-panel]'); if (!t) return;
    if (hTimer) { clearTimeout(hTimer); hTimer = null; }
    const p = t.hasAttribute('data-antifan-dropdown-panel') ? t : (q(t.getAttribute('data-antifan-target') || t.getAttribute('data-antifan-hover')) || t.querySelector('[data-antifan-dropdown-panel]'));
    if (p) p.classList.add('active');
  });
  document.addEventListener('mouseout', (e) => {
    const t = e.target.closest('[data-antifan-hover]') || e.target.closest('[data-antifan-dropdown-panel]'); if (!t) return;
    if (e.relatedTarget && (t.contains(e.relatedTarget) || (e.relatedTarget.closest && (e.relatedTarget.closest('[data-antifan-hover]') || e.relatedTarget.closest('[data-antifan-dropdown-panel]'))))) return;
    hTimer = setTimeout(() => { document.querySelectorAll('[data-antifan-dropdown-panel].active, [data-antifan-hover].active').forEach((el) => el.classList.remove('active')); }, 150);
  });
  let triggerEl = null;
  const closeModal = (m) => {
    if (!m) return;
    m.classList.remove('active'); m.setAttribute('aria-hidden', 'true');
    m.querySelectorAll('video').forEach((v) => { try { v.pause(); } catch {} });
    m.querySelectorAll('iframe').forEach((f) => {
      const s = f.getAttribute('src'); if (s && s !== 'about:blank') { f.setAttribute('data-antifan-src', s); f.removeAttribute('src'); }
    });
    if (triggerEl) { triggerEl.focus(); triggerEl = null; }
  };
  document.addEventListener('click', (e) => {
    const o = e.target.closest('[data-antifan-modal]');
    if (o) {
      const m = q(o.getAttribute('data-antifan-target') || o.getAttribute('data-antifan-modal'));
      if (m) {
        triggerEl = o; m.classList.add('active'); m.setAttribute('aria-hidden', 'false');
        m.querySelectorAll('iframe[data-antifan-src]').forEach((f) => f.setAttribute('src', f.getAttribute('data-antifan-src')));
        const f = m.querySelectorAll('button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])');
        if (f.length > 0) f[0].focus();
      }
      return;
    }
    const c = e.target.closest('[data-antifan-modal-close]'); if (c) { closeModal(c.closest('[data-antifan-modal-dialog]')); return; }
    if (e.target.matches('[data-antifan-modal-dialog]')) closeModal(e.target);
  });
  document.addEventListener('keydown', (e) => {
    const m = q('[data-antifan-modal-dialog].active'); if (!m) return;
    if (e.key === 'Escape') { closeModal(m); return; }
    if (e.key === 'Tab') {
      const f = Array.from(m.querySelectorAll('button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])')); if (!f.length) return;
      if (e.shiftKey && document.activeElement === f[0]) { f[f.length - 1].focus(); e.preventDefault(); }
      else if (!e.shiftKey && document.activeElement === f[f.length - 1]) { f[0].focus(); e.preventDefault(); }
    }
  });
  const initSlider = (s) => {
    if (s.__rt_init) return; s.__rt_init = true;
    const track = s.querySelector('[data-antifan-slider-track]') || s, iv = parseInt(s.getAttribute('data-antifan-autoplay'), 10) || 0;
    const step = () => (track.children[0] ? track.children[0].getBoundingClientRect().width : 300);
    if (iv > 0) {
      const start = () => { stop(); s.__timer = setInterval(() => {
        if (track.scrollLeft + track.clientWidth >= track.scrollWidth - 10) track.scrollTo({ left: 0, behavior: 'smooth' });
        else track.scrollBy({ left: step(), behavior: 'smooth' });
      }, iv); };
      const stop = () => { if (s.__timer) { clearInterval(s.__timer); s.__timer = null; } };
      s.addEventListener('mouseenter', stop); s.addEventListener('mouseleave', start); start();
    }
  };
  const scanSliders = () => document.querySelectorAll('[data-antifan-slider]').forEach(initSlider);
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', scanSliders);
  else scanSliders();
  document.addEventListener('click', (e) => {
    const n = e.target.closest('[data-antifan-slider-next]'), p = e.target.closest('[data-antifan-slider-prev]');
    if (n || p) {
      const btn = n || p, dir = n ? 1 : -1;
      const s = q(btn.getAttribute('data-antifan-target')) || btn.closest('[data-antifan-slider]');
      const t = s ? (s.querySelector('[data-antifan-slider-track]') || s) : null;
      if (t) t.scrollBy({ left: dir * (t.children[0] ? t.children[0].getBoundingClientRect().width : 300), behavior: 'smooth' });
    }
  });
})();`.trim();
  }

  /**
   * Infers platform-neutral semantic state transitions from controllers without code generation
   */
  public inferStateTransitions(controllers: StorefrontControllerContract[] = []): StateTransitionModel[] {
    return controllers.map((ctrl) => {
      let triggerEvent: StateTransitionModel['triggerEvent'] = 'click';
      let effectType: StateTransitionModel['effectType'] = 'class_toggle';
      let ariaDelta: StateTransitionModel['ariaDelta'];

      switch (ctrl.type) {
        case 'dropdown':
          triggerEvent = ctrl.behavior === 'hover_intent' ? 'mouseover' : 'click';
          effectType = 'class_toggle';
          ariaDelta = { attribute: 'aria-expanded', to: 'true' };
          break;
        case 'modal':
        case 'drawer':
          triggerEvent = 'click';
          effectType = 'visibility_toggle';
          ariaDelta = { attribute: 'aria-hidden', to: 'false' };
          break;
        case 'carousel':
          triggerEvent = 'click';
          effectType = 'css_scroll_snap';
          break;
        case 'tabs':
          triggerEvent = 'click';
          effectType = 'class_toggle';
          ariaDelta = { attribute: 'aria-selected', to: 'true' };
          break;
        case 'form_validation':
          triggerEvent = 'focus';
          effectType = 'class_toggle';
          break;
      }

      return {
        id: ctrl.id,
        sectionId: ctrl.sectionId,
        widgetType: ctrl.type,
        triggerEvent,
        targetSelector: ctrl.targetSelector,
        triggerSelector: ctrl.triggerSelector,
        stateDelta: {
          property: 'active',
          active: true,
        },
        ariaDelta,
        effectType,
      };
    });
  }

  /**
   * Deprecated: Forwards directly to generateDeclarativeRuntime()
   */
  public generateStorefrontJs(): string {
    return this.generateDeclarativeRuntime();
  }
}
