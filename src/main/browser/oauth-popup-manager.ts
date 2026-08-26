/**
 * oauth-popup-manager.ts
 *
 * Smart OAuth Popup and Window-Open Interceptor for AntiFan Browser Desktop.
 * Manages Google Sign-in, GitHub OAuth, Shopify/Haravan logins via modal windows
 * sharing the parent tab session, and routes standard links to new browser tabs.
 */
import { BrowserWindow, WebContents, HandlerDetails, WindowOpenHandlerResponse } from 'electron';

export interface OAuthHandlerOptions {
  onNewTabRequested?: (url: string) => void;
  onOAuthCompleted?: (url: string) => void;
}

export class OAuthPopupManager {
  private static instance: OAuthPopupManager;
  private activeAuthWindows = new Set<BrowserWindow>();

  public static getInstance(): OAuthPopupManager {
    if (!OAuthPopupManager.instance) {
      OAuthPopupManager.instance = new OAuthPopupManager();
    }
    return OAuthPopupManager.instance;
  }

  public isOAuthUrl(url: string): boolean {
    if (!url || typeof url !== 'string') return false;
    const oauthPatterns = [
      /accounts\.google\.com\/(o\/oauth2|signin|ServiceLogin|v3\/signin)/i,
      /github\.com\/login\/oauth/i,
      /facebook\.com\/(v\d+\.\d+\/)?dialog\/oauth/i,
      /appleid\.apple\.com\/auth/i,
      /auth\.haravan\.com/i,
      /accounts\.shopify\.com\/oauth/i,
      /linear\.app\/oauth/i,
      /auth0\.com\/authorize/i,
      /clerk\.(dev|accounts)/i,
      /supabase\.co\/auth\/v1\/authorize/i,
      /\/oauth2?\/authorize/i,
      /\/auth\/login/i,
    ];
    return oauthPatterns.some((pattern) => pattern.test(url));
  }

  public isOAuthCallbackUrl(url: string): boolean {
    if (!url || typeof url !== 'string') return false;
    const callbackPatterns = [
      /\/oauth\/callback/i,
      /\/auth\/callback/i,
      /\/oauth2\/callback/i,
      /\/signin-google/i,
      /\/signin-github/i,
      /\/auth\/complete/i,
      /code=[a-zA-Z0-9_.-]+(&|\b)/i,
    ];
    return callbackPatterns.some((pattern) => pattern.test(url));
  }

  public handleWindowOpen(
    parentContents: WebContents,
    parentWindow: BrowserWindow,
    details: HandlerDetails,
    options?: OAuthHandlerOptions
  ): WindowOpenHandlerResponse {
    const { url } = details;

    if (this.isOAuthUrl(url)) {
      // Google blocks embedded OAuth modal windows. Keep auth in a normal persistent Chromium tab.
      if (/accounts\.google\.com|gmail\.google\.com/i.test(url)) {
        options?.onNewTabRequested?.(url);
        return { action: 'deny' };
      }
      // Other providers use a dedicated modal sharing the parent session.
      const authWin = new BrowserWindow({
        width: 520,
        height: 680,
        parent: parentWindow,
        modal: true,
        show: false,
        backgroundColor: '#080c14',
        title: 'Xác thực Đăng nhập',
        webPreferences: {
          session: parentContents.session, // CRITICAL: Shares cookie/session storage
          sandbox: true,
          nodeIntegration: false,
          contextIsolation: true,
        },
      });

      this.activeAuthWindows.add(authWin);
      let showPopupTimer: NodeJS.Timeout | null = null;
      const showAuthWin = () => {
        if (showPopupTimer) {
          clearTimeout(showPopupTimer);
          showPopupTimer = null;
        }
        if (!authWin.isDestroyed() && !authWin.isVisible()) {
          authWin.show();
        }
      };
      authWin.once('ready-to-show', showAuthWin);
      showPopupTimer = setTimeout(showAuthWin, 300);
      authWin.loadURL(url).catch((err) => {
        console.warn('[OAuthPopupManager] Failed to load OAuth URL:', err);
      });

      const handleRedirect = (eventUrl: string) => {
        if (this.isOAuthCallbackUrl(eventUrl)) {
          options?.onOAuthCompleted?.(eventUrl);
          // Wait briefly for cookies/tokens to settle before closing
          setTimeout(() => {
            if (!authWin.isDestroyed()) {
              authWin.close();
            }
          }, 600);
        }
      };

      authWin.webContents.on('will-redirect', (_event, redirectUrl) => {
        handleRedirect(redirectUrl);
      });

      authWin.webContents.on('did-navigate', (_event, navUrl) => {
        handleRedirect(navUrl);
      });

      authWin.on('closed', () => {
        if (showPopupTimer) {
          clearTimeout(showPopupTimer);
          showPopupTimer = null;
        }
        this.activeAuthWindows.delete(authWin);
      });

      return { action: 'deny' };
    }

    // 2. Standard link: open as new tab in AntiFan Browser
    if (options?.onNewTabRequested && url.startsWith('http')) {
      options.onNewTabRequested(url);
      return { action: 'deny' };
    }

    return { action: 'deny' };
  }

  public closeAll(): void {
    for (const win of this.activeAuthWindows) {
      if (!win.isDestroyed()) {
        win.close();
      }
    }
    this.activeAuthWindows.clear();
  }
}
