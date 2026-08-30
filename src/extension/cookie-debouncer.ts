export interface ExtensionCookie {
  name: string;
  value: string;
  domain: string;
  path: string;
  secure: boolean;
  httpOnly: boolean;
  sameSite?: 'no_restriction' | 'lax' | 'strict' | 'unspecified';
  expirationDate?: number;
  hostOnly?: boolean;
  session?: boolean;
  storeId?: string;
}

export interface ExtensionCookieRemoval {
  name: string;
  domain: string;
  path: string;
  secure: boolean;
  storeId?: string;
}

export interface DeltaSyncBatch {
  upserted: ExtensionCookie[];
  removed: ExtensionCookieRemoval[];
}

export interface CookieChangeEvent {
  cookie: ExtensionCookie;
  removed: boolean;
  cause?: string;
}

export class CookieDebouncer {
  private flushCallback: (batch: DeltaSyncBatch) => void | Promise<void>;
  private delayMs: number;
  private maxWaitMs: number;
  private queue: Map<string, { type: 'upsert' | 'remove'; cookie: ExtensionCookie; timestamp: number }> = new Map();
  private timer: NodeJS.Timeout | number | null = null;
  private firstEventTime: number | null = null;

  constructor(
    flushCallback: (batch: DeltaSyncBatch) => void | Promise<void>,
    delayMs = 300,
    maxWaitMs = 1000
  ) {
    this.flushCallback = flushCallback;
    this.delayMs = delayMs;
    this.maxWaitMs = maxWaitMs;
  }

  public addChange(changeInfo: CookieChangeEvent): void {
    const { cookie, removed } = changeInfo;
    if (!cookie || !cookie.name) return;

    // Drop expired cookies on arrival
    const nowSec = Date.now() / 1000;
    if (!removed && typeof cookie.expirationDate === 'number' && cookie.expirationDate <= nowSec) {
      return;
    }

    const key = `${cookie.domain || ''}|${cookie.path || '/'}|${cookie.name}`;

    this.queue.set(key, {
      type: removed ? 'remove' : 'upsert',
      cookie,
      timestamp: Date.now(),
    });

    if (!this.firstEventTime) {
      this.firstEventTime = Date.now();
    }

    const elapsed = Date.now() - this.firstEventTime;
    if (elapsed >= this.maxWaitMs) {
      this.flush();
    } else {
      if (this.timer) {
        clearTimeout(this.timer as NodeJS.Timeout);
      }
      this.timer = setTimeout(() => this.flush(), this.delayMs);
    }
  }

  public flush(): void {
    if (this.timer) {
      clearTimeout(this.timer as NodeJS.Timeout);
      this.timer = null;
    }
    this.firstEventTime = null;

    if (this.queue.size === 0) return;

    const upserted: ExtensionCookie[] = [];
    const removed: ExtensionCookieRemoval[] = [];

    for (const item of this.queue.values()) {
      if (item.type === 'upsert') {
        upserted.push(item.cookie);
      } else {
        removed.push({
          name: item.cookie.name,
          domain: item.cookie.domain,
          path: item.cookie.path,
          secure: item.cookie.secure,
          storeId: item.cookie.storeId,
        });
      }
    }

    this.queue.clear();
    this.flushCallback({ upserted, removed });
  }

  public get pendingCount(): number {
    return this.queue.size;
  }
}
