/**
 * oauth-popup-manager.ts
 *
 * Smart OAuth Popup and Window-Open Interceptor for AntiFan Browser Desktop.
 * Manages Google Sign-in, GitHub OAuth, Shopify/Haravan logins via modal windows
 * sharing the parent tab session, and routes standard links to new browser tabs.
 */
import { BrowserWindow, WebContents, HandlerDetails, WindowOpenHandlerResponse } from 'electron';
import { getSecureWebPreferences, isAllowedNavigation } from '../security/security-policy';
export interface OAuthHandlerOptions {
  onNewTabRequested?: (url: string) => void;
}

export class OAuthPopupManager {
  private static instance: OAuthPopupManager;
  private guardedWebContents = new WeakSet<WebContents>();

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

  public attachPopupGuards(
    parentContents: WebContents,
    parentWindow?: BrowserWindow,
    options?: OAuthHandlerOptions
  ): void {
    if (!parentContents || typeof parentContents.on !== 'function') return;
    if (this.guardedWebContents.has(parentContents)) return;
    this.guardedWebContents.add(parentContents);

    parentContents.on('did-create-window', (childWindow: BrowserWindow) => {
      this.configureChildWindowGuards(childWindow, parentContents, parentWindow, options);
    });
  }

  public configureChildWindowGuards(
    childWindow: BrowserWindow,
    parentContents: WebContents,
    parentWindow?: BrowserWindow,
    options?: OAuthHandlerOptions
  ): void {
    if (!childWindow) return;
    if (typeof childWindow.isDestroyed === 'function' && childWindow.isDestroyed()) return;

    const childContents = childWindow.webContents;
    if (!childContents) return;
    if (typeof childContents.isDestroyed === 'function' && childContents.isDestroyed()) return;

    // Guard window.open calls originating from inside the popup to prevent popup-chain and foreground theft
    if (typeof childContents.setWindowOpenHandler === 'function') {
      childContents.setWindowOpenHandler((details: HandlerDetails) => {
        const { url } = details;
        if (!isAllowedNavigation(url)) {
          return { action: 'deny' };
        }

        if (this.isOAuthUrl(url)) {
          return {
            action: 'allow',
            overrideBrowserWindowOptions: {
              width: 520,
              height: 680,
              parent: parentWindow || childWindow,
              show: true,
              backgroundColor: '#080c14',
              title: 'Xác thực Đăng nhập',
              webPreferences: {
                ...getSecureWebPreferences(),
                session: parentContents.session,
              },
            },
          };
        }

        if (options?.onNewTabRequested && url.startsWith('http') && isAllowedNavigation(url)) {
          options.onNewTabRequested(url);
        }
        return { action: 'deny' };
      });
    }

    // Attach did-create-window to the child window too, guarding nested popups
    this.attachPopupGuards(childContents, parentWindow || childWindow, options);

    // Guard direct navigation and redirects within the OAuth window
    if (typeof childContents.on === 'function') {
      childContents.on('will-navigate', (event, navigationUrl: string) => {
        if (!isAllowedNavigation(navigationUrl)) {
          event.preventDefault();
        }
      });

      childContents.on('will-redirect', (event, navigationUrl: string) => {
        if (!isAllowedNavigation(navigationUrl)) {
          event.preventDefault();
        }
      });
    }
  }

  public handleWindowOpen(
    parentContents: WebContents,
    parentWindow: BrowserWindow,
    details: HandlerDetails,
    options?: OAuthHandlerOptions
  ): WindowOpenHandlerResponse {
    // Ensure parent contents has did-create-window listener attached to configure child guards
    this.attachPopupGuards(parentContents, parentWindow, options);

    const { url } = details;

    // Fail-closed URL policy check: reject dangerous schemes (file:, javascript:, data:, etc.)
    if (!isAllowedNavigation(url)) {
      return { action: 'deny' };
    }

    if (this.isOAuthUrl(url)) {
      // AntiFan is the browser here; the visited website owns this OAuth flow.
      // Allowing Chromium to create the child preserves window.opener and uses
      // the exact parent Session for cookies and origin storage.
      return {
        action: 'allow',
        overrideBrowserWindowOptions: {
          width: 520,
          height: 680,
          parent: parentWindow,
          show: true,
          backgroundColor: '#080c14',
          title: 'Xác thực Đăng nhập',
          webPreferences: {
            ...getSecureWebPreferences(),
            session: parentContents.session,
          },
        },
      };
    }

    if (options?.onNewTabRequested && url.startsWith('http') && isAllowedNavigation(url)) {
      options.onNewTabRequested(url);
    }
    return { action: 'deny' };
  }


}
