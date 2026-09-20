import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as cp from 'child_process';
import { EventEmitter } from 'events';
import { performance } from 'node:perf_hooks';
import { StorageLocations } from '../config/storage-locations';
import { isBenchmarkEnabled, recordBenchmark } from '../benchmark/telemetry';
interface HistoryItem {
  url: string;
  title: string;
  favicon?: string;
  visitCount: number;
  lastVisitTime: number; // ms timestamp
  domain?: string;
}
export class HistoryManager extends EventEmitter {
  private static instance: HistoryManager;
  private historyMap = new Map<string, HistoryItem>(); // url -> item
  private persistTimer: NodeJS.Timeout | null = null;
  private persistArmedAt = 0;
  private mutationVersion = 0;
  private isPersisting = false;
  private hasPendingPersist = false;
  private readonly MAX_HISTORY_ITEMS = 20000;
  /**
   * A page that rewrites `document.title` on a timer (a chat, a SPA, a dashboard) drives
   * `updateTitle` on every change, and a visit on every navigation. Each mutation used to arm a
   * 1 s timer that rewrote the **whole** history synchronously — measured on this host with a
   * 7 947-item store: 12.8 ms to sort+serialize 3.7 MB and 27.6 ms of `writeFileSync`, i.e. a
   * blocked main thread roughly twice a second for the length of a soak (~0.84 s of every minute,
   * 43 % of the main process's own CPU). The write is now debounced to a quiet period and capped
   * by a ceiling so a sustained churn still lands on disk at a bounded rate, and the debounced
   * write no longer serializes on the main thread.
   */
  private static readonly PERSIST_QUIET_MS = 3000;
  private static readonly PERSIST_CEILING_MS = 30000;
  private chromeUserDataPath: string;
  private isImporting = false;
  private importTimer: NodeJS.Timeout | null = null;

  private constructor() {
    super();
    this.chromeUserDataPath = path.join(
      process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'),
      'Google',
      'Chrome',
      'User Data'
    );
    this.loadHistory();
    this.importTimer = setTimeout(() => {
      this.importTimer = null;
      this.importAllChromeProfiles().catch((err) => {
        console.warn('[HistoryManager] Deferred Chrome history import note:', err);
      });
    }, 10_000);
    this.importTimer.unref?.();
  }

  public static getInstance(): HistoryManager {
    if (!HistoryManager.instance) {
      HistoryManager.instance = new HistoryManager();
    }
    return HistoryManager.instance;
  }

  private getHistoryFilePath(): string {
    const dir = process.env.ANTIFAN_CONFIG_DIR || StorageLocations.getConfigDir();
    return path.join(dir, 'browser-history.json');
  }
  private loadHistory(): void {
    const filePath = this.getHistoryFilePath();
    try {
      if (fs.existsSync(filePath)) {
        const raw = fs.readFileSync(filePath, 'utf8');
        const items: HistoryItem[] = JSON.parse(raw);
        if (Array.isArray(items)) {
          for (const item of items) {
            if (item && item.url) {
              this.historyMap.set(item.url, item);
            }
          }
        }
      }
    } catch (err) {
      console.warn('[HistoryManager] Failed to load history:', err);
    }
  }

  /** The persisted bytes: newest first, capped at the store's item ceiling. */
  private serializeHistory(): string {
    const sorted = [...this.historyMap.values()]
      .sort((a, b) => b.lastVisitTime - a.lastVisitTime)
      .slice(0, this.MAX_HISTORY_ITEMS);
    return JSON.stringify(sorted, null, 2);
  }

  /** Immediate full write on the caller's thread: the quit and clear-history paths only. */
  public persistSync(): void {
    if (this.persistTimer) {
      clearTimeout(this.persistTimer);
      this.persistTimer = null;
    }
    const filePath = this.getHistoryFilePath();
    try {
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      fs.writeFileSync(filePath, this.serializeHistory(), 'utf8');
    } catch (err) {
      console.warn('[HistoryManager] Failed to persist history:', err);
    }
  }

  private schedulePersist(): void {
    this.mutationVersion += 1;
    const now = Date.now();
    if (this.persistTimer) clearTimeout(this.persistTimer);
    if (this.persistArmedAt === 0) this.persistArmedAt = now;
    // The ceiling forces a flush when the quiet period never arrives, so a page that retitles
    // itself forever cannot hold the store unpersisted for the life of the session.
    if (now - this.persistArmedAt >= HistoryManager.PERSIST_CEILING_MS) {
      this.persistTimer = null;
      this.persistArmedAt = now;
      void this.persistAsync();
      return;
    }
    this.persistTimer = setTimeout(() => {
      this.persistTimer = null;
      this.persistArmedAt = Date.now();
      void this.persistAsync();
    }, HistoryManager.PERSIST_QUIET_MS);
    this.persistTimer.unref?.();
  }

  /**
   * The debounced write. Serialization still runs here (it is V8 work on the shared main thread),
   * but the file write and its rename are handed to the thread pool instead of blocking every
   * switch and RPC behind 3.7 MB of synchronous I/O. A snapshot that a later mutation — or a
   * quitting process's `persistSync` — has already superseded is discarded rather than renamed
   * over the fresher file.
   */
  private async persistAsync(): Promise<void> {
    if (this.isPersisting) {
      this.hasPendingPersist = true;
      return;
    }
    this.isPersisting = true;
    try {
      do {
        this.hasPendingPersist = false;
        const version = this.mutationVersion;
        const filePath = this.getHistoryFilePath();
        const tempPath = `${filePath}.tmp.${Date.now()}.${Math.random().toString(36).slice(2, 8)}`;
        const json = this.serializeHistory();
        const startedAt = performance.now();
        await fs.promises.mkdir(path.dirname(filePath), { recursive: true });
        await fs.promises.writeFile(tempPath, json, 'utf8');
        if (version === this.mutationVersion) {
          await fs.promises.rename(tempPath, filePath);
        } else {
          await fs.promises.rm(tempPath, { force: true });
        }
        const elapsedMs = performance.now() - startedAt;
        // The bytes figure costs an O(json) scan, so it is only paid when the metric is emitted.
        if (isBenchmarkEnabled()) {
          recordBenchmark({
            surface: 'history',
            name: 'persist',
            value: Number(elapsedMs.toFixed(3)),
            extra: { items: this.historyMap.size, bytes: Buffer.byteLength(json, 'utf8'), superseded: version !== this.mutationVersion },
          });
        }
      } while (this.hasPendingPersist);
    } catch (err) {
      console.warn('[HistoryManager] Failed to persist history:', err);
    } finally {
      this.isPersisting = false;
    }
  }

  public recordVisit(url: string, title?: string, favicon?: string): void {
    if (!url || url.startsWith('about:') || url.startsWith('chrome:') || url.startsWith('devtools:') || url.startsWith('javascript:')) {
      return;
    }

    try {
      const parsed = new URL(url);
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return;

      const domain = parsed.hostname;
      const existing = this.historyMap.get(url);
      const now = Date.now();

      if (existing) {
        existing.visitCount += 1;
        existing.lastVisitTime = now;
        if (title && title !== 'Untitled' && title.trim()) {
          existing.title = title.trim();
        }
        if (favicon) {
          existing.favicon = favicon;
        }
        existing.domain = domain;
      } else {
        const cleanTitle = (title && title !== 'Untitled' && title.trim()) ? title.trim() : domain;
        this.historyMap.set(url, {
          url,
          title: cleanTitle,
          favicon,
          visitCount: 1,
          lastVisitTime: now,
          domain,
        });
      }

      this.schedulePersist();
    } catch {}
  }

  public updateTitle(url: string, title: string): void {
    if (!url || !title || title === 'Untitled') return;
    const cleanTitle = title.trim();
    if (!cleanTitle) return;

    const existing = this.historyMap.get(url);
    if (existing) {
      existing.title = cleanTitle;
      this.schedulePersist();
    } else {
      this.recordVisit(url, cleanTitle);
    }
  }

  /**
   * Safe-copies and imports history from Chrome's SQLite History DB
   */
  public async importAllChromeProfiles(): Promise<number> {
    if (this.isImporting) return 0;
    this.isImporting = true;
    let total = 0;
    try {
      if (!fs.existsSync(this.chromeUserDataPath)) return 0;
      const entries = fs.readdirSync(this.chromeUserDataPath);
      for (const entry of entries) {
        if (entry === 'Default' || entry.startsWith('Profile ')) {
          const n = await this.importChromeHistory(entry);
          total += n;
        }
      }
    } catch {} finally {
      this.isImporting = false;
    }
    return total;
  }

  public async importChromeHistory(profileId = 'Default'): Promise<number> {
    const historySrc = path.join(this.chromeUserDataPath, profileId, 'History');
    if (!fs.existsSync(historySrc)) return 0;

    const tempDir = path.join(os.tmpdir(), 'antifan_chrome_hist_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6));
    fs.mkdirSync(tempDir, { recursive: true });
    const tempDb = path.join(tempDir, 'History.db');

    let count = 0;
    try {
      // Safe copy to avoid locking issues with running Chrome
      try {
        fs.copyFileSync(historySrc, tempDb);
      } catch {
        return 0;
      }

      if (!fs.existsSync(tempDb) || fs.statSync(tempDb).size < 1024) return 0;

      const pyScript = `import sqlite3, json, sys
try:
    if hasattr(sys.stdout, 'reconfigure'):
        sys.stdout.reconfigure(encoding='utf-8')
    conn = sqlite3.connect(sys.argv[1])
    cursor = conn.cursor()
    cursor.execute("SELECT url, title, visit_count, last_visit_time FROM urls ORDER BY last_visit_time DESC LIMIT 5000")
    rows = cursor.fetchall()
    res = []
    for r in rows:
        url, title, visits, last_time = r[0], r[1], r[2], r[3]
        if url and (url.startswith('http://') or url.startswith('https://')):
            unix_ms = (last_time // 1000) - 11644473600000 if last_time else 0
            res.append({'url': url, 'title': title or '', 'visitCount': visits or 1, 'lastVisitTime': max(0, unix_ms)})
    print(json.dumps(res, ensure_ascii=False))
    conn.close()
except Exception as e:
    print("[]")
`;
      const pyPath = path.join(tempDir, 'extract_hist.py');
      fs.writeFileSync(pyPath, pyScript, 'utf8');

      const rawJson = await new Promise<string>((resolve, reject) => {
        cp.execFile(
          'python',
          [pyPath, tempDb],
          { encoding: 'utf8', maxBuffer: 50 * 1024 * 1024, timeout: 8000 },
          (err, stdout) => {
            if (err) {
              reject(err);
            } else {
              resolve(typeof stdout === 'string' ? stdout : (stdout as unknown as Buffer).toString());
            }
          }
        );
      });
      const records: Array<{ url: string; title: string; visitCount: number; lastVisitTime: number }> = JSON.parse(rawJson);
      for (const r of records) {
        if (!r.url) continue;
        try {
          const domain = new URL(r.url).hostname;
          const existing = this.historyMap.get(r.url);
          if (existing) {
            existing.visitCount = Math.max(existing.visitCount, r.visitCount);
            existing.lastVisitTime = Math.max(existing.lastVisitTime, r.lastVisitTime);
            if (r.title && (!existing.title || existing.title === domain)) {
              existing.title = r.title;
            }
          } else {
            this.historyMap.set(r.url, {
              url: r.url,
              title: r.title || domain,
              visitCount: r.visitCount || 1,
              lastVisitTime: r.lastVisitTime || Date.now(),
              domain,
            });
            count++;
          }
        } catch {}
      }

      if (count > 0) {
        this.schedulePersist();
      }
    } catch (err) {
      console.warn('[HistoryManager] Chrome history import note:', err);
    } finally {
      try {
        fs.rmSync(tempDir, { recursive: true, force: true });
      } catch {}
    }
    return count;
  }

  /**
   * Searches history using multi-term frecency ranking
   */
  public search(query: string, limit = 10): HistoryItem[] {
    const q = (query || '').trim().toLowerCase();
    if (!q) return [];

    const terms = q.split(/\s+/).filter(Boolean);
    const scored: Array<{ item: HistoryItem; score: number }> = [];
    const now = Date.now();

    for (const item of this.historyMap.values()) {
      const titleLower = item.title.toLowerCase();
      const urlLower = item.url.toLowerCase();
      const domainLower = (item.domain || '').toLowerCase();

      let matchedTermsCount = 0;
      let isPrefix = false;

      for (const term of terms) {
        const matchesTerm = domainLower.includes(term) || titleLower.includes(term) || urlLower.includes(term);
        if (matchesTerm) {
          matchedTermsCount += 1;
          if (domainLower.startsWith(term) || titleLower.startsWith(term)) {
            isPrefix = true;
          }
        }
      }

      // High precision: must match all search terms
      if (matchedTermsCount < terms.length) continue;

      // Frecency score:
      // 1. Term matches weight (100 pts per term)
      // 2. Prefix bonus (60 pts)
      // 3. Visit frequency bonus (log-scaled)
      // 4. Recency bonus (decay over 30 days)
      const ageHours = Math.max(0, (now - item.lastVisitTime) / (1000 * 3600));
      const recencyWeight = Math.max(1, 100 - (ageHours / 24) * 3); // decays over ~30 days
      const frequencyWeight = Math.log10(item.visitCount + 1) * 30;

      const totalScore = (matchedTermsCount * 100) + (isPrefix ? 60 : 0) + recencyWeight + frequencyWeight;

      scored.push({ item, score: totalScore });
    }

    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, limit).map((s) => s.item);
  }

  public getHistoryItems(limit = 100): HistoryItem[] {
    return [...this.historyMap.values()]
      .sort((a, b) => b.lastVisitTime - a.lastVisitTime)
      .slice(0, limit);
  }

  public clearHistory(): void {
    this.historyMap.clear();
    this.persistSync();
  }
}
