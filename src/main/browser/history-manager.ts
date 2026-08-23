/**
 * AntiFan Browser Desktop - Intelligent History & Omnibox Suggestion Engine
 * Captures all navigations (including SPAs), merges native Chrome profile history,
 * and provides high-precision frecency search for the Omnibox.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as cp from 'child_process';
import { EventEmitter } from 'events';

export interface HistoryItem {
  url: string;
  title: string;
  favicon?: string;
  visitCount: number;
  lastVisitTime: number; // ms timestamp
  domain?: string;
}

export interface SuggestionResult {
  type: 'tab' | 'bookmark' | 'history' | 'search';
  text: string;
  url?: string;
  tabId?: string;
  subText?: string;
}

export class HistoryManager extends EventEmitter {
  private static instance: HistoryManager;
  private historyMap = new Map<string, HistoryItem>(); // url -> item
  private persistTimer: NodeJS.Timeout | null = null;
  private readonly MAX_HISTORY_ITEMS = 20000;
  private chromeUserDataPath: string;

  private constructor() {
    super();
    this.chromeUserDataPath = path.join(
      process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'),
      'Google',
      'Chrome',
      'User Data'
    );
    this.loadHistory();
    this.importAllChromeProfiles().catch(() => {});
  }

  public static getInstance(): HistoryManager {
    if (!HistoryManager.instance) {
      HistoryManager.instance = new HistoryManager();
    }
    return HistoryManager.instance;
  }

  private getHistoryFilePath(): string {
    const dir = process.env.ANTIFAN_CONFIG_DIR || path.join(os.homedir(), '.antifan');
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

  public persistSync(): void {
    if (this.persistTimer) {
      clearTimeout(this.persistTimer);
      this.persistTimer = null;
    }
    const filePath = this.getHistoryFilePath();
    try {
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      const sorted = [...this.historyMap.values()]
        .sort((a, b) => b.lastVisitTime - a.lastVisitTime)
        .slice(0, this.MAX_HISTORY_ITEMS);
      fs.writeFileSync(filePath, JSON.stringify(sorted, null, 2), 'utf8');
    } catch (err) {
      console.warn('[HistoryManager] Failed to persist history:', err);
    }
  }

  private schedulePersist(): void {
    if (this.persistTimer) return;
    this.persistTimer = setTimeout(() => {
      this.persistTimer = null;
      this.persistSync();
    }, 1000);
    this.persistTimer.unref?.();
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
    } catch {}
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

      const rawJson = cp.execFileSync('python', [pyPath, tempDb], { encoding: 'utf8', maxBuffer: 50 * 1024 * 1024, timeout: 8000 }).toString();
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
