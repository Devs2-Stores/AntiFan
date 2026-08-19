/**
 * AntiFan Browser Desktop — Ultra-Crisp GPU Canvas Magnifying Loupe & Color Inspector
 * Circular magnifying lens following mouse cursor with genuine pixel magnification,
 * DPI-aware aspect ratio preservation, pixel grid, and real-time HEX color inspection.
 */

export const GPU_LENS_SCRIPT = `(() => {
  if (window.__antifanLensActive) {
    if (window.__antifanLensCleanup) window.__antifanLensCleanup();
    return;
  }
  window.__antifanLensActive = true;

  const LENS_ID = 'antifan-gpu-lens';
  const LENS_SIZE = 220;
  let zoomLevel = 2.5;

  const cleanup = () => {
    window.removeEventListener('mousemove', onMove, { capture: true, passive: true });
    window.removeEventListener('wheel', onWheel, { capture: true, passive: false });
    window.removeEventListener('keydown', onKey, true);

    const lens = document.getElementById(LENS_ID);
    if (lens) lens.remove();
    window.__antifanLensActive = false;
    window.__antifanLensCleanup = null;
    window.__antifanLensUpdateSnapshot = null;
  };
  window.__antifanLensCleanup = cleanup;

  const onKey = (e) => {
    if (e.key === 'Escape') cleanup();
  };

  const onWheel = (e) => {
    e.preventDefault();
    if (e.deltaY < 0) {
      zoomLevel = Math.min(10.0, Math.round((zoomLevel + 0.5) * 10) / 10);
    } else {
      zoomLevel = Math.max(1.5, Math.round((zoomLevel - 0.5) * 10) / 10);
    }
    drawLens(lastX, lastY);
  };

  // Lens container element
  const lens = document.createElement('div');
  lens.id = LENS_ID;
  lens.style.cssText = [
    'position: fixed',
    'pointer-events: none !important',
    'z-index: 2147483647',
    'width: ' + LENS_SIZE + 'px',
    'height: ' + LENS_SIZE + 'px',
    'border-radius: 50%',
    'border: 3px solid #38bdf8',
    'box-shadow: 0 0 0 2px rgba(15, 23, 42, 0.9), 0 20px 48px rgba(0, 0, 0, 0.75)',
    'display: none',
    'overflow: hidden',
    'transform: translate(-50%, -50%)',
    'background: #0f172a',
  ].join(';');

  // High-DPI Magnifier Canvas
  const canvas = document.createElement('canvas');
  const dpr = window.devicePixelRatio || 1;
  canvas.width = Math.round(LENS_SIZE * dpr);
  canvas.height = Math.round(LENS_SIZE * dpr);
  canvas.style.cssText = 'width: 100%; height: 100%; display: block; border-radius: 50%;';
  const ctx = canvas.getContext('2d', { willReadFrequently: true });

  // Crosshair Overlay (Horizontal & Vertical 1px lines)
  const crossX = document.createElement('div');
  crossX.style.cssText = 'position: absolute; top: 50%; left: 0; right: 0; height: 1px; background: rgba(56, 189, 248, 0.7); pointer-events: none;';
  const crossY = document.createElement('div');
  crossY.style.cssText = 'position: absolute; left: 50%; top: 0; bottom: 0; width: 1px; background: rgba(56, 189, 248, 0.7); pointer-events: none;';

  // Center Reticle Box (Target aperture)
  const reticle = document.createElement('div');
  reticle.style.cssText = 'position: absolute; top: 50%; left: 50%; width: 10px; height: 10px; transform: translate(-50%, -50%); border: 1.5px solid #38bdf8; border-radius: 2px; box-shadow: 0 0 4px rgba(0,0,0,0.8); pointer-events: none;';

  // Zoom & Color Info Badge
  const badge = document.createElement('div');
  badge.id = 'antifan-lens-badge';
  badge.style.cssText = [
    'position: absolute',
    'bottom: 12px',
    'left: 50%',
    'transform: translateX(-50%)',
    'background: rgba(15, 23, 42, 0.95)',
    'color: #38bdf8',
    'border: 1px solid rgba(56, 189, 248, 0.6)',
    'border-radius: 12px',
    'padding: 3px 12px',
    'font: 700 11px/1.2 monospace',
    'box-shadow: 0 4px 14px rgba(0, 0, 0, 0.7)',
    'white-space: nowrap',
    'letter-spacing: 0.5px',
    'pointer-events: none',
  ].join(';');

  lens.appendChild(canvas);
  lens.appendChild(crossX);
  lens.appendChild(crossY);
  lens.appendChild(reticle);
  lens.appendChild(badge);

  const container = document.body || document.documentElement;
  if (container) container.appendChild(lens);

  // Snapshot Image Loader with Scale Resolution
  const snapshotImg = new Image();
  let imgLoaded = false;

  function loadSnapshot(dataUrl) {
    if (!dataUrl) return;
    snapshotImg.onload = () => {
      imgLoaded = true;
      drawLens(lastX, lastY);
    };
    snapshotImg.src = dataUrl;
  }

  window.__antifanLensUpdateSnapshot = (dataUrl) => {
    loadSnapshot(dataUrl);
  };

  if (window.__antifanLensScreenshot) {
    loadSnapshot(window.__antifanLensScreenshot);
  }

  function rgbToHex(r, g, b) {
    return '#' + [r, g, b].map((x) => x.toString(16).padStart(2, '0')).join('').toUpperCase();
  }

  let lastX = window.innerWidth / 2;
  let lastY = window.innerHeight / 2;

  function drawLens(clientX, clientY) {
    if (!ctx) return;
    const currentDpr = window.devicePixelRatio || 1;
    const canvasW = canvas.width;
    const canvasH = canvas.height;
    const centerCanvasX = canvasW / 2;
    const centerCanvasY = canvasH / 2;

    ctx.save();
    ctx.clearRect(0, 0, canvasW, canvasH);

    // Circular clip mask for clean anti-aliased lens border
    ctx.beginPath();
    ctx.arc(centerCanvasX, centerCanvasY, centerCanvasX - 2, 0, Math.PI * 2);
    ctx.clip();

    // Dark background fill
    ctx.fillStyle = '#0b1120';
    ctx.fillRect(0, 0, canvasW, canvasH);

    if (imgLoaded && snapshotImg.naturalWidth > 0 && snapshotImg.naturalHeight > 0) {
      // Calculate true scaling ratio between snapshot bitmap and CSS viewport
      const scaleX = snapshotImg.naturalWidth / window.innerWidth;
      const scaleY = snapshotImg.naturalHeight / window.innerHeight;

      const imgCenterX = clientX * scaleX;
      const imgCenterY = clientY * scaleY;

      // Crop size in source image pixels
      const cropW = (LENS_SIZE * scaleX) / zoomLevel;
      const cropH = (LENS_SIZE * scaleY) / zoomLevel;
      const cropX = imgCenterX - cropW / 2;
      const cropY = imgCenterY - cropH / 2;

      // Enable crisp pixelated scaling for 3.5x+ zoom
      ctx.imageSmoothingEnabled = zoomLevel < 3.5;
      if (!ctx.imageSmoothingEnabled) {
        ctx.imageSmoothingQuality = 'low';
      }

      ctx.drawImage(snapshotImg, cropX, cropY, cropW, cropH, 0, 0, canvasW, canvasH);

      // Pixel Grid lines when zooming into individual pixels (>= 4x)
      if (zoomLevel >= 4.0) {
        const pixelStep = (canvasW / cropW);
        if (pixelStep >= 8) {
          ctx.strokeStyle = 'rgba(255, 255, 255, 0.08)';
          ctx.lineWidth = 1;
          const startOffsetX = (centerCanvasX % pixelStep);
          const startOffsetY = (centerCanvasY % pixelStep);

          ctx.beginPath();
          for (let x = startOffsetX; x < canvasW; x += pixelStep) {
            ctx.moveTo(Math.floor(x) + 0.5, 0);
            ctx.lineTo(Math.floor(x) + 0.5, canvasH);
          }
          for (let y = startOffsetY; y < canvasH; y += pixelStep) {
            ctx.moveTo(0, Math.floor(y) + 0.5);
            ctx.lineTo(canvasW, Math.floor(y) + 0.5);
          }
          ctx.stroke();
        }
      }

      // Sample color under center aperture
      try {
        const pixel = ctx.getImageData(Math.floor(centerCanvasX), Math.floor(centerCanvasY), 1, 1).data;
        const hex = rgbToHex(pixel[0], pixel[1], pixel[2]);
        badge.textContent = hex + ' · ' + zoomLevel.toFixed(1) + 'x';
      } catch {
        badge.textContent = zoomLevel.toFixed(1) + 'x (Scroll to zoom)';
      }
    } else {
      ctx.fillStyle = '#1e293b';
      ctx.fillRect(0, 0, canvasW, canvasH);
      badge.textContent = zoomLevel.toFixed(1) + 'x · Loupe Active';
    }

    ctx.restore();
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
