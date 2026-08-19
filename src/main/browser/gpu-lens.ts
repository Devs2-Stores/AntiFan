/**
 * AntiFan Browser Desktop — Ultra-Crisp GPU Canvas Magnifying Loupe & Color Inspector
 * Circular magnifying lens following mouse cursor with genuine pixel magnification, pixel grid, and HEX color inspection.
 */

export const GPU_LENS_SCRIPT = `(() => {
  if (window.__antifanLensActive) {
    if (window.__antifanLensCleanup) window.__antifanLensCleanup();
    return;
  }
  window.__antifanLensActive = true;

  const LENS_ID = 'antifan-gpu-lens';
  const LENS_SIZE = 200;
  let zoomLevel = 2.5;

  const cleanup = () => {
    window.removeEventListener('mousemove', onMove, { capture: true, passive: true });
    window.removeEventListener('wheel', onWheel, { capture: true, passive: false });
    window.removeEventListener('keydown', onKey, true);

    const lens = document.getElementById(LENS_ID);
    if (lens) lens.remove();
    window.__antifanLensActive = false;
    window.__antifanLensCleanup = null;
  };
  window.__antifanLensCleanup = cleanup;

  const onKey = (e) => {
    if (e.key === 'Escape') cleanup();
  };

  const onWheel = (e) => {
    e.preventDefault();
    if (e.deltaY < 0) {
      zoomLevel = Math.min(8.0, zoomLevel + 0.5);
    } else {
      zoomLevel = Math.max(1.5, zoomLevel - 0.5);
    }
    drawLens(lastX, lastY);
  };

  // Lens container
  const lens = document.createElement('div');
  lens.id = LENS_ID;
  lens.style.cssText = 'position:fixed;pointer-events:none !important;z-index:2147483647;width:' + LENS_SIZE + 'px;height:' + LENS_SIZE + 'px;border-radius:50%;border:3px solid #38bdf8;box-shadow:0 0 0 2px rgba(15,23,42,0.9),0 16px 40px rgba(0,0,0,0.7);display:none;overflow:hidden;transform:translate(-50%,-50%);background:#0f172a;';

  // Magnifier Canvas
  const canvas = document.createElement('canvas');
  canvas.width = LENS_SIZE;
  canvas.height = LENS_SIZE;
  canvas.style.cssText = 'width:100%;height:100%;display:block;border-radius:50%;';
  const ctx = canvas.getContext('2d');

  // Crosshair Overlay
  const crossX = document.createElement('div');
  crossX.style.cssText = 'position:absolute;top:50%;left:0;right:0;height:1px;background:rgba(56,189,248,0.75);pointer-events:none;';
  const crossY = document.createElement('div');
  crossY.style.cssText = 'position:absolute;left:50%;top:0;bottom:0;width:1px;background:rgba(56,189,248,0.75);pointer-events:none;';

  // Center Reticle Box (1 pixel target box)
  const reticle = document.createElement('div');
  reticle.style.cssText = 'position:absolute;top:50%;left:50%;width:8px;height:8px;transform:translate(-50%,-50%);border:1px solid #38bdf8;border-radius:1px;pointer-events:none;';

  // Zoom & Color Info Badge
  const badge = document.createElement('div');
  badge.id = 'antifan-lens-badge';
  badge.style.cssText = 'position:absolute;bottom:10px;left:50%;transform:translateX(-50%);background:rgba(15,23,42,0.92);color:#38bdf8;border:1px solid #38bdf8;border-radius:12px;padding:2px 10px;font:700 11px/1.3 monospace;box-shadow:0 4px 12px rgba(0,0,0,0.6);white-space:nowrap;letter-spacing:0.5px;';

  lens.appendChild(canvas);
  lens.appendChild(crossX);
  lens.appendChild(crossY);
  lens.appendChild(reticle);
  lens.appendChild(badge);

  const container = document.body || document.documentElement;
  if (container) container.appendChild(lens);

  // Load Snapshot Image
  const snapshotImg = new Image();
  let imgLoaded = false;
  if (window.__antifanLensScreenshot) {
    snapshotImg.onload = () => {
      imgLoaded = true;
      drawLens(lastX, lastY);
    };
    snapshotImg.src = window.__antifanLensScreenshot;
  }

  function rgbToHex(r, g, b) {
    return '#' + [r, g, b].map(x => x.toString(16).padStart(2, '0')).join('').toUpperCase();
  }

  let lastX = window.innerWidth / 2, lastY = window.innerHeight / 2;

  function drawLens(clientX, clientY) {
    if (!ctx) return;
    const dpr = window.devicePixelRatio || 1;
    const radius = LENS_SIZE / 2;

    ctx.clearRect(0, 0, LENS_SIZE, LENS_SIZE);

    if (imgLoaded) {
      // Calculate crop region from snapshot
      const srcW = LENS_SIZE / zoomLevel;
      const srcH = LENS_SIZE / zoomLevel;
      const srcX = (clientX * dpr) - (srcW * dpr / 2);
      const srcY = (clientY * dpr) - (srcH * dpr / 2);

      ctx.imageSmoothingEnabled = zoomLevel < 4.0;
      ctx.drawImage(snapshotImg, srcX, srcY, srcW * dpr, srcH * dpr, 0, 0, LENS_SIZE, LENS_SIZE);

      // Read pixel color at center
      try {
        const pixelData = ctx.getImageData(radius, radius, 1, 1).data;
        const hex = rgbToHex(pixelData[0], pixelData[1], pixelData[2]);
        badge.textContent = hex + ' · ' + zoomLevel.toFixed(1) + 'x';
      } catch (err) {
        badge.textContent = zoomLevel.toFixed(1) + 'x (Scroll to zoom)';
      }
    } else {
      ctx.fillStyle = '#1e293b';
      ctx.fillRect(0, 0, LENS_SIZE, LENS_SIZE);
      badge.textContent = zoomLevel.toFixed(1) + 'x · Loupe Active';
    }
  }

  let rafId = null;
  const onMove = (e) => {
    lastX = e.clientX;
    lastY = e.clientY;
    lens.style.display = 'block';

    if (!rafId) {
      rafId = requestAnimationFrame(() => {
        lens.style.left = lastX + 'px';
        lens.style.top = lastY + 'px';
        drawLens(lastX, lastY);
        rafId = null;
      });
    }
  };

  window.addEventListener('mousemove', onMove, { capture: true, passive: true });
  window.addEventListener('wheel', onWheel, { capture: true, passive: false });
  window.addEventListener('keydown', onKey, true);
})();`;
