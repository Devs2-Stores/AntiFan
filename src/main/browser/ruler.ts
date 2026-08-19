/**
 * AntiFan Browser Desktop — Pixel Ruler & Layout Grid Overlay
 * 100% Parity with Antigravity Browser Pixel Ruler & 8px/64px Layout Grid Overlay.
 */

export const RULER_SCRIPT = `(() => {
  if (window.__antifanRulerActive) return;
  window.__antifanRulerActive = true;

  const RULER_GRID_ID = '__antifan_ruler_grid';
  const RULER_TOP_BAR_ID = '__antifan_ruler_top_bar';
  const RULER_LEFT_BAR_ID = '__antifan_ruler_left_bar';
  const RULER_CORNER_ID = '__antifan_ruler_corner';

  const rulerGrid = document.createElement('div');
  rulerGrid.id = RULER_GRID_ID;
  rulerGrid.style.cssText = 'position:fixed !important;top:0 !important;left:0 !important;right:0 !important;bottom:0 !important;pointer-events:none !important;z-index:2147483645 !important;box-sizing:border-box !important;background-image:linear-gradient(to right,rgba(55,148,255,0.08) 1px,transparent 1px),linear-gradient(to bottom,rgba(55,148,255,0.08) 1px,transparent 1px),linear-gradient(to right,rgba(55,148,255,0.22) 1px,transparent 1px),linear-gradient(to bottom,rgba(55,148,255,0.22) 1px,transparent 1px);background-size:8px 8px,8px 8px,64px 64px,64px 64px;background-position:0 0;';

  const rulerTopBar = document.createElement('div');
  rulerTopBar.id = RULER_TOP_BAR_ID;
  rulerTopBar.style.cssText = 'position:fixed !important;top:0 !important;left:0 !important;right:0 !important;height:20px !important;background:rgba(18,18,22,0.92) !important;border-bottom:1px solid rgba(55,148,255,0.5) !important;z-index:2147483646 !important;pointer-events:none !important;overflow:hidden !important;box-shadow:0 2px 8px rgba(0,0,0,0.5) !important;';

  const rulerLeftBar = document.createElement('div');
  rulerLeftBar.id = RULER_LEFT_BAR_ID;
  rulerLeftBar.style.cssText = 'position:fixed !important;top:20px !important;left:0 !important;bottom:0 !important;width:20px !important;background:rgba(18,18,22,0.92) !important;border-right:1px solid rgba(55,148,255,0.5) !important;z-index:2147483646 !important;pointer-events:none !important;overflow:hidden !important;box-shadow:2px 0 8px rgba(0,0,0,0.5) !important;';

  const rulerCorner = document.createElement('div');
  rulerCorner.id = RULER_CORNER_ID;
  rulerCorner.style.cssText = 'position:fixed !important;top:0 !important;left:0 !important;width:20px !important;height:20px !important;background:#087ff5 !important;color:#fff !important;font-family:monospace !important;font-size:9px !important;font-weight:700 !important;display:flex !important;align-items:center !important;justify-content:center !important;z-index:2147483647 !important;pointer-events:none !important;border-right:1px solid rgba(55,148,255,0.5) !important;border-bottom:1px solid rgba(55,148,255,0.5) !important;';
  rulerCorner.textContent = 'px';

  function renderRulerScales() {
    const w = window.innerWidth;
    const h = window.innerHeight;
    let topHtml = '';
    for (let x = 0; x < w; x += 10) {
      const isMajor = x % 100 === 0;
      const isMid = x % 50 === 0;
      const tickH = isMajor ? 12 : (isMid ? 7 : 4);
      const bg = isMajor ? '#38bdf8' : 'rgba(255,255,255,0.3)';
      topHtml += '<div style="position:absolute;left:' + x + 'px;bottom:0;width:1px;height:' + tickH + 'px;background:' + bg + ';"></div>';
      if (isMajor && x > 0) {
        topHtml += '<span style="position:absolute;left:' + (x + 2) + 'px;top:1px;font-family:monospace;font-size:8.5px;color:#38bdf8;line-height:1;">' + x + '</span>';
      }
    }
    rulerTopBar.innerHTML = topHtml;

    let leftHtml = '';
    for (let y = 0; y < h; y += 10) {
      const isMajor = y % 100 === 0;
      const isMid = y % 50 === 0;
      const tickW = isMajor ? 12 : (isMid ? 7 : 4);
      const bg = isMajor ? '#38bdf8' : 'rgba(255,255,255,0.3)';
      leftHtml += '<div style="position:absolute;top:' + y + 'px;right:0;height:1px;width:' + tickW + 'px;background:' + bg + ';"></div>';
      if (isMajor && y > 0) {
        leftHtml += '<span style="position:absolute;top:' + (y + 2) + 'px;left:1px;font-family:monospace;font-size:8px;color:#38bdf8;line-height:1;transform:rotate(-90deg);transform-origin:left top;">' + y + '</span>';
      }
    }
    rulerLeftBar.innerHTML = leftHtml;
  }

  rulerGrid.appendChild(rulerTopBar);
  rulerGrid.appendChild(rulerLeftBar);
  rulerGrid.appendChild(rulerCorner);
  document.documentElement.appendChild(rulerGrid);
  renderRulerScales();

  window.addEventListener('resize', renderRulerScales);

  window.__antifanRulerCleanup = () => {
    window.removeEventListener('resize', renderRulerScales);
    rulerGrid.remove();
    window.__antifanRulerActive = false;
  };
})();`;
