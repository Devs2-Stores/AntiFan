/**
 * Haravan Target Contract
 *
 * Defines the immutable typed contract for compiling Haravan themes.
 * Enforces explicit single settings mode ('legacy-html' | 'f1genz-schema'),
 * flat template topology, and zero dual-mode ambiguity.
 */

export type HaravanSettingsMode = 'legacy-html' | 'f1genz-schema';

export interface HaravanTopology {
  layout: string;
  templates: string[];
  snippetDir: string;
}

export interface HaravanTargetContract {
  platform: 'haravan';
  settingsMode: HaravanSettingsMode;
  topology: HaravanTopology;
  emitLocales: boolean;
  localizedLocales?: string[];
}

export const CANONICAL_HARAVAN_TEMPLATES = [
  'templates/index.liquid',
  'templates/product.liquid',
  'templates/collection.liquid',
  'templates/cart.liquid',
  'templates/search.liquid',
  'templates/page.liquid',
  'templates/page.contact.liquid',
  'templates/blog.liquid',
  'templates/article.liquid',
  'templates/404.liquid',
  'templates/customers[account].liquid',
  'templates/customers[activate_account].liquid',
  'templates/customers[addresses].liquid',
  'templates/customers[login].liquid',
  'templates/customers[order].liquid',
  'templates/customers[register].liquid',
  'templates/customers[reset_password].liquid',
] as const;

export const DEFAULT_HARAVAN_TOPOLOGY: HaravanTopology = {
  layout: 'layout/theme.liquid',
  templates: Array.from(CANONICAL_HARAVAN_TEMPLATES),
  snippetDir: 'snippets',
};

export interface CreateHaravanTargetContractOptions {
  settingsMode?: HaravanSettingsMode | string;
  topology?: Partial<HaravanTopology>;
  emitLocales?: boolean;
  localizedLocales?: string[];
}

/**
 * Creates and validates a HaravanTargetContract.
 * Fails closed if caller supplies 'dual' or any unsupported settingsMode.
 */
export function createHaravanTargetContract(
  options?: CreateHaravanTargetContractOptions
): HaravanTargetContract {
  const rawMode = options?.settingsMode;

  if (rawMode !== undefined) {
    if (typeof rawMode !== 'string' || !rawMode.trim()) {
      throw new Error(
        'Haravan target contract violation: invalid settings mode. Expected a non-empty string ("legacy-html" | "f1genz-schema").'
      );
    }

    const normalized = rawMode.trim().toLowerCase();

    if (normalized === 'dual') {
      throw new Error(
        'Haravan target contract violation: dual settings mode is unsupported. The Haravan compiler requires an explicit single settings mode ("legacy-html" | "f1genz-schema"); dual emission violates the single-mode invariant.'
      );
    }

    if (normalized !== 'legacy-html' && normalized !== 'f1genz-schema') {
      throw new Error(
        `Haravan target contract violation: invalid settings mode "${rawMode}". Expected "legacy-html" or "f1genz-schema".`
      );
    }
  }

  const settingsMode: HaravanSettingsMode =
    (options?.settingsMode as HaravanSettingsMode) || 'legacy-html';

  const topology: HaravanTopology = {
    layout: options?.topology?.layout || DEFAULT_HARAVAN_TOPOLOGY.layout,
    templates: options?.topology?.templates
      ? Array.from(options.topology.templates)
      : Array.from(DEFAULT_HARAVAN_TOPOLOGY.templates),
    snippetDir: options?.topology?.snippetDir || DEFAULT_HARAVAN_TOPOLOGY.snippetDir,
  };

  return {
    platform: 'haravan',
    settingsMode,
    topology,
    emitLocales: Boolean(options?.emitLocales),
    localizedLocales: options?.localizedLocales ? Array.from(options.localizedLocales) : undefined,
  };
}
