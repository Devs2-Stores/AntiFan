# Phase 02: Click-to-Open Web Links (@xterm/addon-web-links)

## Context
- Files to modify:
  - `src/renderer/standalone.html`: Add `<script src="../../../node_modules/@xterm/addon-web-links/lib/addon-web-links.js"></script>`
  - `src/preload/standalone-preload.ts`: Expose `createTab: (url?: string) => ipcRenderer.invoke('antifan:toolbar:create-tab', url)` and `openExternal: (url?: string) => ipcRenderer.invoke('antifan:toolbar:open-external', url)`
  - `src/renderer/standalone.js`: Add `attachWebLinksAddon(term)` helper that instantiates `new WebLinksAddon.WebLinksAddon((event, uri) => { ... })` and loads it into every created terminal pane (both main sessions and split pane).
  - `src/renderer/terminal.html` & `src/renderer/terminal.ts` (if docked terminal is used): Ensure addon compatibility.

## Implementation Details
1. `standalone-preload.ts`:
   - Add `createTab(url?: string): Promise<string>` calling `ipcRenderer.invoke('antifan:toolbar:create-tab', url)`.
2. `standalone.html`:
   - Load `addon-web-links.js` right alongside `addon-fit.js` and `addon-webgl.js`.
3. `standalone.js`:
   - Define `attachWebLinksAddon(term)`:
     ```javascript
     function attachWebLinksAddon(term) {
       try {
         const Ctor = window.WebLinksAddon?.WebLinksAddon || globalThis.WebLinksAddon?.WebLinksAddon;
         if (!Ctor) return null;
         const linkHandler = (event, uri) => {
           if (!uri) return;
           // If user clicks a link, create a new browser tab in AntiFan Desktop
           if (window.api?.createTab) {
             window.api.createTab(uri).catch(() => {
               window.api?.openExternal?.(uri);
             });
           } else if (window.api?.openExternal) {
             window.api.openExternal(uri);
           }
         };
         const addon = new Ctor(linkHandler);
         term.loadAddon(addon);
         return addon;
       } catch (err) {
         console.warn('[antifan:terminal] WebLinks addon initialization failed:', err);
         return null;
       }
     }
     ```
   - Load addon in `getOrCreateTerminalPane` and `initSplitPane`.
   - Cleanup addon on pane disposal `try { item.webLinksAddon?.dispose(); } catch {}`.

## Validation
- Verify typecheck passes (`npm run typecheck`).
- Verify compilation copies assets properly (`npm run compile`).
