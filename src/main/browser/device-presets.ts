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
  { id: 'responsive', name: '🖥️ Responsive (Auto)', category: 'responsive' },

  // 2. Desktop & Laptops
  { id: 'desktop-fhd', name: '🖥️ Desktop FHD (1920×1080)', category: 'desktop', width: 1920, height: 1080 },
  { id: 'laptop-macbook16', name: '💻 MacBook Pro 16" (1728×1117)', category: 'desktop', width: 1728, height: 1117 },
  { id: 'laptop-1440', name: '💻 Laptop 14" (1440×900)', category: 'desktop', width: 1440, height: 900 },
  { id: 'laptop-macbook13', name: '💻 MacBook Air 13" (1280×832)', category: 'desktop', width: 1280, height: 832 },

  // 3. Tablets
  { id: 'ipad-pro-12', name: '📟 iPad Pro 12.9" (1024×1366)', category: 'tablet', width: 1024, height: 1366, mobile: true },
  { id: 'surface-pro-9', name: '📟 Surface Pro 9 (912×1368)', category: 'tablet', width: 912, height: 1368, mobile: true },
  { id: 'ipad-air-11', name: '📟 iPad Air 11" (820×1180)', category: 'tablet', width: 820, height: 1180, mobile: true },
  { id: 'galaxy-tab-s9', name: '📟 Galaxy Tab S9 (800×1280)', category: 'tablet', width: 800, height: 1280, mobile: true },
  { id: 'ipad-mini', name: '📟 iPad Mini (768×1024)', category: 'tablet', width: 768, height: 1024, mobile: true },

  // 4. Mobile Phones
  { id: 'iphone-16-promax', name: '📱 iPhone 16 Pro Max (440×956)', category: 'mobile', width: 440, height: 956, mobile: true },
  { id: 'iphone-16-pro', name: '📱 iPhone 16 / 15 Pro (393×852)', category: 'mobile', width: 393, height: 852, mobile: true },
  { id: 'iphone-14-15', name: '📱 iPhone 14 / 13 (390×844)', category: 'mobile', width: 390, height: 844, mobile: true },
  { id: 'galaxy-s24-ultra', name: '📱 Samsung Galaxy S24 Ultra (412×915)', category: 'mobile', width: 412, height: 915, mobile: true },
  { id: 'pixel-9-pro', name: '📱 Google Pixel 9 Pro (412×924)', category: 'mobile', width: 412, height: 924, mobile: true },
  { id: 'xiaomi-14', name: '📱 Xiaomi 14 / 13 (393×851)', category: 'mobile', width: 393, height: 851, mobile: true },
  { id: 'iphone-se', name: '📱 iPhone SE (375×667)', category: 'mobile', width: 375, height: 667, mobile: true },
  { id: 'mobile-compact', name: '📱 Mobile Compact (360×800)', category: 'mobile', width: 360, height: 800, mobile: true },
];
