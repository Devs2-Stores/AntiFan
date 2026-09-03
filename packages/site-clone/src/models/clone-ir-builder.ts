/**
 * Model: Clone IR Builder
 * Transforms extracted blueprints and telemetry into a decoupled ComponentContractIR
 */

import path from 'node:path';
import os from 'node:os';
import { BlueprintExtractor, ExtractedSectionBlueprint } from './blueprint-extractor.js';
import { EcommerceDataModeler } from './ecommerce-data-modeler.js';
import { AssetHarvester } from './asset-harvester.js';
import { ResponsiveScanner } from './responsive-scanner.js';
import {
  ComponentContractIR,
  ComponentSectionContract,
  ComponentBlockContract,
  StorefrontControllerContract
} from './clone-ir.js';

export class CloneIRBuilder {
  private extractor = new BlueprintExtractor();
  private dataModeler = new EcommerceDataModeler();
  private assetHarvester = new AssetHarvester();
  private responsiveScanner = new ResponsiveScanner();
  public buildFromHtml(html: string, sourceUrl: string = 'https://example.com', assetsDir?: string): ComponentContractIR {
    const blueprints = this.extractor.extractSections(html);
    const dataBundle = this.dataModeler.extractStorefrontData(html);
    const targetAssetsDir = assetsDir ?? path.join(os.tmpdir(), 'antifan-assets');
    const harvestedAssets = this.assetHarvester.harvestFromHtml(html, targetAssetsDir);

    const sections: ComponentSectionContract[] = blueprints.map(bp => this.mapBlueprintToSection(bp));
    const controllers: StorefrontControllerContract[] = this.inferControllers(sections);

    return {
      version: '1.1.0',
      metadata: {
        sourceUrl,
        extractedAt: new Date().toISOString(),
        engineVersion: '1.1.0-recon'
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
        },
        relations: [
          { type: 'column-count', value: 4, viewport: 'desktop' },
          { type: 'column-count', value: 2, viewport: 'tablet' },
          { type: 'column-count', value: 1, viewport: 'mobile' },
          { type: 'gap', value: 20, viewport: 'all' }
        ]
      },
      responsive: ResponsiveScanner.BREAKPOINTS,
      assets: harvestedAssets,
      themeSettings: [
        { id: 'color_primary', type: 'color', label: 'Primary Brand Color', default: '#005baa' },
        { id: 'color_bg', type: 'color', label: 'Page Background Color', default: '#ffffff' },
        { id: 'color_text', type: 'color', label: 'Body Text Color', default: '#22343e' },
        { id: 'hotline', type: 'text', label: 'Support Hotline', default: dataBundle.siteSettings.hotline || '' },
        { id: 'email', type: 'text', label: 'Support Email', default: dataBundle.siteSettings.email || '' }
      ],
      sections,
      components: sections,
      storefrontRuntime: {
        controllers
      },
      normalizedData: {
        products: dataBundle.products,
        categories: dataBundle.categories,
        siteSettings: dataBundle.siteSettings
      }
    };
  }

  private mapBlueprintToSection(bp: ExtractedSectionBlueprint): ComponentSectionContract {
    let archetype: ComponentSectionContract['archetype'] = 'custom_section';
    let layoutType: ComponentSectionContract['layoutType'] = 'flow';

    switch (bp.type) {
      case 'header':
        archetype = 'header';
        layoutType = 'flex';
        break;
      case 'hero-slider':
        archetype = 'hero_slider';
        layoutType = 'scroll_snap_carousel';
        break;
      case 'featured-products':
        archetype = 'product_grid';
        layoutType = 'grid';
        break;
      case 'category-grid':
        archetype = 'collection_list';
        layoutType = 'grid';
        break;
      case 'quote-form':
        archetype = 'rich_text';
        layoutType = 'column';
        break;
      case 'footer':
        archetype = 'footer';
        layoutType = 'flex';
        break;
      default:
        archetype = 'custom_section';
        layoutType = 'flow';
        break;
    }

    const blocks: ComponentBlockContract[] = bp.blockInstances.map(b => ({
      id: b.id,
      type: b.type,
      name: b.type,
      settings: b.settings,
      dataBindings: {}
    }));

    return {
      id: bp.id,
      name: bp.name,
      archetype,
      layoutType,
      heading: bp.heading,
      className: bp.className,
      schemaSettings: bp.schemaSettings,
      blockDefinitions: bp.blockDefinitions,
      settings: {},
      blocks,
      rawHtml: bp.rawHtml,
      liquidTemplate: bp.liquidTemplate
    };
  }

  private inferControllers(sections: ComponentSectionContract[]): StorefrontControllerContract[] {
    const controllers: StorefrontControllerContract[] = [];

    for (const sec of sections) {
      if (sec.archetype === 'hero_slider') {
        controllers.push({
          id: `${sec.id}_controller_${controllers.length}`,
          sectionId: sec.id,
          roleId: 'slider_track',
          type: 'carousel',
          targetSelector: `.${sec.className} .s-content, .slider, .carousel`,
          triggerSelector: '.carousel-nav-btn',
          behavior: 'css_scroll_snap'
        });
      }
      if (sec.archetype === 'header') {
        controllers.push({
          id: `${sec.id}_controller_${controllers.length}`,
          sectionId: sec.id,
          roleId: 'dropdown_panel',
          type: 'dropdown',
          targetSelector: '.sub-menu, .category-navigation__sub',
          triggerSelector: '.menu-item-has-children, .category-navigation__list li',
          behavior: 'hover_intent'
        });
      }
    }
    return controllers;
  }
}
