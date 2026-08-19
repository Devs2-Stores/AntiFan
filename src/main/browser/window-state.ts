/**
 * AntiFan Browser Desktop — Window State Manager
 * Persists window coordinates, dimensions, multi-monitor display placement, and maximize state.
 */
import * as fs from 'fs';
import * as path from 'path';
import { BrowserWindow, screen } from 'electron';

export interface WindowState {
  x?: number;
  y?: number;
  width: number;
  height: number;
  isMaximized: boolean;
}

export class WindowStateManager {
  private stateFilePath: string;
  private state: WindowState;
  private debounceTimer: NodeJS.Timeout | null = null;

  constructor(userDataPath: string, defaultWidth = 1360, defaultHeight = 880) {
    this.stateFilePath = path.join(userDataPath, 'window-state.json');
    this.state = this.loadState(defaultWidth, defaultHeight);
  }

  public getState(): WindowState {
    return { ...this.state };
  }

  private loadState(defaultWidth: number, defaultHeight: number): WindowState {
    try {
      if (fs.existsSync(this.stateFilePath)) {
        const raw = fs.readFileSync(this.stateFilePath, 'utf-8');
        const parsed = JSON.parse(raw);
        if (parsed && typeof parsed.width === 'number' && typeof parsed.height === 'number') {
          return {
            x: typeof parsed.x === 'number' ? parsed.x : undefined,
            y: typeof parsed.y === 'number' ? parsed.y : undefined,
            width: Math.max(700, parsed.width),
            height: Math.max(500, parsed.height),
            isMaximized: Boolean(parsed.isMaximized),
          };
        }
      }
    } catch (err) {
      console.warn('[antifan] Failed to load window state:', err);
    }

    return {
      width: defaultWidth,
      height: defaultHeight,
      isMaximized: false,
    };
  }

  public getValidBounds(): { x?: number; y?: number; width: number; height: number; isMaximized: boolean } {
    const { x, y, width, height, isMaximized } = this.state;

    if (typeof x === 'number' && typeof y === 'number') {
      try {
        const displays = screen.getAllDisplays();
        const isVisibleOnAnyDisplay = displays.some((display) => {
          const db = display.bounds;
          return (
            x >= db.x - 100 &&
            x < db.x + db.width - 100 &&
            y >= db.y - 50 &&
            y < db.y + db.height - 100
          );
        });

        if (isVisibleOnAnyDisplay) {
          return { x, y, width, height, isMaximized };
        }
      } catch {
        return { x, y, width, height, isMaximized };
      }
    }

    return { width, height, isMaximized };
  }

  public manage(window: BrowserWindow): void {
    const updateState = () => {
      try {
        if (window.isDestroyed()) return;

        const isMaximized = window.isMaximized();
        if (isMaximized) {
          this.state.isMaximized = true;
        } else if (!window.isMinimized()) {
          const bounds = window.getNormalBounds ? window.getNormalBounds() : window.getBounds();
          this.state.x = bounds.x;
          this.state.y = bounds.y;
          this.state.width = bounds.width;
          this.state.height = bounds.height;
          this.state.isMaximized = false;
        }

        this.scheduleSave();
      } catch (err) {
        console.warn('[antifan] Error updating window state:', err);
      }
    };

    window.on('resize', updateState);
    window.on('move', updateState);
    window.on('maximize', updateState);
    window.on('unmaximize', updateState);
    window.on('close', () => {
      if (this.debounceTimer) clearTimeout(this.debounceTimer);
      this.saveStateSync();
    });
  }

  private scheduleSave(): void {
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    this.debounceTimer = setTimeout(() => {
      this.saveStateSync();
    }, 500);
  }

  private saveStateSync(): void {
    try {
      const dir = path.dirname(this.stateFilePath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      fs.writeFileSync(this.stateFilePath, JSON.stringify(this.state, null, 2), 'utf-8');
    } catch (err) {
      console.warn('[antifan] Failed to save window state:', err);
    }
  }
}
