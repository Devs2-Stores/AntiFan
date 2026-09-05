/**
 * AntiFan Browser Desktop — Tab Context Menu Builder
 * Constructs and opens context menus for web pages and the browser toolbar.
 */
import { Menu, MenuItem, BrowserWindow, shell, dialog } from 'electron';
import { ChromeProfileSyncManager } from './chrome-profile-sync';
import { HaravanUploader } from './haravan-uploader';

export interface TabContextMenuHostDelegate {
  getWindow(): BrowserWindow;
  getActiveTabId(): string;
  getActiveTab(): { url?: string; id?: string } | null | undefined;
  getActiveTabSession(): Electron.Session | undefined;
  startInspect(): void;
  toggleInspect(): boolean;
  toggleFontFinder(): void;
  toggleRuler(): void;
  toggleLens(): void;
  toggleSidebar(): void;
  toggleDevTools(): void;
  focusFindBar(): void;
  showShortcuts(): void;
  clearStorageForActiveTab(): void;
  bookmarkActiveTab(): void;
  toggleBookmarkBar(): void;
  goBack(tabId: string): void;
  goForward(tabId: string): void;
  reload(tabId: string): boolean;
  createTab(url?: string): string;
  viewPageSource?(tabId?: string): Promise<string> | void;
  captureScreenshot(): Promise<string>;
  openExternal(): void;
  onProfileSynced?(): void;
}

export class TabContextMenuBuilder {
  constructor(private readonly host: TabContextMenuHostDelegate) {}

  public setupPageContextMenu(wc: Electron.WebContents): void {
    wc.on('context-menu', async (_event, params) => {
      const menu = new Menu();
      const uploader = HaravanUploader.getInstance();
      const win = this.host.getWindow();

      // 1. AI & Design Inspection Tools
      menu.append(
        new MenuItem({
          label: '🎯 Inspect Element (Attach to AI Chat)',
          accelerator: 'Alt+Ctrl+A',
          click: () => this.host.startInspect(),
        })
      );
      menu.append(
        new MenuItem({
          label: '🔤 Font Finder (Typography)',
          accelerator: 'Alt+Ctrl+F',
          click: () => this.host.toggleFontFinder(),
        })
      );
      menu.append(
        new MenuItem({
          label: '📐 Pixel Ruler Layout Grid',
          accelerator: 'Alt+Ctrl+R',
          click: () => this.host.toggleRuler(),
        })
      );
      menu.append(
        new MenuItem({
          label: '🔍 GPU Lens (Pixel Zoom)',
          accelerator: 'Alt+Ctrl+L',
          click: () => this.host.toggleLens(),
        })
      );
      menu.append(
        new MenuItem({
          label: '💬 Toggle AI Chat Sidebar',
          accelerator: 'Alt+Ctrl+B',
          click: () => this.host.toggleSidebar(),
        })
      );

      menu.append(new MenuItem({ type: 'separator' }));

      // 2. Haravan Upload Toolkit & Image Processing
      let imageUrl = (params.srcURL && (params.mediaType === 'image' || params.srcURL.match(/\.(png|jpe?g|webp|gif|svg|avif)(\?.*)?$/i))) ? params.srcURL : '';

      if (!imageUrl && !wc.isDestroyed()) {
        try {
          const detected = await wc.executeJavaScript(`
            (function() {
              try {
                var el = document.elementFromPoint(${params.x}, ${params.y});
                if (!el) return '';
                if (el.tagName === 'IMG' && (el.currentSrc || el.src)) return el.currentSrc || el.src;
                var img = el.querySelector('img');
                if (img && (img.currentSrc || img.src)) return img.currentSrc || img.src;
                var bg = window.getComputedStyle(el).backgroundImage;
                if (bg && bg.startsWith('url(')) {
                  return bg.slice(4, -1).replace(/^["']|["']$/g, '');
                }
                var p = el.parentElement;
                for (var i = 0; i < 6 && p && p !== document.body; i++) {
                  if (p.tagName === 'IMG' && (p.currentSrc || p.src)) return p.currentSrc || p.src;
                  var pImg = p.querySelector('img');
                  if (pImg && (pImg.currentSrc || pImg.src)) return pImg.currentSrc || pImg.src;
                  var pBg = window.getComputedStyle(p).backgroundImage;
                  if (pBg && pBg.startsWith('url(')) {
                    return pBg.slice(4, -1).replace(/^["']|["']$/g, '');
                  }
                  p = p.parentElement;
                }
                return '';
              } catch (e) {
                return '';
              }
            })()
          `, true);
          if (detected && typeof detected === 'string' && (detected.startsWith('http://') || detected.startsWith('https://') || detected.startsWith('data:image/'))) {
            imageUrl = detected;
          }
        } catch {}
      }

      if (imageUrl) {
        menu.append(
          new MenuItem({
            label: '⚡ Save PNG + Upload Haravan (Copy CDN)',
            click: () => uploader.uploadImageToHaravan(imageUrl, undefined, win),
          })
        );

        const saveAsSubmenu = new Menu();
        for (const format of ['png', 'jpg', 'webp', 'pdf', 'gif'] as const) {
          saveAsSubmenu.append(
            new MenuItem({
              label: `Save as ${format.toUpperCase()}`,
              click: () => uploader.saveImageAs(imageUrl, format, win),
            })
          );
        }
        menu.append(
          new MenuItem({
            label: '💾 Save Image As',
            submenu: saveAsSubmenu,
          })
        );
        menu.append(
          new MenuItem({
            label: 'ℹ️ View Image Info & Dimensions',
            click: () => uploader.showImageInfo(imageUrl, win, wc),
          })
        );
        menu.append(
          new MenuItem({
            label: '📋 Copy Image Address',
            click: () => {
              const { clipboard } = require('electron');
              clipboard.writeText(imageUrl);
            },
          })
        );
        menu.append(new MenuItem({ type: 'separator' }));
      }

      // 3. Selection & Clipboard Actions
      if (params.selectionText) {
        menu.append(
          new MenuItem({
            label: `🔍 Search Google for "${params.selectionText.slice(0, 25)}${params.selectionText.length > 25 ? '...' : ''}"`,
            click: () => this.host.createTab(`https://www.google.com/search?q=${encodeURIComponent(params.selectionText)}`),
          })
        );
        menu.append(new MenuItem({ role: 'copy' }));
        menu.append(new MenuItem({ type: 'separator' }));
      }

      if (params.isEditable) {
        menu.append(new MenuItem({ role: 'undo' }));
        menu.append(new MenuItem({ role: 'redo' }));
        menu.append(new MenuItem({ type: 'separator' }));
        menu.append(new MenuItem({ role: 'cut' }));
        menu.append(new MenuItem({ role: 'copy' }));
        menu.append(new MenuItem({ role: 'paste' }));
        menu.append(new MenuItem({ role: 'selectAll' }));
        menu.append(new MenuItem({ type: 'separator' }));
      }

      if (params.linkURL) {
        menu.append(
          new MenuItem({
            label: '🔗 Open Link in New Tab',
            click: () => this.host.createTab(params.linkURL),
          })
        );
        menu.append(
          new MenuItem({
            label: '📋 Copy Link Address',
            click: () => {
              const { clipboard } = require('electron');
              clipboard.writeText(params.linkURL);
            },
          })
        );
        menu.append(new MenuItem({ type: 'separator' }));
      }

      // 4. Standard Navigation & Developer Tools
      const targetTabId = this.host.getActiveTabId();
      const navigationHistory = (wc as unknown as { navigationHistory?: { canGoBack?: () => boolean; canGoForward?: () => boolean } }).navigationHistory;
      menu.append(
        new MenuItem({
          label: '⬅️ Back',
          enabled: navigationHistory?.canGoBack?.() ?? false,
          click: () => this.host.goBack(targetTabId),
        })
      );
      menu.append(
        new MenuItem({
          label: '➡️ Forward',
          enabled: navigationHistory?.canGoForward?.() ?? false,
          click: () => this.host.goForward(targetTabId),
        })
      );
      menu.append(
        new MenuItem({
          label: '🔄 Reload',
          accelerator: 'Ctrl+R',
          click: () => this.host.reload(targetTabId),
        })
      );
      menu.append(
        new MenuItem({
          label: '↗️ Open in External Browser',
          click: () => this.host.openExternal(),
        })
      );
      menu.append(new MenuItem({ type: 'separator' }));
      menu.append(
        new MenuItem({
          label: '📄 View Page Source',
          accelerator: 'Ctrl+U',
          click: () => {
            if (this.host.viewPageSource) {
              this.host.viewPageSource(targetTabId);
            } else {
              const active = this.host.getActiveTab();
              if (active?.url) this.host.createTab(`view-source:${active.url}`);
            }
          },
        })
      );
      menu.append(
        new MenuItem({
          label: '🛠️ Inspect in DevTools',
          accelerator: 'F12',
          click: () => this.host.toggleDevTools(),
        })
      );

      menu.popup({ window: win });
    });
  }

  public showMainMenu(): void {
    const win = this.host.getWindow();
    const chromeProfiles = ChromeProfileSyncManager.getInstance().getAvailableProfiles();
    const profileSubmenu =
      chromeProfiles.length > 0
        ? chromeProfiles.map((p) => ({
            label: `Sync: ${p.name} (${p.id})`,
            click: async () => {
              const res = await ChromeProfileSyncManager.getInstance().syncProfile(p.id, this.host.getActiveTabSession());
              this.host.onProfileSynced?.();
              dialog.showMessageBox(win, {
                type: res.success ? 'info' : 'warning',
                title: 'Chrome Profile Sync',
                message: res.message,
              });
            },
          }))
        : [{ label: 'Không tìm thấy Chrome Profile', enabled: false }];

    const menu = Menu.buildFromTemplate([
      {
        label: 'Bookmark This Tab',
        accelerator: 'CmdOrCtrl+D',
        click: () => this.host.bookmarkActiveTab(),
      },
      {
        label: 'Toggle Bookmarks Bar',
        accelerator: 'CmdOrCtrl+Shift+B',
        click: () => this.host.toggleBookmarkBar(),
      },
      {
        label: 'Sync Google Chrome Profile',
        submenu: profileSubmenu,
      },
      { type: 'separator' },
      {
        label: 'Quick Inspect DOM (Annotate)',
        accelerator: 'CmdOrCtrl+B',
        click: () => this.host.toggleInspect(),
      },
      {
        label: 'Font Finder (Typography)',
        click: () => this.host.toggleFontFinder(),
      },
      {
        label: 'GPU Lens Zoom Glass',
        accelerator: 'CmdOrCtrl+Alt+L',
        click: () => this.host.toggleLens(),
      },
      {
        label: 'Capture Viewport Screenshot',
        accelerator: 'CmdOrCtrl+Shift+S',
        click: () => this.host.captureScreenshot(),
      },
      {
        label: 'Find in Page...',
        accelerator: 'CmdOrCtrl+F',
        click: () => this.host.focusFindBar(),
      },
      { type: 'separator' },
      {
        label: 'Toggle Developer Tools',
        accelerator: 'F12',
        click: () => this.host.toggleDevTools(),
      },
      {
        label: 'Clear Cookies & Cache for this site',
        click: () => this.host.clearStorageForActiveTab(),
      },
      {
        label: 'Open in System Browser',
        click: () => this.host.openExternal(),
      },
      { type: 'separator' },
      {
        label: 'Keyboard Shortcuts...',
        click: () => this.host.showShortcuts(),
      },
    ]);

    menu.popup({ window: win });
  }
}
