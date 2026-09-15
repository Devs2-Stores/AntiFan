/**
 * Theme binding resolution — which org/theme the harness measures.
 *
 * Precedence: `HARAVAN_ORG_ID` / `HARAVAN_THEME_ID` env vars (the convention
 * scripts/fetch-haravan-theme-safe.mjs already uses) win over the theme's own
 * `.haravan-cli_local.json` binding file. The binding file is gitignored local
 * state (`Storefront/.gitignore:1-3`), so it is read when present and never
 * committed, copied, or echoed into evidence — only the ids it carries are
 * recorded.
 *
 * The store base URL resolves through scripts/lib/campaign-target.mjs
 * (`--base-url` flag > `ANTIFAN_CAMPAIGN_BASE_URL` > the locked default), the
 * same parameterisation the measurement campaign uses, so a re-targeted run
 * cannot silently keep measuring the previous store.
 */
import fs from 'node:fs';
import path from 'node:path';
import { resolveCampaignBaseUrl } from '../lib/campaign-target.mjs';

export const BINDING_FILE = '.haravan-cli_local.json';
export const ENV_ORG_ID = 'HARAVAN_ORG_ID';
export const ENV_THEME_ID = 'HARAVAN_THEME_ID';

/**
 * Read `<themeDir>/.haravan-cli_local.json` when present.
 * @returns {{ orgId: string|null, themeId: string|null, themeName: string|null,
 *   present: boolean, error: string|null }}
 */
export function readBindingFile(themeDir) {
  const bindingPath = path.join(themeDir, BINDING_FILE);
  if (!fs.existsSync(bindingPath)) {
    return { orgId: null, themeId: null, themeName: null, present: false, error: null };
  }
  try {
    const parsed = JSON.parse(fs.readFileSync(bindingPath, 'utf8'));
    const pick = (value) => (typeof value === 'string' && value.trim() !== '' ? value.trim() : null);
    return {
      orgId: pick(parsed.org_id) ?? pick(parsed.theme_org_id),
      themeId: pick(parsed.theme_id),
      themeName: pick(parsed.theme_name),
      present: true,
      error: null,
    };
  } catch (err) {
    return {
      orgId: null,
      themeId: null,
      themeName: null,
      present: true,
      error: `unreadable ${BINDING_FILE}: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

/**
 * Resolve the harness binding for a theme directory.
 * @param {{ themeDir: string, argv?: string[], env?: NodeJS.ProcessEnv }} input
 * @returns {{ orgId: string|null, themeId: string|null, themeName: string|null,
 *   source: 'env'|'binding-file'|'mixed'|'none', bindingFile: {present:boolean,error:string|null},
 *   baseUrl: string, host: string, baseUrlSource: string, missing: string[] }}
 */
export function resolveThemeBinding({ themeDir, argv = [], env = process.env }) {
  const file = readBindingFile(themeDir);
  const envOrg = typeof env[ENV_ORG_ID] === 'string' && env[ENV_ORG_ID].trim() !== '' ? env[ENV_ORG_ID].trim() : null;
  const envTheme = typeof env[ENV_THEME_ID] === 'string' && env[ENV_THEME_ID].trim() !== '' ? env[ENV_THEME_ID].trim() : null;

  const orgId = envOrg ?? file.orgId;
  const themeId = envTheme ?? file.themeId;
  const sources = new Set();
  if (envOrg || envTheme) sources.add('env');
  if ((!envOrg && file.orgId) || (!envTheme && file.themeId)) sources.add('binding-file');
  const source = sources.size === 0 ? 'none' : sources.size === 1 ? [...sources][0] : 'mixed';

  const { baseUrl, host, source: baseUrlSource } = resolveCampaignBaseUrl({ argv, env });

  const missing = [];
  if (!themeId) missing.push('theme-id');
  if (!orgId) missing.push('org-id');

  return {
    orgId,
    themeId,
    themeName: file.themeName,
    source,
    bindingFile: { present: file.present, error: file.error },
    baseUrl,
    host,
    baseUrlSource,
    missing,
  };
}

/** Join `?themeid=<id>` onto a route path, preserving any existing query. */
export function pinnedRouteUrl(baseUrl, routePath, themeId) {
  const url = new URL(routePath, baseUrl);
  if (themeId) url.searchParams.set('themeid', themeId);
  return url.href;
}
