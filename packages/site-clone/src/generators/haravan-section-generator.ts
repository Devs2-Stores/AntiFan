/**
 * Generator: Haravan Section Generator
 * Outputs valid Haravan OS 2.0 sections with Liquid rendering and {% schema %} blocks
 */

import { ExtractedSectionBlueprint } from '../models/blueprint-extractor.js';

export class HaravanSectionGenerator {
  public generateSectionFile(blueprint: ExtractedSectionBlueprint): string {
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
${blueprint.liquidTemplate}

{% schema %}
${schemaJson}
{% endschema %}
    `.trim();
  }
}
