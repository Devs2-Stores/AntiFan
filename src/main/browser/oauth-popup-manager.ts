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

    // Fail-closed URL policy check: reject dangerous schemes (file:, javascript:, data:, etc.)
    if (!isAllowedNavigation(url)) {
      return { action: 'deny' };
    }

    if (this.isOAuthUrl(url)) {
      // AntiFan is the browser here; the visited website owns this OAuth flow.
      // Letting Chromium create the child (through `createWindow`) preserves
      // window.opener and puts the popup in the opener's exact Session.
      const createOAuthPopup = options?.createOAuthPopup;
      if (!createOAuthPopup) return { action: 'deny' };
      return {
        action: 'allow',
        overrideBrowserWindowOptions: {
          webPreferences: getSecureWebPreferences(),
        },
        createWindow: (windowOptions) => createOAuthPopup(windowOptions, url),
      };
    }

    if (options?.onNewTabRequested && url.startsWith('http')) {
      options.onNewTabRequested(url);
    }
    return { action: 'deny' };
  }
}
