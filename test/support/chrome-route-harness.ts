/**
 * Test harness for the declarative Chrome IPC route table.
 *
 * Drives the real NativeTabHost.CHROME_ROUTES table through a fake registrar
 * and sender resolver without requiring Electron runtime or live browser windows.
 */
import type { IpcMainEvent, IpcMainInvokeEvent, WebContents } from 'electron';
import { NativeTabHost } from '../../src/main/browser/native-tab-host';
import {
  installChromeIpcOnce,
  setChromeSenderResolver,
  type ChromeIpcRegistrar,
  type IpcRoute,
  type RoutedSender,
  type RoutedSurface,
} from '../../src/main/browser/ipc-router';

export interface ChromeRouteHarness {
  /** Channels registered by installing the real route table into this harness. */
  registeredChannels(): string[];
  /** Invoke one installed channel the way a chrome renderer would, with a top-level frame. */
  invoke(channel: string, ...args: unknown[]): unknown;
  /** Invoke with a caller-supplied event (for tests that need a subframe or a foreign sender). */
  invokeWithEvent(channel: string, event: unknown, ...args: unknown[]): unknown;
  /** The webContents the harness reports as the sender for `invoke`. */
  readonly sender: unknown;
}

export interface ChromeRouteHarnessOptions {
  host: NativeTabHost;
  routes?: readonly IpcRoute[];
  /** Omit to install a resolver that refuses every sender (when autoSurface is false). */
  surface?: RoutedSurface;
  /**
   * Whether to auto-resolve the sender surface from the route table when surface is omitted.
   * Defaults to true so createChromeRouteHarness({ host }) resolves to the channel's declared surface.
   * Set to false to install a resolver that refuses every sender.
   */
  autoSurface?: boolean;
  /** Explicitly refuse all senders. */
  refuseSender?: boolean;
}

type Listener = (event: unknown, ...args: unknown[]) => unknown;

// Process-level registrar and handler storage: installChromeIpcOnce only installs once per process.
const processHandlers = new Map<string, Listener>();
const processRegistrar: ChromeIpcRegistrar = {
  handle(channel: string, listener: (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown) {
    processHandlers.set(channel, listener as unknown as Listener);
  },
  on(channel: string, listener: (event: IpcMainEvent, ...args: unknown[]) => void) {
    processHandlers.set(channel, listener as unknown as Listener);
  },
};

let nextSenderId = 1000;
function createFakeWebContents(): WebContents {
  const id = nextSenderId++;
  return {
    id,
    isDestroyed: () => false,
    send: () => {},
  } as unknown as WebContents;
}

let activeChannel: string | undefined;

export function createChromeRouteHarness(options: ChromeRouteHarnessOptions): ChromeRouteHarness {
  const routes = options.routes ?? NativeTabHost.CHROME_ROUTES;
  installChromeIpcOnce(routes, processRegistrar);

  const harnessSender = createFakeWebContents();

  // The fake host is a test double; cast with as unknown as NativeTabHost (the harness never touches host internals).
  // Note: The surface gate itself is covered behaviourally by test/main/ipc-router.test.ts.
  setChromeSenderResolver((sender: WebContents): RoutedSender | undefined => {
    if (options.refuseSender || (options.autoSurface === false && options.surface === undefined)) {
      return undefined;
    }

    const isHarnessSender = sender === harnessSender;
    const hostWithTabs = options.host as unknown as { findTabByWebContents?: (s: unknown) => unknown };
    const isHostTab = Boolean(hostWithTabs?.findTabByWebContents?.(sender));

    if (!isHarnessSender && !isHostTab) {
      return undefined;
    }

    let surface = options.surface;
    if (!surface && activeChannel) {
      // Look up the surface the table declares for the channel being invoked.
      const route = routes.find((r) => r.channel === activeChannel);
      if (route) {
        surface = Array.isArray(route.surface) ? route.surface[0] : route.surface;
      }
    }
    if (!surface) {
      surface = 'toolbar';
    }

    return {
      host: options.host,
      surface,
    };
  });

  return {
    get sender() {
      return harnessSender;
    },

    registeredChannels(): string[] {
      return routes.map((r) => r.channel);
    },

    invoke(channel: string, ...args: unknown[]): unknown {
      const listener = processHandlers.get(channel);
      if (!listener) {
        throw new Error(`No chrome route registered for ${channel}`);
      }
      const event = {
        sender: harnessSender,
        senderFrame: {
          url: 'file:///E:/Work/apps/AntiFan/src/renderer/toolbar.html',
          parent: null,
        },
      };
      activeChannel = channel;
      try {
        return listener(event, ...args);
      } finally {
        activeChannel = undefined;
      }
    },

    invokeWithEvent(channel: string, event: unknown, ...args: unknown[]): unknown {
      const listener = processHandlers.get(channel);
      if (!listener) {
        throw new Error(`No chrome route registered for ${channel}`);
      }
      activeChannel = channel;
      try {
        return listener(event, ...args);
      } finally {
        activeChannel = undefined;
      }
    },
  };
}
