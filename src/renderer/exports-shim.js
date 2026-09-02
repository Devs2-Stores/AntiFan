/**
 * AntiFan Browser Desktop — Renderer CommonJS Global Shim
 * Provides exports/module/global bindings for compiled TypeScript renderer scripts.
 */
var global = typeof globalThis !== 'undefined' ? globalThis : window;
var exports = typeof exports !== 'undefined' ? exports : {};
var module = typeof module !== 'undefined' ? module : { exports: exports };
if (typeof window !== 'undefined') {
  window.exports = exports;
  window.module = module;
  window.global = global;
}
