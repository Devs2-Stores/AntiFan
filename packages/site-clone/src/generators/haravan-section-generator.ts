/**
 * Generator: Haravan Section Generator
 * Outputs valid Haravan OS 2.0 sections with Liquid rendering and {% schema %} blocks
 */

import { ExtractedSectionBlueprint } from '../models/blueprint-extractor.js';
import type { StorefrontControllerContract } from '../models/clone-ir.js';

export class HaravanSectionGenerator {
  public generateSectionFile(
    blueprint: ExtractedSectionBlueprint,
    controllers: StorefrontControllerContract[] = []
  ): string {
    let liquid = blueprint.liquidTemplate;

    // Filter controllers belonging strictly to this section
    const matchingControllers = controllers.filter((c) => c.sectionId === blueprint.id);

    for (const ctrl of matchingControllers) {
      if (ctrl.type === 'carousel') {
        if (!liquid.includes('data-antifan-slider')) {
          liquid = liquid.replace(/<section\b([^>]*)>/i, '<section$1 data-antifan-slider data-antifan-autoplay="5000">');
        }
        if (!liquid.includes('data-antifan-slider-track')) {
          liquid = liquid.replace(
            /(<div\b[^>]*class=["'][^"']*(?:product-grid|slider|s-content)[^"']*["'])([^>]*>)/i,
            '$1 data-antifan-slider-track$2'
          );
        }
      } else if (ctrl.type === 'dropdown') {
        if (!liquid.includes('data-antifan-hover')) {
          liquid = liquid.replace(
            /(<li\b[^>]*class=["'][^"']*(?:menu-item-has-children|dropdown|has-sub)[^"']*["'])([^>]*>)/i,
            '$1 data-antifan-hover$2'
          );
        }
      } else if (ctrl.type === 'modal') {
        const modalTarget = (ctrl.targetSelector && ctrl.targetSelector.startsWith('#'))
          ? ctrl.targetSelector
          : `#modal-${blueprint.id}`;
        const modalId = modalTarget.replace(/^#/, '');

        if (!liquid.includes('data-antifan-modal')) {
          liquid = liquid.replace(
            /(<button\b[^>]*class=["'][^"']*(?:modal-btn|popup-btn|item-cta)[^"']*["'])([^>]*>)/i,
            `$1 data-antifan-modal="${modalTarget}"$2`
          );
        }
        if (!liquid.includes('data-antifan-modal-dialog')) {
          if (/(<div\b[^>]*class=["'][^"']*(?:modal|popup|dialog)[^"']*["'])([^>]*>)/i.test(liquid)) {
            liquid = liquid.replace(
              /(<div\b[^>]*class=["'][^"']*(?:modal|popup|dialog)[^"']*["'])([^>]*>)/i,
              `$1 id="${modalId}" data-antifan-modal-dialog aria-hidden="true"$2`
            );
          } else {
            liquid += `\n<div id="${modalId}" class="modal popup" data-antifan-modal-dialog aria-hidden="true"><div class="modal-content"><button class="close-btn" data-antifan-modal-close aria-label="Đóng">&times;</button><div class="modal-body"></div></div></div>`;
          }
        }
        if (!liquid.includes('data-antifan-modal-close')) {
          liquid = liquid.replace(
            /(<button\b[^>]*class=["'][^"']*(?:close|modal-close|btn-close)[^"']*["'])([^>]*>)/i,
            '$1 data-antifan-modal-close$2'
          );
        }
      }
    }
    const schemaObj = {
      name: blueprint.name,
      tag: blueprint.tagName,
      class: blueprint.className,
      settings: blueprint.schemaSettings,
      blocks: blueprint.blockDefinitions.map(def => ({
        type: def.type,
        name: def.name,
        settings: def.settings
      })),
      presets: [
        {
          name: blueprint.name,
          category: 'Custom Sections'
        }
      ]
    };

    const schemaJson = JSON.stringify(schemaObj, null, 2);

    return `
${liquid}
{% schema %}
${schemaJson}
{% endschema %}
    `.trim();
  }
}
