import * as fs from 'node:fs';
import * as path from 'node:path';
import type { BrowserControlPort } from '../tools/browser-control-port';
import type { BrowserTarget } from '../../shared/control-plane-contracts';

export interface ShopIdentity {
  orgId: string;
  themeId: string;
  themeName?: string;
  source: 'cli_local' | 'workspace_context' | 'tab_probe';
  observedFields?: string[];
}

export function resolveWorkspaceShop(workspaceRoot: string): ShopIdentity | null {
  if (!workspaceRoot || typeof workspaceRoot !== 'string') return null;

  // 1. Primary: .haravan-cli_local.json in workspaceRoot
  const cliLocalPath = path.join(workspaceRoot, '.haravan-cli_local.json');
  try {
    if (fs.existsSync(cliLocalPath)) {
      const raw = fs.readFileSync(cliLocalPath, 'utf8');
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === 'object') {
        const orgId = parsed.org_id != null ? String(parsed.org_id).trim() : '';
        const themeId = parsed.theme_id != null ? String(parsed.theme_id).trim() : '';
        if (orgId.length > 0 && themeId.length > 0) {
          const themeName =
            typeof parsed.theme_name === 'string' && parsed.theme_name.trim().length > 0
              ? parsed.theme_name.trim()
              : undefined;
          return {
            orgId,
            themeId,
            themeName,
            source: 'cli_local',
          };
        }
      }
    }
  } catch {
    // Malformed JSON or unreadable file: fall through to fallback
  }

  // 2. Fallback: .workspace-context.json or workspace-context.json
  const candidateContextFiles = [
    path.join(workspaceRoot, '.workspace-context.json'),
    path.join(workspaceRoot, 'workspace-context.json'),
  ];

  for (const ctxPath of candidateContextFiles) {
    try {
      if (fs.existsSync(ctxPath)) {
        const raw = fs.readFileSync(ctxPath, 'utf8');
        const parsed = JSON.parse(raw);
        if (parsed && typeof parsed === 'object') {
          const haravan = parsed.haravan;
          if (haravan && typeof haravan === 'object') {
            const orgId =
              haravan.org_id != null
                ? String(haravan.org_id).trim()
                : haravan.orgId != null
                  ? String(haravan.orgId).trim()
                  : '';
            const themeId =
              haravan.theme_id != null
                ? String(haravan.theme_id).trim()
                : haravan.themeId != null
                  ? String(haravan.themeId).trim()
                  : '';
            if (orgId.length > 0 && themeId.length > 0) {
              const themeName =
                typeof haravan.theme_name === 'string' && haravan.theme_name.trim().length > 0
                  ? haravan.theme_name.trim()
                  : typeof haravan.themeName === 'string' && haravan.themeName.trim().length > 0
                    ? haravan.themeName.trim()
                    : undefined;
              return {
                orgId,
                themeId,
                themeName,
                source: 'workspace_context',
              };
            }
          }
        }
      }
    } catch {
      // Continue to next candidate
    }
  }

  return null;
}

export async function probeTabShopIdentity(
  browser?: BrowserControlPort | null,
  targetTabId?: string | null,
  baseTarget?: Partial<BrowserTarget>
): Promise<ShopIdentity | null> {
  if (!browser || !targetTabId || typeof targetTabId !== 'string' || !targetTabId.trim()) {
    return null;
  }
  const cleanTabId = targetTabId.trim();
  const script = `(() => {
    try {
      var haravan = window.Haravan || window.haravan || null;
      var elements = document.querySelectorAll('link[href*="hstatic.net"],script[src*="hstatic.net"],img[src*="hstatic.net"]');
      var hstaticLinks = [];
      for (var i = 0; i < elements.length && i < 50; i++) {
        var el = elements[i];
        var link = el.href || el.src || '';
        if (link) hstaticLinks.push(link);
      }
      var headSnippet = document.head ? document.head.innerHTML.slice(0, 20000) : '';
      return {
        shop: (haravan && haravan.shop) ? haravan.shop : null,
        theme: (haravan && haravan.theme) ? haravan.theme : null,
        href: location.href,
        hstaticLinks: hstaticLinks,
        headSnippet: headSnippet
      };
    } catch (e) {
      return null;
    }
  })()`;

  let evalResult: unknown;
  try {
    const target: BrowserTarget = {
      projectId: baseTarget?.projectId || 'default-project',
      workspaceId: baseTarget?.workspaceId || 'default-workspace',
      runtimeId: baseTarget?.runtimeId || 'default-runtime',
      tabId: cleanTabId,
      browserEpoch: baseTarget?.browserEpoch && baseTarget.browserEpoch >= 1 ? baseTarget.browserEpoch : 1,
      documentGeneration: baseTarget?.documentGeneration && baseTarget.documentGeneration >= 1 ? baseTarget.documentGeneration : 1,
    };
    evalResult = await browser.eval(target, script, cleanTabId);
  } catch (err) {
    console.warn(`[shop-identity:probe] Failed to evaluate tab ${cleanTabId}:`, err instanceof Error ? err.message : String(err));
    return null;
  }

  if (!evalResult || typeof evalResult !== 'object') {
    return null;
  }

  const payload = evalResult as {
    shop?: unknown;
    theme?: unknown;
    href?: string;
    hstaticLinks?: string[];
    headSnippet?: string;
  };

  const observedFields: string[] = [];
  let themeIdCandidate: string | null = null;
  let orgIdCandidate: string | null = null;

  // 1. Inspect window.Haravan.theme
  if (payload.theme && typeof payload.theme === 'object') {
    const themeObj = payload.theme as Record<string, unknown>;
    const rawThemeId = themeObj.id ?? themeObj.theme_id;
    if (rawThemeId != null && String(rawThemeId).trim().length > 0) {
      themeIdCandidate = String(rawThemeId).trim();
      observedFields.push('haravan_theme.id');
    }
  }

  // 2. Inspect window.Haravan.shop
  if (payload.shop && typeof payload.shop === 'object') {
    const shopObj = payload.shop as Record<string, unknown>;
    const rawOrgId = shopObj.id ?? shopObj.org_id;
    if (rawOrgId != null && String(rawOrgId).trim().length > 0) {
      orgIdCandidate = String(rawOrgId).trim();
      observedFields.push('haravan_shop.id');
    }
  }

  // 3. Inspect hstatic URLs in links, scripts, imgs, and head snippet
  const hstaticRegex = /hstatic\.net\/(\d+)\/(\d+)\//g;
  const sourcesToScan: string[] = [];
  if (Array.isArray(payload.hstaticLinks)) {
    sourcesToScan.push(...payload.hstaticLinks.filter((s): s is string => typeof s === 'string'));
  }
  if (typeof payload.headSnippet === 'string') {
    sourcesToScan.push(payload.headSnippet);
  }

  for (const src of sourcesToScan) {
    hstaticRegex.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = hstaticRegex.exec(src)) !== null) {
      const matchOrg = match[1];
      const matchTheme = match[2];
      if (themeIdCandidate) {
        if (matchTheme === themeIdCandidate && matchOrg) {
          orgIdCandidate = matchOrg;
          if (!observedFields.includes('hstatic_url.org_id')) observedFields.push('hstatic_url.org_id');
          if (!observedFields.includes('hstatic_url.theme_id')) observedFields.push('hstatic_url.theme_id');
          break;
        }
      } else if (matchOrg && matchTheme) {
        orgIdCandidate = matchOrg;
        themeIdCandidate = matchTheme;
        observedFields.push('hstatic_url.org_id');
        observedFields.push('hstatic_url.theme_id');
        break;
      }
    }
    if (orgIdCandidate && themeIdCandidate) break;
  }

  // Fallback if orgIdCandidate still not found but hstatic regex matches any org
  if (!orgIdCandidate) {
    for (const src of sourcesToScan) {
      hstaticRegex.lastIndex = 0;
      const match = hstaticRegex.exec(src);
      if (match && match[1]) {
        orgIdCandidate = match[1];
        observedFields.push('hstatic_url.org_id');
        if (!themeIdCandidate && match[2]) {
          themeIdCandidate = match[2];
          observedFields.push('hstatic_url.theme_id');
        }
        break;
      }
    }
  }

  // Record probe telemetry
  const orgSource = orgIdCandidate
    ? (observedFields.includes('hstatic_url.org_id') ? 'hstatic_url' : 'haravan_shop')
    : 'none';
  const themeSource = themeIdCandidate
    ? (observedFields.includes('haravan_theme.id') ? 'haravan_theme' : (observedFields.includes('hstatic_url.theme_id') ? 'hstatic_url' : 'none'))
    : 'none';

  console.log(`[shop-identity:probe] Tab ${cleanTabId} telemetry: orgId=${orgIdCandidate ?? 'none'} (${orgSource}), themeId=${themeIdCandidate ?? 'none'} (${themeSource}), observed=[${observedFields.join(', ')}]`);

  // Evidence rule: if either ID cannot be proven, return null (fail-closed)
  if (!orgIdCandidate || !themeIdCandidate) {
    return null;
  }

  return {
    orgId: orgIdCandidate,
    themeId: themeIdCandidate,
    source: 'tab_probe',
    observedFields,
  };
}
