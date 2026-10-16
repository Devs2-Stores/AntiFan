/**
 * Test support: a TabDevToolsHost over a one-tab mock context, with the CDP transport replaced by
 * a scripted double. Shared by the capture suites so each only states what its scenario changes.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as zlib from 'node:zlib';
import { TabDevToolsHost, type TabDevToolsContext } from '../../src/main/browser/tab-devtools-host';

process.env.ANTIFAN_RUNTIME_DIR ??= fs.mkdtempSync(path.join(os.tmpdir(), 'antifan-capture-harness-'));

/** Decodable 8-bit RGB PNG with real zlib data; every pixel is the given grey level. */
export function makeSolidPng(width: number, height: number, grey = 0): Buffer {
  const chunk = (type: string, data: Buffer): Buffer => {
    const out = Buffer.alloc(12 + data.length);
    out.writeUInt32BE(data.length, 0);
    out.write(type, 4, 'latin1');
    data.copy(out, 8);
    return out;
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  const stride = 1 + width * 3;
  const raw = Buffer.alloc(height * stride);
  if (grey !== 0) {
    for (let y = 0; y < height; y++) raw.fill(grey, y * stride + 1, (y + 1) * stride);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

export interface CdpCall {
  method: string;
  params?: Record<string, unknown>;
}

export interface CaptureHarnessOptions {
  /** CSS viewport and device pixel ratio the render-surface probe reports. */
  surface?: { dpr: number; vw: number; vh: number };
  /** Document scroll height reported to the capture. */
  documentHeight?: number;
  /** Compositor liveness the in-page rAF probe reports; defaults to alive. */
  frameAlive?: () => boolean;
  /** Extra answers for in-page scripts, consulted before the defaults. */
  onScript?: (script: string) => unknown;
  /** Answer for Page.captureScreenshot; defaults to a solid PNG sized from the requested clip. */
  onCapture?: (params: Record<string, unknown>) => { data?: string } | Promise<{ data?: string }>;
}

export function createCaptureHarness(options: CaptureHarnessOptions = {}) {
  const surface = options.surface ?? { dpr: 1, vw: 200, vh: 600 };
  const documentHeight = options.documentHeight ?? 1200;
  const scripts: string[] = [];
  const calls: CdpCall[] = [];
  const switched: string[] = [];

  const mockWc = {
    id: 1,
    isDestroyed: () => false,
    getZoomFactor: () => 1,
    executeJavaScript: async (script: string) => {
      scripts.push(script);
      const custom = options.onScript?.(script);
      if (custom !== undefined) return custom;
      if (script.includes('requestAnimationFrame') && script.includes('withResolvers')) {
        return options.frameAlive ? options.frameAlive() : true;
      }
      return undefined;
    },
    capturePage: async () => ({ isEmpty: () => true, toPNG: () => Buffer.alloc(0), toBitmap: () => Buffer.alloc(0) }),
    invalidate: () => {},
  };

  let activeTabId = 'tab-1';
  const makeTab = (id: string) => ({
    state: { id, url: 'https://example.com/store', title: id, isLoading: false, canGoBack: false, canGoForward: false, crashed: false, zoomFactor: 1, devicePresetId: 'responsive' },
    focusedPane: 'desktop',
    view: { webContents: mockWc },
  });
  const tabs = new Map<string, ReturnType<typeof makeTab>>([['tab-1', makeTab('tab-1')], ['tab-2', makeTab('tab-2')]]);

  const ctx: TabDevToolsContext = {
    getTabWebContents: () => mockWc as never,
    getTabRecord: (tabId) => tabs.get(tabId) as never,
    getActiveTabId: () => activeTabId,
    getAllTabs: () => tabs.entries() as never,
    broadcastState: () => {},
    getTabTerminalSession: () => 'session-1',
    visibleTerminalSessions: () => [],
    resolveTargetWorkspace: () => 'E:/Work/project',
    resolveAnnotationWorkspace: () => 'E:/Work/project',
    createTab: () => 'tab-1',
    withTabAgentWorking: async (_tabId, action) => action(),
    switchTab: (tabId) => {
      switched.push(tabId);
      activeTabId = tabId;
      return true;
    },
  };

  const devTools = new TabDevToolsHost(ctx);
  (devTools as unknown as { sendCdpCommand: (wc: unknown, method: string, params?: Record<string, unknown>) => Promise<unknown> }).sendCdpCommand = async (_wc, method, params) => {
    calls.push({ method, params });
    if (method === 'Runtime.evaluate') {
      const expression = typeof params?.expression === 'string' ? params.expression : '';
      if (expression.includes('devicePixelRatio')) return { result: { value: surface } };
      if (expression.includes('scrollHeight')) return { result: { value: documentHeight } };
    }
    if (method === 'Page.captureScreenshot') {
      if (options.onCapture) return options.onCapture(params ?? {});
      const clip = params?.clip as { width: number; height: number } | undefined;
      const width = Math.round((clip?.width ?? surface.vw) * surface.dpr);
      const height = Math.round((clip?.height ?? surface.vh) * surface.dpr);
      return { data: makeSolidPng(width, height).toString('base64') };
    }
    return {};
  };

  return { devTools, ctx, mockWc, calls, scripts, switched, setActiveTab: (id: string) => { activeTabId = id; } };
}
