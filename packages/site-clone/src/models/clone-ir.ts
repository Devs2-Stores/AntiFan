import type { HarvestedAssetManifest } from './asset-harvester.js';
import { ResponsiveScanner, type ResponsiveBreakpointConfig } from './responsive-scanner.js';
import type { NormalizedProduct, NormalizedCategory } from './ecommerce-data-modeler.js';

/**
 * Model: Component Contract Intermediate Representation (ComponentContractIR)
 * Decoupled canonical representation for e-commerce storefront theme reconstruction
 */
export interface LayoutConstraints {
  containerMaxWidth: number;
  containerPaddingPx: number;
  gridGapPx: number;
  breakpoints: {
    mobileMax: number;
    tabletMin: number;
    tabletMax: number;
    desktopMin: number;
  };
}

export interface ThemeSettingContract {
  id: string;
  type: 'color' | 'image_picker' | 'text' | 'textarea' | 'range' | 'font_picker' | 'link_list';
  label: string;
  default?: string | number | boolean;
}
export interface ComponentBlockContract {
  id?: string;
  type: string;
  name?: string;
  limit?: number;
  settings: Record<string, unknown>;
  dataBindings?: Record<string, string>;
}

/** Platform-neutral alias for ComponentBlockContract */
export type ComponentSlotContract = ComponentBlockContract;

export interface ComponentSectionContract {
  id: string;
  name: string;
  archetype: 'header' | 'hero_slider' | 'product_grid' | 'collection_list' | 'banner_grid' | 'rich_text' | 'footer' | 'custom_section';
  layoutType: 'grid' | 'flex' | 'scroll_snap_carousel' | 'column' | 'flow';
  heading?: string;
  className?: string;
  cssRules?: Record<string, string>;
  schemaSettings?: Array<{ type: string; id: string; label: string; default?: unknown }>;
  blockDefinitions?: Array<{ type: string; name: string; settings: Array<{ type: string; id: string; label: string }> }>;
  settings: Record<string, unknown>;
  blocks: ComponentBlockContract[];
  rawHtml?: string;
  liquidTemplate?: string;
}

/** Platform-neutral alias for ComponentSectionContract */
export type ComponentNodeContract = ComponentSectionContract;

export interface StorefrontControllerContract {
  id?: string;
  sectionId?: string;
  roleId?: string;
  type: 'carousel' | 'dropdown' | 'modal' | 'drawer' | 'tabs' | 'form_validation';
  targetSelector: string;
  triggerSelector: string;
  behavior: 'css_scroll_snap' | 'class_toggle' | 'dialog_native' | 'hover_intent';
}

export interface NormalizedStorefrontData {
  products?: NormalizedProduct[];
  categories?: NormalizedCategory[];
  siteSettings?: {
    title?: string;
    hotline?: string;
    email?: string;
    [key: string]: unknown;
  };
}
export interface ComponentContractIR {
  version: '1.0.0' | '1.1.0' | '1.2.0';
  metadata: {
    sourceUrl: string;
    extractedAt: string;
    engineVersion?: string;
  };
  layout: LayoutConstraints;
  responsive?: ResponsiveBreakpointConfig;
  assets?: HarvestedAssetManifest;
  themeSettings: ThemeSettingContract[];
  sections: ComponentSectionContract[];
  /** Neutral alias mirroring sections for universal consumers */
  components?: ComponentNodeContract[];
  storefrontRuntime: {
    controllers: StorefrontControllerContract[];
  };
  normalizedData?: NormalizedStorefrontData;
}

export function createDefaultComponentContractIR(sourceUrl: string = 'https://example.com'): ComponentContractIR {
  return {
    version: '1.0.0',
    metadata: {
      sourceUrl,
      extractedAt: new Date().toISOString(),
      engineVersion: '1.0.0-recon'
    },
    layout: {
      containerMaxWidth: 1280,
      containerPaddingPx: 16,
      gridGapPx: 20,
      breakpoints: {
        mobileMax: 767,
        tabletMin: 768,
        tabletMax: 1024,
        desktopMin: 1025
      }
    },
    responsive: ResponsiveScanner.BREAKPOINTS,
    assets: {
      stylesheets: [],
      javascripts: [],
      images: [],
      fonts: [],
      totalBytes: 0
    },
    themeSettings: [
      { id: 'color_primary', type: 'color', label: 'Primary Color', default: '#3590ce' },
      { id: 'color_bg', type: 'color', label: 'Background Color', default: '#ffffff' },
      { id: 'color_text', type: 'color', label: 'Text Color', default: '#22343e' }
    ],
    sections: [],
    storefrontRuntime: {
      controllers: []
    }
  };
}
