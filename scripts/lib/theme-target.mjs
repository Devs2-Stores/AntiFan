/**
 * Resolves which theme id the storefront verification scripts should target.
 *
 * The verification scripts used to carry their theme id as a literal, so they
 * kept measuring a theme that was no longer the one under work. The id now
 * comes from the environment, the live theme is refused outright, and the
 * resolution is a single place to test.
 */

const PROTECTED_THEME_IDS = Object.freeze(['1001510509']);
const DEFAULT_THEME_ID = '1001514194';

export function resolveThemeId(env = process.env) {
  const raw = env.HARAVAN_THEME_ID;
  const value = (raw === undefined || raw === null || String(raw).trim() === '')
    ? DEFAULT_THEME_ID
    : String(raw).trim();

  if (!/^\d+$/.test(value)) {
    throw new Error(`HARAVAN_THEME_ID must be a numeric theme id, received "${value}"`);
  }
  if (PROTECTED_THEME_IDS.includes(value)) {
    throw new Error(`[SAFETY] refusing to target the protected live theme ${value}`);
  }
  return value;
}

export { PROTECTED_THEME_IDS, DEFAULT_THEME_ID };
