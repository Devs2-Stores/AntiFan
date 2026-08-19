const fs = require('fs');
const path = require('path');

const file = 'e:/Work/apps/antigravity-browser/src/inspectorScript.js';
let code = fs.readFileSync(file, 'utf8');

// 1. Declare state variables
if (!code.includes('var isMagnifierActive = false;')) {
  code = code.replace(
    'var isInspectActive = false;\n  var isFontFinderActive = false;',
    'var isInspectActive = false;\n  var isFontFinderActive = false;\n  var isMagnifierActive = false;\n  var magnifierScale = 3;\n  var magnifierLensEl = null;'
  );
}

// 2. Add setMagnifierState & updateMagnifierPosition before setFontFinderState
const setMagnifierCode = `  function setMagnifierState(active) {
    isMagnifierActive = Boolean(active);
    if (isMagnifierActive) {
      if (isInspectActive) setInspectState(false);
      if (isFontFinderActive) setFontFinderState(false);
    }

    if (magnifierLensEl) {
      try { magnifierLensEl.remove(); } catch(e) {}
      magnifierLensEl = null;
    }

    if (!isMagnifierActive) return;

    var L = 240;
    var L2 = L / 2;
    var lens = document.createElement('div');
    lens.id = 'agb-magnif-lens';
    Object.assign(lens.style, {
      position: 'fixed', left: '-500px', top: '-500px', width: L + 'px', height: L + 'px',
      zIndex: '2147483647', borderRadius: '50%',
      backgroundRepeat: 'no-repeat', backgroundPosition: '0 0',
      boxShadow: '0 16px 40px rgba(0,0,0,.65), 0 0 0 2.5px rgba(255,255,255,.95), inset 0 0 0 1.5px rgba(255,255,255,.4), inset 0 0 20px rgba(0,0,0,.25)',
      border: 'none', opacity: '0', transition: 'opacity 0.15s ease',
      willChange: 'left, top, background-position',
      transform: 'translateZ(0)', boxSizing: 'border-box', pointerEvents: 'none'
    });

    var reticle = document.createElement('div');
    Object.assign(reticle.style, {
      position: 'absolute', left: '50%', top: '50%', width: '10px', height: '10px',
      transform: 'translate(-50%, -50%)', borderRadius: '50%',
      border: '1.5px solid rgba(255,255,255,0.9)', boxShadow: '0 0 3px rgba(0,0,0,0.85)',
      pointerEvents: 'none'
    });
    lens.appendChild(reticle);

    var scaleBadge = document.createElement('div');
    Object.assign(scaleBadge.style, {
      position: 'absolute', bottom: '12px', left: '50%', transform: 'translateX(-50%)',
      background: 'rgba(0,0,0,0.75)', color: '#ffffff', padding: '2px 8px', borderRadius: '10px',
      fontSize: '11px', fontWeight: 'bold', fontFamily: 'sans-serif', pointerEvents: 'none'
    });
    scaleBadge.textContent = magnifierScale.toFixed(1) + 'x';
    lens.appendChild(scaleBadge);

    (document.body || document.documentElement).appendChild(lens);
    magnifierLensEl = lens;

    if (window.snapdom && typeof window.snapdom.toDataURL === 'function') {
      window.snapdom.toDataURL(document.body || document.documentElement).then(function(dataUrl) {
        lens.style.backgroundImage = 'url(' + dataUrl + ')';
        lens.style.opacity = '1';
      }).catch(function() {
        lens.style.opacity = '1';
      });
    } else {
      lens.style.opacity = '1';
    }
  }

  function updateMagnifierPosition(e) {
    if (!isMagnifierActive || !magnifierLensEl) return;
    var L2 = 120;
    var px = e.clientX;
    var py = e.clientY;
    magnifierLensEl.style.left = (px - L2) + 'px';
    magnifierLensEl.style.top = (py - L2) + 'px';
    var w = window.innerWidth;
    var h = window.innerHeight;
    magnifierLensEl.style.backgroundSize = (w * magnifierScale) + 'px ' + (h * magnifierScale) + 'px';
    var bgX = -(px * magnifierScale - L2);
    var bgY = -(py * magnifierScale - L2);
    magnifierLensEl.style.backgroundPosition = bgX + 'px ' + bgY + 'px';
  }

  window.addEventListener('mousemove', updateMagnifierPosition, { passive: true });

`;

if (!code.includes('function setMagnifierState(')) {
  code = code.replace('function setFontFinderState(active) {', setMagnifierCode + 'function setFontFinderState(active) {');
}

// 3. Add Escape key handler
if (!code.includes('setMagnifierState(false);')) {
  code = code.replace(
    'if (isFontFinderActive) {\n        setFontFinderState(false);\n      }',
    'if (isFontFinderActive) {\n        setFontFinderState(false);\n      }\n      if (isMagnifierActive) {\n        setMagnifierState(false);\n      }'
  );
}

// 4. Add wheel event handler
if (!code.includes('if (isMagnifierActive) {\n      e.preventDefault();\n      var step = (e.deltaY || 0) < 0 ? 0.25 : -0.25;')) {
  code = code.replace(
    "window.addEventListener('wheel', function(e) {",
    "window.addEventListener('wheel', function(e) {\n    if (isMagnifierActive) {\n      e.preventDefault();\n      var step = (e.deltaY || 0) < 0 ? 0.25 : -0.25;\n      magnifierScale = Math.min(10.0, Math.max(1.5, Math.round((magnifierScale + step) * 10) / 10));\n      var badge = magnifierLensEl ? magnifierLensEl.querySelector('div') : null;\n      if (badge) badge.textContent = magnifierScale.toFixed(1) + 'x';\n    }"
  );
}

// 5. Add message handler
if (!code.includes('ANTIGRAVITY_MAGNIFIER_TOGGLE')) {
  code = code.replace(
    "setFontFinderState(typeof event.data.active !== 'undefined' ? Boolean(event.data.active) : !isFontFinderActive);\n    }",
    "setFontFinderState(typeof event.data.active !== 'undefined' ? Boolean(event.data.active) : !isFontFinderActive);\n    } else if (event.data && (event.data.type === 'ANTIGRAVITY_MAGNIFIER_TOGGLE' || event.data.type === 'ANTIGRAVITY_TOGGLE_MAGNIFIER')) {\n      setMagnifierState(typeof event.data.active !== 'undefined' ? Boolean(event.data.active) : !isMagnifierActive);\n    }"
  );
}

fs.writeFileSync(file, code, 'utf8');
console.log('SUCCESS: inspectorScript.js updated');
