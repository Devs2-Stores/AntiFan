/**
 * oauth-popup-manager.ts
 *
 * OAuth classification and window-open policy for AntiFan Browser Desktop.
 * A website-owned OAuth popup (Google sign-in, GitHub, Shopify/Haravan logins, ...)
 * is built as a regular AntiFan tab through Electron's `createWindow` hook, so it keeps
 * `window.opener`, shares the opener's Chromium session, and stays reachable by the same
 * tab tooling as every other page. Standard links route to new browser tabs.
 */
import type { BrowserWindowConstructorOptions, HandlerDetails, WebContents, WindowOpenHandlerResponse } from 'electron';
import { getSecureWebPreferences, isAllowedNavigation } from '../security/security-policy';

/**
 * The options Electron passes to a `createWindow` hook. `webContents` is the WebContents
 * Chromium created for the popup; the declaration omits it, the runtime always supplies it.
 */
export interface OAuthPopupWindowOptions extends BrowserWindowConstructorOptions {
  webContents?: WebContents;
}

export interface OAuthHandlerOptions {
  onNewTabRequested?: (url: string) => void;
  /**
   * Builds the tab that hosts an OAuth popup. `windowOptions.webContents` is the
   * WebContents Chromium already created for the popup inside the opener's browsing
   * context; the callback must wrap exactly that object and return it. Without this
   * callback an OAuth `window.open` is denied: there is no native-window fallback.
   */
  createOAuthPopup?: (windowOptions: OAuthPopupWindowOptions, url: string) => WebContents;
  /**
   * Called once per window.open with the branch taken. Never receives a query string,
   * fragment or credentials: only the host and path that decided the branch.
   */
  onDecision?: (decision: OAuthWindowOpenDecision) => void;
}

export interface OAuthWindowOpenDecision {
  decision: 'oauth-popup' | 'feature-popup' | 'new-tab' | 'deny-scheme' | 'deny-no-handler';
  /** Empty for a non-http(s) URL: only `scheme` is reported for those. */
  host: string;
  path: string;
  scheme: string;
  disposition: string;
  hasFeatures: boolean;
  frameName: string;
}

const MAX_JOURNALED_PATH = 200;

/** Host and path only: a window.open URL's query and fragment routinely carry tokens. */
export function describeWindowOpen(details: HandlerDetails, decision: OAuthWindowOpenDecision['decision']): OAuthWindowOpenDecision {
  let host = '';
  let path = '';
  let scheme = '';
  try {
    const parsed = new URL(details.url);
    scheme = parsed.protocol;
    if (parsed.protocol === 'http:' || parsed.protocol === 'https:') {
      host = parsed.hostname.toLowerCase();
      path = parsed.pathname.slice(0, MAX_JOURNALED_PATH);
    }
  } catch {
    // An unparseable URL is journaled with empty host and path.
  }
  return {
    decision,
    host,
    path,
    scheme,
    disposition: typeof details.disposition === 'string' ? details.disposition : '',
    hasFeatures: typeof details.features === 'string' && details.features.trim().length > 0,
    frameName: typeof details.frameName === 'string' ? details.frameName.slice(0, 64) : '',
  };
}

/** `window.open(url, name, 'width=…')` / `'popup'` over https: a sign-in style popup that needs its opener. */
function isSizedHttpsPopup(details: HandlerDetails): boolean {
  if (details.disposition !== 'new-window') return false;
  if (typeof details.features !== 'string' || !details.features || /(?:^|,)\s*noopener\b/i.test(details.features)) return false;
  let protocol = '';
  try {
    protocol = new URL(details.url).protocol;
  } catch {
    return false;
  }
  if (protocol !== 'https:') return false;
  return /(?:^|,)\s*(?:width\s*=|popup(?:\s*=\s*(?!no|0|false)|\s*(?:,|$)))/i.test(details.features);
}

export class OAuthPopupManager {
  private static instance: OAuthPopupManager;

  public static getInstance(): OAuthPopupManager {
    if (!OAuthPopupManager.instance) {
      OAuthPopupManager.instance = new OAuthPopupManager();
    }
    return OAuthPopupManager.instance;
  }
  public isOAuthUrl(rawUrl: string): boolean {
    if (!rawUrl || typeof rawUrl !== 'string') return false;
    let parsed: URL;
    try {
      parsed = new URL(rawUrl);
    } catch {
      return false;
    }

    const hostname = parsed.hostname.toLowerCase();
    const pathname = parsed.pathname.toLowerCase();
    const hostIs = (domain: string): boolean => hostname === domain || hostname.endsWith(`.${domain}`);

    return (hostname === 'accounts.google.com' && /^\/(?:o\/oauth2|signin|servicelogin|v3\/signin)(?:\/|$)/.test(pathname))
      || (hostname === 'github.com' && pathname.startsWith('/login/oauth'))
      || (hostname === 'gitlab.com' && pathname.startsWith('/oauth'))
      || (hostIs('facebook.com') && /^\/(?:v\d+\.\d+\/)?dialog\/oauth(?:\/|$)/.test(pathname))
      || (hostname === 'appleid.apple.com' && pathname.startsWith('/auth'))
      || hostname === 'auth.haravan.com'
      || hostname === 'accounts.haravan.com'
      || (hostname === 'accounts.shopify.com' && pathname.startsWith('/oauth'))
      || (hostIs('myshopify.com') && pathname.startsWith('/admin/oauth'))
      || (hostIs('sapo.vn') && /^(?:\/oauth|\/admin\/oauth|\/login)(?:\/|$)/.test(pathname))
      || hostname === 'id.sapo.vn'
      || hostname === 'accounts.sapo.vn'
      || hostname === 'login.microsoftonline.com'
      || hostname === 'login.live.com'
      || (hostname === 'linear.app' && pathname.startsWith('/oauth'))
      || (hostIs('auth0.com') && pathname.startsWith('/authorize'))
      || hostIs('clerk.dev')
      || hostIs('clerk.accounts')
      || (hostIs('supabase.co') && pathname.startsWith('/auth/v1/authorize'))
      || (hostIs('trello.com') && /^\/1\/(?:authorize|oauthauthorizetoken)(?:\/|$)/.test(pathname))
      || (hostIs('instagram.com') && /^\/(?:accounts\/login|oauth\/authorize)(?:\/|$)/.test(pathname))
      || (hostname === 'business.facebook.com' && /^\/(?:login|oauth|oidc)(?:\/|$)/.test(pathname))
      || /(?:^|\/)oauth2?\/authorize(?:\/|$)/.test(pathname)
      || /(?:^|\/)auth\/login(?:\/|$)/.test(pathname);
  }

  public isOAuthCallbackUrl(rawUrl: string): boolean {
    if (!rawUrl || typeof rawUrl !== 'string') return false;
    let parsed: URL;
    try {
      parsed = new URL(rawUrl);
    } catch {
      return false;
    }

    const pathname = parsed.pathname.toLowerCase();
    return /(?:^|\/)(?:oauth\/callback|auth\/callback|oauth2\/callback|signin-google|signin-github|auth\/complete|auth\/success|login\/callback)(?:\/|$)/.test(pathname);
  }

  public handleWindowOpen(details: HandlerDetails, options?: OAuthHandlerOptions): WindowOpenHandlerResponse {
    const { url } = details;
    const decide = (decision: OAuthWindowOpenDecision['decision']): void => {
      if (!options?.onDecision) return;
      try {
        options.onDecision(describeWindowOpen(details, decision));
      } catch {
        // Journaling must never change what the page's window.open receives.
      }
    };

    // Fail-closed URL policy check: reject dangerous schemes (file:, javascript:, data:, etc.)
    if (!isAllowedNavigation(url)) {
      decide('deny-scheme');
      return { action: 'deny' };
    }

    const isOAuth = this.isOAuthUrl(url);
    // A sized, https window.open is a sign-in style popup even when the host is not on
    // the list: it only works when the page keeps its opener, so it is hosted the same way.
    const isFeaturePopup = !isOAuth && Boolean(options?.createOAuthPopup) && isSizedHttpsPopup(details);
    if (isOAuth || isFeaturePopup) {
      // AntiFan is the browser here; the visited website owns this OAuth flow.
      // Letting Chromium create the child (through `createWindow`) preserves
      // window.opener and puts the popup in the opener's exact Session.
      const createOAuthPopup = options?.createOAuthPopup;
      if (!createOAuthPopup) {
        decide('deny-no-handler');
        return { action: 'deny' };
      }
      decide(isOAuth ? 'oauth-popup' : 'feature-popup');
      return {
        action: 'allow',
        overrideBrowserWindowOptions: {
          webPreferences: getSecureWebPreferences(),
        },
        createWindow: (windowOptions) => createOAuthPopup(windowOptions, url),
      };
    }

    if (options?.onNewTabRequested && url.startsWith('http')) {
      decide('new-tab');
      options.onNewTabRequested(url);
      return { action: 'deny' };
    }
    decide('deny-no-handler');
    return { action: 'deny' };
  }
}
