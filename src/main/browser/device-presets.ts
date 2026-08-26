/**
 * AntiFan Browser Desktop — Comprehensive Device Presets & Responsive Viewport Emulation
 * Supports all modern iPhone, Samsung, Pixel, iPad, MacBook, Laptop and Desktop viewport breakpoints.
 */

export interface DevicePreset {
  id: string;
  name: string;
  category: 'responsive' | 'desktop' | 'tablet' | 'mobile';
  width?: number;
  height?: number;
  deviceScaleFactor?: number;
  mobile?: boolean;
  userAgent?: string;
  platform?: string;
  maxTouchPoints?: number;
  cornerRadius?: number;
}

export const IPHONE_USER_AGENT = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1';
export const IPAD_USER_AGENT = 'Mozilla/5.0 (iPad; CPU OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1';
export const ANDROID_MOBILE_USER_AGENT = 'Mozilla/5.0 (Linux; Android 14; Mobile; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.6613.114 Mobile Safari/537.36';
export const ANDROID_TABLET_USER_AGENT = 'Mozilla/5.0 (Linux; Android 14; Tablet; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.6613.114 Safari/537.36';
export const MAC_DESKTOP_USER_AGENT = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36';
export const DEVICE_PRESETS: DevicePreset[] = [
  // 1. Responsive
  { id: 'responsive', name: '🖥️ Responsive (Fluid)', category: 'responsive' },

  // 2. Desktop & Laptops
  { id: 'desktop-4k', name: '🖥️ 4K UHD (3840×2160)', category: 'desktop', width: 3840, height: 2160 },
  { id: 'desktop-2k', name: '🖥️ 2K QHD (2560×1440)', category: 'desktop', width: 2560, height: 1440 },
  { id: 'desktop-fhd', name: '🖥️ Full HD (1920×1080)', category: 'desktop', width: 1920, height: 1080 },
  { id: 'laptop-macbook16', name: '💻 MacBook Pro 16" (1728×1117)', category: 'desktop', width: 1728, height: 1117 },
  { id: 'laptop-mac', name: '💻 MacBook Pro 16" (1728×1117)', category: 'desktop', width: 1728, height: 1117 },
  { id: 'laptop-macbook14', name: '💻 MacBook Pro 14" (1512×982)', category: 'desktop', width: 1512, height: 982 },
  { id: 'laptop-macbook13', name: '💻 MacBook Air 13" (1280×832)', category: 'desktop', width: 1280, height: 832 },
  { id: 'laptop-1440', name: '💻 Laptop 14" (1440×900)', category: 'desktop', width: 1440, height: 900 },
  { id: 'laptop-hd', name: '💻 Laptop Standard (1366×768)', category: 'desktop', width: 1366, height: 768 },
  { id: 'desktop-1280', name: '🖥️ Desktop 5:4 (1280×1024)', category: 'desktop', width: 1280, height: 1024 },

  // 3. Tablets
  { id: 'tablet-ipad-pro-13', name: '📟 iPad Pro 13" M4 (1032×1376)', category: 'tablet', width: 1032, height: 1376, mobile: true, deviceScaleFactor: 2, userAgent: IPAD_USER_AGENT, platform: 'iPad', maxTouchPoints: 5, cornerRadius: 20 },
  { id: 'tablet-ipad-pro', name: '📟 iPad Pro 12.9" (1024×1366)', category: 'tablet', width: 1024, height: 1366, mobile: true, deviceScaleFactor: 2, userAgent: IPAD_USER_AGENT, platform: 'iPad', maxTouchPoints: 5, cornerRadius: 18 },
  { id: 'ipad-pro-12', name: '📟 iPad Pro 12.9" (1024×1366)', category: 'tablet', width: 1024, height: 1366, mobile: true, deviceScaleFactor: 2, userAgent: IPAD_USER_AGENT, platform: 'iPad', maxTouchPoints: 5, cornerRadius: 18 },
  { id: 'tablet-ipad-pro-11', name: '📟 iPad Pro 11" M4 (834×1210)', category: 'tablet', width: 834, height: 1210, mobile: true, deviceScaleFactor: 2, userAgent: IPAD_USER_AGENT, platform: 'iPad', maxTouchPoints: 5, cornerRadius: 18 },
  { id: 'tablet-ipad-air', name: '📟 iPad Air / Pro 11" (820×1180)', category: 'tablet', width: 820, height: 1180, mobile: true, deviceScaleFactor: 2, userAgent: IPAD_USER_AGENT, platform: 'iPad', maxTouchPoints: 5, cornerRadius: 18 },
  { id: 'ipad-air-11', name: '📟 iPad Air 11" (820×1180)', category: 'tablet', width: 820, height: 1180, mobile: true, deviceScaleFactor: 2, userAgent: IPAD_USER_AGENT, platform: 'iPad', maxTouchPoints: 5, cornerRadius: 18 },
  { id: 'ipad-10th', name: '📟 iPad 10th Gen (810×1080)', category: 'tablet', width: 810, height: 1080, mobile: true, deviceScaleFactor: 2, userAgent: IPAD_USER_AGENT, platform: 'iPad', maxTouchPoints: 5, cornerRadius: 18 },
  { id: 'tablet-ipad-mini-6', name: '📟 iPad Mini 6/7 (744×1133)', category: 'tablet', width: 744, height: 1133, mobile: true, deviceScaleFactor: 2, userAgent: IPAD_USER_AGENT, platform: 'iPad', maxTouchPoints: 5, cornerRadius: 18 },
  { id: 'tablet-ipad-mini', name: '📟 iPad Mini (768×1024)', category: 'tablet', width: 768, height: 1024, mobile: true, deviceScaleFactor: 2, userAgent: IPAD_USER_AGENT, platform: 'iPad', maxTouchPoints: 5, cornerRadius: 18 },
  { id: 'ipad-mini', name: '📟 iPad Mini (768×1024)', category: 'tablet', width: 768, height: 1024, mobile: true, deviceScaleFactor: 2, userAgent: IPAD_USER_AGENT, platform: 'iPad', maxTouchPoints: 5, cornerRadius: 18 },
  { id: 'galaxy-tab-s9-ultra', name: '📟 Galaxy Tab S9 Ultra (928×1480)', category: 'tablet', width: 928, height: 1480, mobile: true, deviceScaleFactor: 2, userAgent: ANDROID_TABLET_USER_AGENT, platform: 'Linux armv81', maxTouchPoints: 5, cornerRadius: 16 },
  { id: 'galaxy-tab-s9', name: '📟 Galaxy Tab S9 (800×1280)', category: 'tablet', width: 800, height: 1280, mobile: true, deviceScaleFactor: 2, userAgent: ANDROID_TABLET_USER_AGENT, platform: 'Linux armv81', maxTouchPoints: 5, cornerRadius: 16 },
  { id: 'surface-pro-9', name: '📟 Surface Pro 9 / 11 (912×1368)', category: 'tablet', width: 912, height: 1368, mobile: true, deviceScaleFactor: 2, userAgent: ANDROID_TABLET_USER_AGENT, platform: 'Linux armv81', maxTouchPoints: 5, cornerRadius: 0 },
  { id: 'tablet-768', name: '📟 Tablet Standard (768×1024)', category: 'tablet', width: 768, height: 1024, mobile: true, deviceScaleFactor: 2, userAgent: ANDROID_TABLET_USER_AGENT, platform: 'Linux armv81', maxTouchPoints: 5, cornerRadius: 12 },
  { id: 'tablet-landscape-1024', name: '📟 Tablet Landscape (1024×768)', category: 'tablet', width: 1024, height: 768, mobile: true, deviceScaleFactor: 2, userAgent: ANDROID_TABLET_USER_AGENT, platform: 'Linux armv81', maxTouchPoints: 5, cornerRadius: 12 },
  { id: 'tablet-landscape-1280', name: '📟 Tablet Landscape (1280×800)', category: 'tablet', width: 1280, height: 800, mobile: true, deviceScaleFactor: 2, userAgent: ANDROID_TABLET_USER_AGENT, platform: 'Linux armv81', maxTouchPoints: 5, cornerRadius: 12 },

  // 4. Mobile Phones
  { id: 'phone-iphone16promax', name: '📱 iPhone 16 Pro Max (440×956)', category: 'mobile', width: 440, height: 956, mobile: true, deviceScaleFactor: 3, userAgent: IPHONE_USER_AGENT, platform: 'iPhone', maxTouchPoints: 5, cornerRadius: 48 },
  { id: 'iphone-16-promax', name: '📱 iPhone 16 Pro Max (440×956)', category: 'mobile', width: 440, height: 956, mobile: true, deviceScaleFactor: 3, userAgent: IPHONE_USER_AGENT, platform: 'iPhone', maxTouchPoints: 5, cornerRadius: 48 },
  { id: 'phone-iphone16plus', name: '📱 iPhone 16 Plus / 15 Plus (430×932)', category: 'mobile', width: 430, height: 932, mobile: true, deviceScaleFactor: 3, userAgent: IPHONE_USER_AGENT, platform: 'iPhone', maxTouchPoints: 5, cornerRadius: 48 },
  { id: 'phone-iphone15pro', name: '📱 iPhone 16 / 15 Pro (393×852)', category: 'mobile', width: 393, height: 852, mobile: true, deviceScaleFactor: 3, userAgent: IPHONE_USER_AGENT, platform: 'iPhone', maxTouchPoints: 5, cornerRadius: 48 },
  { id: 'iphone-16-pro', name: '📱 iPhone 16 / 15 Pro (393×852)', category: 'mobile', width: 393, height: 852, mobile: true, deviceScaleFactor: 3, userAgent: IPHONE_USER_AGENT, platform: 'iPhone', maxTouchPoints: 5, cornerRadius: 48 },
  { id: 'phone-iphone14pro', name: '📱 iPhone 14 / 13 / 12 (390×844)', category: 'mobile', width: 390, height: 844, mobile: true, deviceScaleFactor: 3, userAgent: IPHONE_USER_AGENT, platform: 'iPhone', maxTouchPoints: 5, cornerRadius: 48 },
  { id: 'iphone-14-15', name: '📱 iPhone 14 / 13 (390×844)', category: 'mobile', width: 390, height: 844, mobile: true, deviceScaleFactor: 3, userAgent: IPHONE_USER_AGENT, platform: 'iPhone', maxTouchPoints: 5, cornerRadius: 48 },
  { id: 'phone-iphonexr', name: '📱 iPhone XR / 11 (414×896)', category: 'mobile', width: 414, height: 896, mobile: true, deviceScaleFactor: 2, userAgent: IPHONE_USER_AGENT, platform: 'iPhone', maxTouchPoints: 5, cornerRadius: 44 },
  { id: 'phone-iphonese', name: '📱 iPhone SE 2/3 (375×667)', category: 'mobile', width: 375, height: 667, mobile: true, deviceScaleFactor: 2, userAgent: IPHONE_USER_AGENT, platform: 'iPhone', maxTouchPoints: 5, cornerRadius: 0 },
  { id: 'iphone-se', name: '📱 iPhone SE 2/3 (375×667)', category: 'mobile', width: 375, height: 667, mobile: true, deviceScaleFactor: 2, userAgent: IPHONE_USER_AGENT, platform: 'iPhone', maxTouchPoints: 5, cornerRadius: 0 },
  { id: 'phone-s24ultra', name: '📱 Samsung Galaxy S24 Ultra (412×915)', category: 'mobile', width: 412, height: 915, mobile: true, deviceScaleFactor: 3, userAgent: ANDROID_MOBILE_USER_AGENT, platform: 'Linux armv81', maxTouchPoints: 5, cornerRadius: 20 },
  { id: 'galaxy-s24-ultra', name: '📱 Samsung Galaxy S24 Ultra (412×915)', category: 'mobile', width: 412, height: 915, mobile: true, deviceScaleFactor: 3, userAgent: ANDROID_MOBILE_USER_AGENT, platform: 'Linux armv81', maxTouchPoints: 5, cornerRadius: 20 },
  { id: 'phone-zfold5', name: '📱 Samsung Galaxy Z Fold 5 (344×882)', category: 'mobile', width: 344, height: 882, mobile: true, deviceScaleFactor: 2.5, userAgent: ANDROID_MOBILE_USER_AGENT, platform: 'Linux armv81', maxTouchPoints: 5, cornerRadius: 24 },
  { id: 'phone-pixel8pro', name: '📱 Google Pixel 8 Pro (448×998)', category: 'mobile', width: 448, height: 998, mobile: true, deviceScaleFactor: 3, userAgent: ANDROID_MOBILE_USER_AGENT, platform: 'Linux armv81', maxTouchPoints: 5, cornerRadius: 44 },
  { id: 'pixel-9-pro', name: '📱 Google Pixel 9 Pro (412×924)', category: 'mobile', width: 412, height: 924, mobile: true, deviceScaleFactor: 3, userAgent: ANDROID_MOBILE_USER_AGENT, platform: 'Linux armv81', maxTouchPoints: 5, cornerRadius: 44 },
  { id: 'phone-pixel7', name: '📱 Google Pixel 7 / 6 (412×915)', category: 'mobile', width: 412, height: 915, mobile: true, deviceScaleFactor: 2.625, userAgent: ANDROID_MOBILE_USER_AGENT, platform: 'Linux armv81', maxTouchPoints: 5, cornerRadius: 44 },
  { id: 'xiaomi-14', name: '📱 Xiaomi 14 / 13 (393×851)', category: 'mobile', width: 393, height: 851, mobile: true, deviceScaleFactor: 3, userAgent: ANDROID_MOBILE_USER_AGENT, platform: 'Linux armv81', maxTouchPoints: 5, cornerRadius: 40 },
  { id: 'mobile-compact', name: '📱 Mobile Baseline (360×800)', category: 'mobile', width: 360, height: 800, mobile: true, deviceScaleFactor: 2, userAgent: ANDROID_MOBILE_USER_AGENT, platform: 'Linux armv81', maxTouchPoints: 5, cornerRadius: 0 },
  { id: 'mobile-small', name: '📱 Mobile Small (360×640)', category: 'mobile', width: 360, height: 640, mobile: true, deviceScaleFactor: 2, userAgent: ANDROID_MOBILE_USER_AGENT, platform: 'Linux armv81', maxTouchPoints: 5, cornerRadius: 0 },
  { id: 'phone-iphone5s', name: '📱 iPhone 5s / SE 1 (320×568)', category: 'mobile', width: 320, height: 568, mobile: true, deviceScaleFactor: 2, userAgent: IPHONE_USER_AGENT, platform: 'iPhone', maxTouchPoints: 5, cornerRadius: 0 },
  { id: 'mobile-320', name: '📱 Mobile 320 (320×568)', category: 'mobile', width: 320, height: 568, mobile: true, deviceScaleFactor: 2, userAgent: ANDROID_MOBILE_USER_AGENT, platform: 'Linux armv81', maxTouchPoints: 5, cornerRadius: 0 },
  { id: 'mobile-320-tall', name: '📱 Mobile 320 Tall (320×640)', category: 'mobile', width: 320, height: 640, mobile: true, deviceScaleFactor: 2, userAgent: ANDROID_MOBILE_USER_AGENT, platform: 'Linux armv81', maxTouchPoints: 5, cornerRadius: 0 },
  { id: 'mobile-320-compact', name: '📱 Mobile 320 Compact (320×480)', category: 'mobile', width: 320, height: 480, mobile: true, deviceScaleFactor: 2, userAgent: ANDROID_MOBILE_USER_AGENT, platform: 'Linux armv81', maxTouchPoints: 5, cornerRadius: 0 },
];

export function getPresetCornerRadius(presetOrId?: DevicePreset | string | null): number {
  if (!presetOrId) return 0;
  const preset = typeof presetOrId === 'string' ? DEVICE_PRESETS.find((p) => p.id === presetOrId) : presetOrId;
  if (!preset) return 0;
  if (typeof preset.cornerRadius === 'number') return preset.cornerRadius;
  if (preset.category === 'desktop' || preset.category === 'responsive') return 0;
  if (preset.id.includes('iphonese') || preset.id.includes('iphone-se') || preset.id.includes('surface')) return 0;
  if (preset.category === 'tablet') return 18;
  if (preset.category === 'mobile') {
    if (preset.id.includes('s24ultra') || preset.id.includes('galaxy-s24')) return 20;
    if (preset.id.includes('zfold5')) return 24;
    if (preset.id.includes('compact') || preset.id.includes('small')) return 0;
    return 48;
  }
  return 0;
}

export function getPresetUserAgent(preset?: DevicePreset | null, defaultUA?: string): string | undefined {
  if (!preset) return defaultUA;
  if (preset.userAgent) return preset.userAgent;
  if (preset.mobile) {
    return preset.id.includes('iphone') || preset.id.includes('ipad') ? IPHONE_USER_AGENT : ANDROID_MOBILE_USER_AGENT;
  }
  return defaultUA;
}
