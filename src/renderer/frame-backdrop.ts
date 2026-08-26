/**
 * AntiFan Browser Desktop — Frame Backdrop Renderer Script
 * Dynamically positions realistic device chassis, screen bezels, and badges around WebContentsViews.
 */

interface FrameUpdatePayload {
  splitMode: boolean;
  focusedPane: 'desktop' | 'mobile';
  url?: string;
  agentWorking?: boolean;
  desktopFrame?: {
    frameX: number;
    frameY: number;
    frameWidth: number;
    frameHeight: number;
    screenX: number;
    screenY: number;
    screenWidth: number;
    screenHeight: number;
    bezelTop: number;
    bezelSide: number;
    bezelBottom: number;
    baseHeight?: number;
    baseSide?: number;
    deviceType: string;
    deviceName: string;
    presetId: string;
    scale: number;
    badgeX: number;
    badgeY: number;
    cornerRadius?: number;
  };
  mobileFrame?: {
    frameX: number;
    frameY: number;
    frameWidth: number;
    frameHeight: number;
    screenX: number;
    screenY: number;
    screenWidth: number;
    screenHeight: number;
    bezelTop: number;
    bezelSide: number;
    bezelBottom: number;
    deviceType: string;
    deviceName: string;
    presetId: string;
    scale: number;
    badgeX: number;
    badgeY: number;
    cornerRadius?: number;
  };
  containerWidth: number;
  containerHeight: number;
}

function cleanDeviceName(name?: string): string {
  if (!name) return '';
  return name.replace(/^[\p{Emoji}\p{Extended_Pictographic}\s]+/u, '').trim();
}

function extractDomain(rawUrl?: string): string {
  if (!rawUrl || rawUrl === 'about:blank') return 'apshop.vn';
  try {
    const parsed = new URL(rawUrl);
    return parsed.hostname || rawUrl;
  } catch {
    return rawUrl.replace(/^https?:\/\//i, '').split('/')[0] || 'apshop.vn';
  }
}

function getDeviceIcon(categoryOrType?: string, fallback = '💻'): string {
  if (!categoryOrType) return fallback;
  const c = categoryOrType.toLowerCase();
  if (c.includes('tablet') || c.includes('ipad')) return '📟';
  if (c.includes('mobile') || c.includes('phone') || c.includes('iphone') || c.includes('pixel') || c.includes('samsung')) return '📱';
  if (c.includes('desktop') || c.includes('laptop') || c.includes('macbook')) return '💻';
  return fallback;
}

function initFrameBackdrop() {
  const laptopMockup = document.getElementById('laptopMockup');
  const laptopBadge = document.getElementById('laptopBadge');
  const laptopBadgeIcon = document.getElementById('laptopBadgeIcon');
  const laptopBadgeTitle = document.getElementById('laptopBadgeTitle');
  const laptopBadgeRes = document.getElementById('laptopBadgeRes');
  const laptopBadgeScale = document.getElementById('laptopBadgeScale');
  const laptopLid = document.getElementById('laptopLid');
  const laptopBase = document.getElementById('laptopBase');
  const laptopAmbientShadow = document.getElementById('laptopAmbientShadow');

  const phoneMockup = document.getElementById('phoneMockup');
  const phoneBadge = document.getElementById('phoneBadge');
  const phoneBadgeIcon = document.getElementById('phoneBadgeIcon');
  const phoneBadgeTitle = document.getElementById('phoneBadgeTitle');
  const phoneBadgeRes = document.getElementById('phoneBadgeRes');
  const phoneBadgeScale = document.getElementById('phoneBadgeScale');
  const phoneBody = document.getElementById('phoneBody');
  const phoneAmbientShadow = document.getElementById('phoneAmbientShadow');
  const safariStatusTime = document.getElementById('safariStatusTime');
  const safariUrlDomain = document.getElementById('safariUrlDomain');
  const phoneTopBezel = document.getElementById('phoneTopBezel');
  const phoneBottomBezel = document.getElementById('phoneBottomBezel');

  // Live iOS status bar clock (real-time from local system clock)
  function updateClock() {
    if (safariStatusTime) {
      const now = new Date();
      const hh = String(now.getHours()).padStart(2, '0');
      const mm = String(now.getMinutes()).padStart(2, '0');
      safariStatusTime.textContent = `${hh}:${mm}`;
    }
  }
  setInterval(updateClock, 1000);
  updateClock();

  // Real-time battery indicator if available in Chromium
  async function updateBattery() {
    const batteryLevelEl = document.getElementById('safariBatteryLevel');
    if (!batteryLevelEl) return;
    try {
      if ('getBattery' in navigator && typeof (navigator as any).getBattery === 'function') {
        const battery = await (navigator as any).getBattery();
        const level = Math.round(battery.level * 100);
        batteryLevelEl.textContent = String(level);
        battery.addEventListener('levelchange', () => {
          batteryLevelEl.textContent = String(Math.round(battery.level * 100));
        });
      }
    } catch {}
  }
  updateBattery();
  const glowLeft = document.getElementById('glowLeft');
  const glowRight = document.getElementById('glowRight');
  // Handle click to focus pane
  if (laptopBadge) {
    laptopBadge.addEventListener('click', (e) => {
      e.stopPropagation();
      window.antifanFrameBackdropApi?.focusPane('desktop');
    });
  }
  if (laptopMockup) {
    laptopMockup.addEventListener('click', (e) => {
      // If clicked on frame borders
      if (e.target === laptopMockup || e.target === laptopBase || e.target === laptopLid) {
        window.antifanFrameBackdropApi?.focusPane('desktop');
      }
    });
  }

  if (phoneBadge) {
    phoneBadge.addEventListener('click', (e) => {
      e.stopPropagation();
      window.antifanFrameBackdropApi?.focusPane('mobile');
    });
  }
  if (phoneMockup) {
    phoneMockup.addEventListener('click', (e) => {
      if (e.target === phoneMockup || e.target === phoneBody) {
        window.antifanFrameBackdropApi?.focusPane('mobile');
      }
    });
  }
  if (phoneTopBezel) {
    phoneTopBezel.addEventListener('click', (e) => {
      window.antifanFrameBackdropApi?.focusPane('mobile');
    });
  }
  if (phoneBottomBezel) {
    phoneBottomBezel.addEventListener('click', (e) => {
      window.antifanFrameBackdropApi?.focusPane('mobile');
    });
  }

  let agentWorkingWatchdogTimer: number | null = null;
  function resetAgentWorkingVisuals() {
    document.body.classList.remove('agent-working');
    if (laptopMockup) laptopMockup.classList.remove('agent-working');
    if (phoneMockup) phoneMockup.classList.remove('agent-working');
    if (glowLeft) glowLeft.classList.remove('agent-working');
    if (glowRight) glowRight.classList.remove('agent-working');
  }

  function applyLayout(payload: FrameUpdatePayload) {
    const isAgentActive = Boolean(payload.agentWorking);
    if (agentWorkingWatchdogTimer !== null) {
      window.clearTimeout(agentWorkingWatchdogTimer);
      agentWorkingWatchdogTimer = null;
    }
    if (isAgentActive) {
      document.body.classList.add('agent-working');
      agentWorkingWatchdogTimer = window.setTimeout(() => {
        resetAgentWorkingVisuals();
      }, 7000);
    } else {
      resetAgentWorkingVisuals();
    }
    if (!payload.splitMode) {
      if (laptopMockup) {
        laptopMockup.style.display = 'none';
        laptopMockup.classList.remove('agent-working');
      }
      if (phoneMockup) {
        phoneMockup.style.display = 'none';
        phoneMockup.classList.remove('agent-working');
      }
      if (glowLeft) {
        glowLeft.style.display = 'none';
        glowLeft.classList.remove('agent-working');
      }
      if (glowRight) {
        glowRight.style.display = 'none';
        glowRight.classList.remove('agent-working');
      }
      return;
    }

    const isDesktopFocused = payload.focusedPane === 'desktop';
    if (glowLeft) glowLeft.classList.toggle('agent-working', isAgentActive);
    if (glowRight) glowRight.classList.toggle('agent-working', isAgentActive);
    if (payload.desktopFrame && laptopMockup) {
      const df = payload.desktopFrame;
      laptopMockup.style.display = 'block';
      laptopMockup.classList.toggle('is-focused', isDesktopFocused);
      laptopMockup.classList.toggle('agent-working', isAgentActive);
      if (laptopBadge) {
        laptopBadge.classList.toggle('active-pane', isDesktopFocused);
        laptopBadge.style.left = `${df.badgeX}px`;
        laptopBadge.style.top = `${df.badgeY}px`;
      }
      if (laptopBadgeIcon) laptopBadgeIcon.textContent = getDeviceIcon(df.deviceType || df.presetId, '💻');
      if (laptopBadgeTitle) laptopBadgeTitle.textContent = cleanDeviceName(df.deviceName) || 'Laptop';
      if (laptopBadgeRes) laptopBadgeRes.textContent = `${Math.round(df.screenWidth / df.scale)}×${Math.round(df.screenHeight / df.scale)}`;
      if (laptopBadgeScale) laptopBadgeScale.textContent = `${Math.round(df.scale * 100)}%`;

      // Laptop Lid (Screen Bezel)
      const baseSide = df.baseSide || 16;
      const lidWidth = df.screenWidth + 2 * df.bezelSide;
      const lidHeight = df.screenHeight + df.bezelTop + df.bezelBottom;
      const lidX = df.frameX + baseSide;
      const lidY = df.frameY;

      if (laptopLid) {
        laptopLid.style.left = `${lidX}px`;
        laptopLid.style.top = `${lidY}px`;
        laptopLid.style.width = `${lidWidth}px`;
        laptopLid.style.height = `${lidHeight}px`;
        const topBezel = laptopLid.querySelector('.laptop-top-bezel') as HTMLElement | null;
        if (topBezel && typeof df.bezelTop === 'number') topBezel.style.height = `${df.bezelTop}px`;
        const bottomChin = laptopLid.querySelector('.laptop-bottom-chin') as HTMLElement | null;
        if (bottomChin && typeof df.bezelBottom === 'number') bottomChin.style.height = `${df.bezelBottom}px`;
      }
      // Laptop Aluminum Base Deck
      const baseHeight = df.baseHeight || 14;
      const baseY = lidY + lidHeight - 1;
      if (laptopBase) {
        laptopBase.style.left = `${df.frameX}px`;
        laptopBase.style.top = `${baseY}px`;
        laptopBase.style.width = `${df.frameWidth}px`;
        laptopBase.style.height = `${baseHeight}px`;
      }

      // Ambient Shadow Under Laptop
      if (laptopAmbientShadow) {
        laptopAmbientShadow.style.left = `${df.frameX - 20}px`;
        laptopAmbientShadow.style.top = `${baseY + 4}px`;
        laptopAmbientShadow.style.width = `${df.frameWidth + 40}px`;
        laptopAmbientShadow.style.height = `32px`;
      }

      // Studio Glow Left (only visible when Agent is interacting)
      if (glowLeft) {
        glowLeft.style.display = isAgentActive ? 'block' : 'none';
        glowLeft.style.left = `${df.frameX + df.frameWidth * 0.2}px`;
        glowLeft.style.top = `${df.frameY + df.frameHeight * 0.2}px`;
        glowLeft.style.width = `${df.frameWidth * 0.6}px`;
        glowLeft.style.height = `${df.frameHeight * 0.6}px`;
        glowLeft.classList.toggle('agent-working', isAgentActive);
      }
    }

    // 2. Update Mobile Mockup
    if (payload.mobileFrame && phoneMockup) {
      const mf = payload.mobileFrame;
      phoneMockup.style.display = 'block';
      phoneMockup.classList.toggle('is-focused', !isDesktopFocused);
      phoneMockup.classList.toggle('agent-working', isAgentActive);
      if (phoneBadge) {
        phoneBadge.classList.toggle('active-pane', !isDesktopFocused);
        phoneBadge.style.left = `${mf.badgeX}px`;
        phoneBadge.style.top = `${mf.badgeY}px`;
      }
      if (phoneBadgeIcon) phoneBadgeIcon.textContent = getDeviceIcon(mf.deviceType || mf.presetId, '📱');
      if (phoneBadgeTitle) phoneBadgeTitle.textContent = cleanDeviceName(mf.deviceName) || 'Phone';
      if (phoneBadgeRes) phoneBadgeRes.textContent = `${Math.round(mf.screenWidth / mf.scale)}×${Math.round(mf.screenHeight / mf.scale)}`;
      if (phoneBadgeScale) phoneBadgeScale.textContent = `${Math.round(mf.scale * 100)}%`;

      if (safariUrlDomain) {
        safariUrlDomain.textContent = extractDomain(payload.url);
      }
      if (phoneBody) {
        phoneBody.style.left = `${mf.frameX}px`;
        phoneBody.style.top = `${mf.frameY}px`;
        phoneBody.style.width = `${mf.frameWidth}px`;
        phoneBody.style.height = `${mf.frameHeight}px`;
        const phoneTopBezel = phoneBody.querySelector('.phone-top-bezel') as HTMLElement | null;
        if (phoneTopBezel && typeof mf.bezelTop === 'number') phoneTopBezel.style.height = `${mf.bezelTop}px`;
        const phoneBottomBezel = phoneBody.querySelector('.phone-bottom-bezel') as HTMLElement | null;
        if (phoneBottomBezel && typeof mf.bezelBottom === 'number') phoneBottomBezel.style.height = `${mf.bezelBottom}px`;

        const rawScreenRadius = typeof mf.cornerRadius === 'number' ? mf.cornerRadius : 48;
        const visualScreenRadius = Math.round(rawScreenRadius * mf.scale);
        const outerChassisRadius = rawScreenRadius > 0 ? Math.max(14, visualScreenRadius + (mf.bezelSide || 12)) : 10;
        phoneBody.style.borderRadius = `${outerChassisRadius}px`;
        const innerBezelRadius = Math.max(0, outerChassisRadius - 2.5);
        if (phoneTopBezel) {
          phoneTopBezel.style.borderRadius = `${innerBezelRadius}px ${innerBezelRadius}px 0 0`;
        }
        if (phoneBottomBezel) {
          phoneBottomBezel.style.borderRadius = `0 0 ${innerBezelRadius}px ${innerBezelRadius}px`;
        }
      }

      // Ambient Shadow Under Phone
      if (phoneAmbientShadow) {
        phoneAmbientShadow.style.left = `${mf.frameX - 16}px`;
        phoneAmbientShadow.style.top = `${mf.frameY + mf.frameHeight - 12}px`;
        phoneAmbientShadow.style.width = `${mf.frameWidth + 32}px`;
        phoneAmbientShadow.style.height = `30px`;
      }

      // Studio Glow Right (only visible when Agent is interacting)
      if (glowRight) {
        glowRight.style.display = isAgentActive ? 'block' : 'none';
        glowRight.style.left = `${mf.frameX + mf.frameWidth * 0.1}px`;
        glowRight.style.top = `${mf.frameY + mf.frameHeight * 0.2}px`;
        glowRight.style.width = `${mf.frameWidth * 0.8}px`;
        glowRight.style.height = `${mf.frameHeight * 0.6}px`;
        glowRight.classList.toggle('agent-working', isAgentActive);
      }
    }
  }

  window.antifanFrameBackdropApi?.onUpdateLayout((payload) => {
    applyLayout(payload);
  });

  window.antifanFrameBackdropApi?.notifyReady();
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initFrameBackdrop);
} else {
  initFrameBackdrop();
}
