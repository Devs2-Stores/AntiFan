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
}

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
  { id: 'tablet-ipad-pro', name: '📟 iPad Pro 12.9" (1024×1366)', category: 'tablet', width: 1024, height: 1366, mobile: true },
  { id: 'ipad-pro-12', name: '📟 iPad Pro 12.9" (1024×1366)', category: 'tablet', width: 1024, height: 1366, mobile: true },
  { id: 'tablet-ipad-air', name: '📟 iPad Air / Pro 11" (820×1180)', category: 'tablet', width: 820, height: 1180, mobile: true },
  { id: 'ipad-air-11', name: '📟 iPad Air 11" (820×1180)', category: 'tablet', width: 820, height: 1180, mobile: true },
  { id: 'ipad-10th', name: '📟 iPad 10th Gen (810×1080)', category: 'tablet', width: 810, height: 1080, mobile: true },
  { id: 'tablet-ipad-mini', name: '📟 iPad Mini (768×1024)', category: 'tablet', width: 768, height: 1024, mobile: true },
  { id: 'ipad-mini', name: '📟 iPad Mini (768×1024)', category: 'tablet', width: 768, height: 1024, mobile: true },
  { id: 'surface-pro-9', name: '📟 Surface Pro 9 (912×1368)', category: 'tablet', width: 912, height: 1368, mobile: true },
  { id: 'galaxy-tab-s9', name: '📟 Galaxy Tab S9 (800×1280)', category: 'tablet', width: 800, height: 1280, mobile: true },

  // 4. Mobile Phones
  { id: 'phone-iphone16promax', name: '📱 iPhone 16 Pro Max (440×956)', category: 'mobile', width: 440, height: 956, mobile: true },
  { id: 'iphone-16-promax', name: '📱 iPhone 16 Pro Max (440×956)', category: 'mobile', width: 440, height: 956, mobile: true },
  { id: 'phone-iphone16plus', name: '📱 iPhone 16 Plus / 15 Plus (430×932)', category: 'mobile', width: 430, height: 932, mobile: true },
  { id: 'phone-iphone15pro', name: '📱 iPhone 16 / 15 Pro (393×852)', category: 'mobile', width: 393, height: 852, mobile: true },
  { id: 'iphone-16-pro', name: '📱 iPhone 16 / 15 Pro (393×852)', category: 'mobile', width: 393, height: 852, mobile: true },
  { id: 'phone-iphone14pro', name: '📱 iPhone 14 / 13 / 12 (390×844)', category: 'mobile', width: 390, height: 844, mobile: true },
  { id: 'iphone-14-15', name: '📱 iPhone 14 / 13 (390×844)', category: 'mobile', width: 390, height: 844, mobile: true },
  { id: 'phone-iphonexr', name: '📱 iPhone XR / 11 (414×896)', category: 'mobile', width: 414, height: 896, mobile: true },
  { id: 'phone-iphonese', name: '📱 iPhone SE (375×667)', category: 'mobile', width: 375, height: 667, mobile: true },
  { id: 'iphone-se', name: '📱 iPhone SE (375×667)', category: 'mobile', width: 375, height: 667, mobile: true },
  { id: 'phone-s24ultra', name: '📱 Samsung Galaxy S24 Ultra (412×915)', category: 'mobile', width: 412, height: 915, mobile: true },
  { id: 'galaxy-s24-ultra', name: '📱 Samsung Galaxy S24 Ultra (412×915)', category: 'mobile', width: 412, height: 915, mobile: true },
  { id: 'phone-zfold5', name: '📱 Samsung Galaxy Z Fold 5 (344×882)', category: 'mobile', width: 344, height: 882, mobile: true },
  { id: 'phone-pixel8pro', name: '📱 Google Pixel 8 Pro (448×998)', category: 'mobile', width: 448, height: 998, mobile: true },
  { id: 'pixel-9-pro', name: '📱 Google Pixel 9 Pro (412×924)', category: 'mobile', width: 412, height: 924, mobile: true },
  { id: 'phone-pixel7', name: '📱 Google Pixel 7 / 6 (412×915)', category: 'mobile', width: 412, height: 915, mobile: true },
  { id: 'xiaomi-14', name: '📱 Xiaomi 14 / 13 (393×851)', category: 'mobile', width: 393, height: 851, mobile: true },
  { id: 'mobile-compact', name: '📱 Mobile Baseline (360×800)', category: 'mobile', width: 360, height: 800, mobile: true },
  { id: 'mobile-small', name: '📱 Mobile Small (360×640)', category: 'mobile', width: 360, height: 640, mobile: true },
];
