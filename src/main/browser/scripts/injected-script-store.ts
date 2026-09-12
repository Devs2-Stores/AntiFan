/**
 * AntiFan Browser Desktop - Injected Script Store
 * Centralized registry and dynamic loader for scripts injected into browser tabs via CDP Runtime.evaluate.
 * Supports zero-restart live reload: scripts can be hot-patched in memory or loaded dynamically from disk in dev mode.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

export interface FreezeMediaOptions {
  freeze?: boolean;
  normalizeSliders?: boolean;
}

export type ScriptSourceFn<T> = (params: T) => string;
export type ScriptSource<T> = string | ScriptSourceFn<T>;

export interface InjectedScriptDescriptor {
  id: string;
  description: string;
  source: string | ((params: unknown) => string);
  version: number;
  lastUpdated: number;
}

export class InjectedScriptStore {
  private static instance: InjectedScriptStore | null = null;
  private readonly scripts = new Map<string, InjectedScriptDescriptor>();
  private readonly diskOverrides = new Map<string, { content: string; mtimeMs: number }>();
  private overrideDir: string | null = null;
  private readonly autoResolveOverrideDir: boolean;
  private readonly overrideCandidates: readonly string[] | null = null;

  public static getInstance(): InjectedScriptStore {
    if (!InjectedScriptStore.instance) {
      InjectedScriptStore.instance = new InjectedScriptStore();
    }
    return InjectedScriptStore.instance;
  }

  constructor(options?: { overrideDir?: string | null; overrideCandidates?: string[] | null }) {
    this.registerDefaults();
    if (options && 'overrideCandidates' in options) {
      this.overrideCandidates = Array.isArray(options.overrideCandidates)
        ? Object.freeze([...options.overrideCandidates])
        : null;
    }
    if (options && 'overrideDir' in options) {
      this.overrideDir = options.overrideDir ?? null;
      this.autoResolveOverrideDir = false;
    } else {
      this.autoResolveOverrideDir = true;
      this.resolveOverrideDir();
    }
  }

  private resolveOverrideDir(): void {
    const candidates = this.overrideCandidates ?? ([
      process.env.ANTIFAN_CDP_SCRIPTS_DIR,
      path.join(process.cwd(), 'scripts', 'cdp'),
      path.join(__dirname, '..', '..', '..', '..', 'scripts', 'cdp'),
    ].filter(Boolean) as string[]);
    for (const dir of candidates) {
      try {
        if (fs.existsSync(dir)) {
          this.overrideDir = dir;
          break;
        }
      } catch {}
    }
  }

  /**
   * Register default built-in script generators
   */
  private registerDefaults(): void {
    // 1. Freeze Media Script Generator (Fixed to prevent slider breaking)
    this.register('media.freeze', 'Freeze or unfreeze videos, audios, SVG animations, CSS animations, and RAF loops safely', (params: FreezeMediaOptions = {}) => {
      const freeze = params.freeze !== false;
      const normalizeSliders = Boolean(params.normalizeSliders);
      return `(() => {
        const freeze = ${Boolean(freeze)};
        const normalizeSliders = ${Boolean(normalizeSliders)};
        let mediaCount = 0;
        const freezeStyleId = '__antifan_freeze_media_style';

        const visitRoots = (root, cb) => {
          cb(root);
          root.querySelectorAll('*').forEach(el => {
            if (el.shadowRoot) visitRoots(el.shadowRoot, cb);
            if (el.tagName === 'IFRAME') {
              try {
                if (el.contentDocument) visitRoots(el.contentDocument, cb);
              } catch {}
            }
          });
        };

        visitRoots(document, r => {
          r.querySelectorAll('video, audio').forEach(el => {
            mediaCount++;
            if (freeze && !el.paused) {
              el.dataset.__antifanPaused = 'true';
              el.pause();
            }
          });

          r.querySelectorAll('svg').forEach(s => {
            if (freeze && typeof s.pauseAnimations === 'function' && typeof s.setAttribute === 'function' && typeof s.getAttribute === 'function') {
              const isAlreadyPaused = typeof s.animationsPaused === 'function' ? s.animationsPaused() : false;
              if (!isAlreadyPaused && s.getAttribute('data-antifan-svg-paused') !== 'true') {
                let didPause = false;
                try {
                  s.pauseAnimations();
                  didPause = true;
                  s.setAttribute('data-antifan-svg-paused', 'true');
                } catch {
                  if (didPause && typeof s.unpauseAnimations === 'function') {
                    try { s.unpauseAnimations(); } catch {}
                  }
                }
              }
            }
          });
        });

        const restoreSliderNormalization = () => {
          if (Array.isArray(window.__antifanSliderSnapshots)) {
            window.__antifanSliderSnapshots.forEach(item => {
              try {
                if (item && item.el && item.el.style) {
                  ['transform', 'transition', 'left', 'margin-left', 'width'].forEach(prop => {
                    const snap = item[prop];
                    if (snap && snap.value) {
                      item.el.style.setProperty(prop, snap.value, snap.priority || '');
                    } else {
                      item.el.style.removeProperty(prop);
                    }
                  });
                  if (typeof item.scrollLeft === 'number') item.el.scrollLeft = item.scrollLeft;
                  if (typeof item.scrollTop === 'number') item.el.scrollTop = item.scrollTop;
                }
              } catch {}
            });
            delete window.__antifanSliderSnapshots;
          }
        };

        const performUnfreeze = (clearScheduledTimer = true) => {
          visitRoots(document, r => {
            r.querySelectorAll('video, audio').forEach(el => {
              if (el.dataset.__antifanPaused === 'true') {
                delete el.dataset.__antifanPaused;
                el.play().catch(() => {});
              }
            });
            r.querySelectorAll('svg').forEach(s => {
              if (typeof s.getAttribute === 'function' && s.getAttribute('data-antifan-svg-paused') === 'true') {
                if (typeof s.unpauseAnimations === 'function') {
                  try {
                    s.unpauseAnimations();
                    if (typeof s.removeAttribute === 'function') {
                      s.removeAttribute('data-antifan-svg-paused');
                    }
                  } catch {}
                } else if (typeof s.removeAttribute === 'function') {
                  s.removeAttribute('data-antifan-svg-paused');
                }
              }
            });
          });
          const s = document.getElementById(freezeStyleId);
          if (s) s.remove();

          if (window.__antifanOriginalRAF) {
            window.requestAnimationFrame = window.__antifanOriginalRAF;
            delete window.__antifanOriginalRAF;
            const q = window.__antifanRAFQueue || [];
            delete window.__antifanRAFQueue;
            q.forEach(cb => { try { cb(performance.now()); } catch {} });
          }

          if (clearScheduledTimer && window.__antifanFreezeTimer) {
            clearTimeout(window.__antifanFreezeTimer);
          }
          delete window.__antifanFreezeTimer;
          restoreSliderNormalization();
          delete window.__antifanFreeze;
          delete window.__antifanPaused;
        };

        let styleEl = document.getElementById(freezeStyleId);
        if (freeze) {
          window.__antifanFreeze = true;
          window.__antifanPaused = true;
          restoreSliderNormalization();
          if (!styleEl) {
            styleEl = document.createElement('style');
            styleEl.id = freezeStyleId;
            styleEl.textContent = '*:not([class*="menu"], [class*="menu"] *, [class*="nav"], [class*="nav"] *, [class*="dropdown"], [class*="dropdown"] *, [role="menu"], [role="menu"] *, [role="dialog"], [role="dialog"] *) { animation-play-state: paused !important; transition: none !important; }';
            document.head.appendChild(styleEl);
          }
          if (!window.__antifanOriginalRAF) {
            window.__antifanOriginalRAF = window.requestAnimationFrame;
            window.__antifanRAFQueue = [];
            window.requestAnimationFrame = (cb) => {
              const id = window.__antifanRAFQueue.length + 1;
              window.__antifanRAFQueue.push(cb);
              setTimeout(() => {
                const idx = window.__antifanRAFQueue.indexOf(cb);
                if (idx !== -1) {
                  window.__antifanRAFQueue.splice(idx, 1);
                  try { cb(performance.now()); } catch {}
                }
              }, 16);
              return id;
            };
          }
          if (window.__antifanFreezeTimer) clearTimeout(window.__antifanFreezeTimer);
          window.__antifanFreezeTimer = setTimeout(() => performUnfreeze(false), 60000);

          // Only freeze slider motion destructively IF explicitly requested by normalizeSliders flag
        if (normalizeSliders) {
          window.__antifanSliderSnapshots = [];
          const seenElements = new Set();
          const snapshotElement = (el) => {
            if (!el || seenElements.has(el)) return;
            seenElements.add(el);
            window.__antifanSliderSnapshots.push({
              el,
              scrollLeft: typeof el.scrollLeft === 'number' ? el.scrollLeft : 0,
              scrollTop: typeof el.scrollTop === 'number' ? el.scrollTop : 0,
              transform: { value: el.style.getPropertyValue('transform'), priority: el.style.getPropertyPriority('transform') },
              transition: { value: el.style.getPropertyValue('transition'), priority: el.style.getPropertyPriority('transition') },
              left: { value: el.style.getPropertyValue('left'), priority: el.style.getPropertyPriority('left') },
              'margin-left': { value: el.style.getPropertyValue('margin-left'), priority: el.style.getPropertyPriority('margin-left') },
              width: { value: el.style.getPropertyValue('width'), priority: el.style.getPropertyPriority('width') }
            });
          };
          const isNavOrMenu = (el) => Boolean(el && typeof el.closest === 'function' && (el.closest('.category-menu') || el.closest('.category-navigation') || el.closest('nav') || el.closest('[class*="menu"]') || el.closest('[class*="dropdown"]')));
          const isSlideContent = (el) => Boolean(el && ((el.classList && typeof el.classList.contains === 'function' && el.classList.contains('slide-content')) || (typeof el.className === 'string' && el.className.includes('slide-content'))));
          const rawScrollContainers = Array.from(document.querySelectorAll('.slideshow, .carousel, [class*="slider"], [class*="slideshow"], .slick-slider, .swiper'));
          const scrollContainers = rawScrollContainers.filter(el => !isNavOrMenu(el) && !isSlideContent(el));

          const rawTrackElements = Array.from(document.querySelectorAll('.s-content, .swiper-wrapper, .slick-track, .owl-stage, .flickity-slider, [class*="slide-wrap"] > div, [data-slider-track], .carousel-inner'));
          const trackElements = rawTrackElements.filter(el => !isNavOrMenu(el) && !isSlideContent(el));
          scrollContainers.forEach(snapshotElement);
          trackElements.forEach(snapshotElement);
          scrollContainers.forEach(el => {
            if (typeof el.scrollTo === 'function') {
              el.scrollTo({ left: 0, top: 0, behavior: 'instant' });
            }
          });
          trackElements.forEach(el => {
            try {
              el.style.setProperty('transform', 'matrix(1, 0, 0, 1, 0, 0)', 'important');
              el.style.setProperty('transition', 'none', 'important');
              el.style.setProperty('left', '0px', 'important');
              el.style.setProperty('margin-left', '0px', 'important');
              // Do not force width: track width is managed by slider libraries and parent container
            } catch {}
          });
        }
        } else {
          performUnfreeze();
        }
        return { frozen: freeze, mediaCount };
      })()`;
    });

    // 3. Document font readiness settle script
    this.register('settle.fonts', 'Ensure document fonts are loaded before capture', (params: { timeoutMs?: number } = {}) => {
      const timeoutMs = typeof params?.timeoutMs === 'number' ? params.timeoutMs : 2000;
      return `(() => {
        return new Promise((resolve) => {
          let done = false;
          const timer = setTimeout(() => {
            if (!done) { done = true; resolve(false); }
          }, ${Math.max(1, timeoutMs)});
          if (document.fonts && typeof document.fonts.ready === 'object' && typeof document.fonts.ready.then === 'function') {
            document.fonts.ready.then(() => {
              if (!done) { done = true; clearTimeout(timer); resolve(true); }
            }).catch(() => {
              if (!done) { done = true; clearTimeout(timer); resolve(false); }
            });
          } else {
            if (!done) { done = true; clearTimeout(timer); resolve(true); }
          }
        });
      })()`;
    });

    // 4. In-viewport image decode and broken image detection script
    this.register('settle.images', 'Ensure in-viewport images are decoded before capture', (params: { timeoutMs?: number; clipRect?: { x: number; y: number; width: number; height: number } } = {}) => {
      const timeoutMs = typeof params?.timeoutMs === 'number' ? params.timeoutMs : 3000;
      const clipJson = params?.clipRect ? JSON.stringify(params.clipRect) : 'null';
      return `(() => {
        return new Promise((resolve) => {
          const clip = ${clipJson};
          const vw = window.innerWidth || 1200;
          const vh = window.innerHeight || 800;

          const imgs = Array.from(document.images || []);
          const scrollX = window.scrollX || window.pageXOffset || 0;
          const scrollY = window.scrollY || window.pageYOffset || 0;
          const relevantImages = imgs.filter(img => {
            try {
              const rect = img.getBoundingClientRect();
              if (rect.width === 0 && rect.height === 0) return false;
              const absTop = rect.top + scrollY;
              const absBottom = rect.bottom + scrollY;
              const absLeft = rect.left + scrollX;
              const absRight = rect.right + scrollX;
              if (clip) {
                return (
                  absRight >= clip.x &&
                  absLeft <= clip.x + clip.width &&
                  absBottom >= clip.y &&
                  absTop <= clip.y + clip.height
                );
              }
              return (
                rect.right >= 0 &&
                rect.left <= vw &&
                rect.bottom >= 0 &&
                rect.top <= vh
              );
            } catch {
              return false;
            }
          });
          let finished = false;
          const finish = (settled) => {
            if (finished) return;
            finished = true;
            clearTimeout(timer);
            const broken = [];
            for (const img of relevantImages) {
              try {
                const src = img.currentSrc || img.src;
                if (img.complete && img.naturalWidth === 0 && img.naturalHeight === 0 && src) {
                  broken.push(src);
                }
              } catch {}
            }
            resolve({ settled: Boolean(settled), brokenImages: broken });
          };

          const timer = setTimeout(() => {
            finish(false);
          }, ${Math.max(1, timeoutMs)});
          for (const img of relevantImages) {
            try {
              if (img.loading === 'lazy') {
                img.loading = 'eager';
              }
            } catch {}
          }

          const decodePromises = [];
          for (const img of relevantImages.slice(0, 50)) {
            if (typeof img.decode === 'function' && !img.complete) {
              decodePromises.push(img.decode());
            }
          }
          if (decodePromises.length === 0) {
            finish(true);
          } else {
            Promise.all(decodePromises).then(() => finish(true)).catch(() => finish(false));
          }
        });
      })()`;
    });
  }

  /**
   * Register or replace a script generator
   */
  public register<T = unknown>(id: string, description: string, source: ScriptSource<T>): void {
    const existing = this.scripts.get(id);
    const version = existing ? existing.version + 1 : 1;
    this.scripts.set(id, {
      id,
      description,
      source: typeof source === 'function' ? (p: unknown) => source(p as T) : source,
      version,
      lastUpdated: Date.now(),
    });
  }

  /**
   * Get script source code, resolving disk overrides if available in dev mode
   */
  public getScript(id: string, params?: unknown): string {
    // Check disk override first if directory configured
    if (!this.overrideDir && this.autoResolveOverrideDir) {
      this.resolveOverrideDir();
    }
    if (this.overrideDir) {
      const fileName = `${id.replace(/\./g, '-')}.source.js`;
      const filePath = path.join(this.overrideDir, fileName);
      try {
        if (fs.existsSync(filePath)) {
          const stat = fs.statSync(filePath);
          const cached = this.diskOverrides.get(id);
          let raw = cached?.content;
          if (!cached || cached.mtimeMs < stat.mtimeMs) {
            raw = fs.readFileSync(filePath, 'utf8');
            this.diskOverrides.set(id, { content: raw, mtimeMs: stat.mtimeMs });
          }
          if (raw) {
            const PARAM_TOKEN = '__ANTIFAN_PARAMS_JSON__';
            if (raw.includes(PARAM_TOKEN)) {
              const occurrences = raw.split(PARAM_TOKEN).length - 1;
              if (occurrences > 1) {
                throw new Error(`Invalid override template for '${id}': duplicate ${PARAM_TOKEN} token found`);
              }
              const safeJson = JSON.stringify(params ?? {});
              return raw.replace(PARAM_TOKEN, () => safeJson);
            }
            if (params !== undefined && params !== null && typeof params === 'object' && Object.keys(params).length > 0) {
              throw new Error(`Override template for '${id}' does not support parameterization (missing ${PARAM_TOKEN})`);
            }
            return raw;
          }
        }
      } catch (err: unknown) {
        if (err instanceof Error && err.message.includes('Override template')) {
          throw err;
        }
        throw new Error(`Failed to load disk override for '${id}': ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    const entry = this.scripts.get(id);
    if (!entry) {
      throw new Error(`Injected script '${id}' not found in InjectedScriptStore.`);
    }

    if (typeof entry.source === 'function') {
      return entry.source(params);
    }
    return entry.source;
  }

  /**
   * Hot-patch a script in memory
   */
  public setOverride<T = unknown>(id: string, customSource: ScriptSource<T>): number {
    const existing = this.scripts.get(id);
    const version = (existing?.version || 0) + 1;
    this.scripts.set(id, {
      id,
      description: existing?.description || `Hot-patched script ${id}`,
      source: typeof customSource === 'function' ? (p: unknown) => customSource(p as T) : customSource,
      version,
      lastUpdated: Date.now(),
    });
    return version;
  }

  /**
   * Clear in-memory or disk overrides
   */
  public clearOverrides(id?: string): void {
    if (!this.overrideDir && this.autoResolveOverrideDir) {
      this.resolveOverrideDir();
    }
    if (id) {
      this.diskOverrides.delete(id);
    } else {
      this.diskOverrides.clear();
    }
  }

  /**
   * List all registered scripts and their versions
   */
  public listScripts(): Array<{ id: string; description: string; version: number; lastUpdated: number; hasDiskOverride: boolean }> {
    return Array.from(this.scripts.values()).map(s => ({
      id: s.id,
      description: s.description,
      version: s.version,
      lastUpdated: s.lastUpdated,
      hasDiskOverride: this.diskOverrides.has(s.id),
    }));
  }
}

export const injectedScriptStore = InjectedScriptStore.getInstance();
