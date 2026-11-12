// Electron 43.8.8 ignores a canvas font shorthand that starts with whitespace and keeps
// "10px sans-serif". The xterm WebGL glyph atlas always sets one (" normal 12px <family>"),
// so every terminal glyph was drawn in a 10px sans inside Cascadia-sized cells. Trim the
// value, and only on a runtime that shows the bug. Loaded as a classic script before xterm.
(function trimCanvasFontShorthand() {
  const proto = window.CanvasRenderingContext2D && CanvasRenderingContext2D.prototype;
  const desc = proto && Object.getOwnPropertyDescriptor(proto, 'font');
  if (!desc || typeof desc.get !== 'function' || typeof desc.set !== 'function') return;
  const probe = document.createElement('canvas').getContext('2d');
  if (!probe) return;
  desc.set.call(probe, ' 12px monospace');
  if (desc.get.call(probe) !== '10px sans-serif') return;
  Object.defineProperty(proto, 'font', {
    configurable: desc.configurable,
    enumerable: desc.enumerable,
    get: desc.get,
    set(value) { desc.set.call(this, typeof value === 'string' ? value.trim() : value); },
  });
})();
