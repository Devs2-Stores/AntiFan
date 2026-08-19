/**
 * Plugin SDK v1 — public types for developers of declarative plugins.
 *
 * These re-export the manifest/permission shapes so a plugin author gets
 * typed guidance without reaching into main internals. Mirror of
 * src/main/plugins/plugin-manifest.ts.
 */
export const PLUGIN_SDK_VERSION = 1 as const;

export const SDK_HOOKS = [
  'pageReady', 'navigation', 'elementSelected', 'beforeQueue', 'disconnect',
] as const;
export type SdkHook = (typeof SDK_HOOKS)[number];

export const SDK_PERMISSIONS = [
  'annotation.read',
  'annotation.prepareQueue',
  'capture.request',
  'browser.listTabs',
  'browser.navigate',
  'ui.toolbar',
  'site.adapter',
] as const;
export type SdkPermission = (typeof SDK_PERMISSIONS)[number];

export interface PluginManifestV1 {
  id: string;
  version: string;
  sdkVersion: typeof PLUGIN_SDK_VERSION;
  sdkRange: [number, number];
  name: string;
  description?: string;
  /** Declare only capabilities you actually use. */
  permissions: SdkPermission[];
  contributions: unknown[];
  /** sha256 per resource path; adapters and presets must be verified. */
  integrity: Record<string, string>;
  siteAdapters?: Record<string, string>;
  hooks?: SdkHook[];
}

/** Schema-limited message an isolated site adapter accepts. */
export interface AdapterMessage {
  type: string;
  [k: string]: unknown;
}

/** Schema-limited result an isolated site adapter returns. */
export interface AdapterResult {
  ok: boolean;
  [k: string]: unknown;
}

/** SDK rules a developer must follow (surface as a comment/type doc). */
export const SDK_RULES = [
  'No Node entrypoint, child process, raw network, or filesystem access.',
  'Adapters run in an isolated world with schema-limited messages only.',
  'Never request Chat send/consent, arbitrary MCP eval, or Node execute.',
] as const;