/**
 * AntiFan Browser Desktop — Tab Bookmarks Manager
 * Manages bookmark persistence, suggestions search, and CRUD operations.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import { app } from 'electron';

export interface BookmarkItem {
  id: string;
  url: string;
  title: string;
  createdAt: number;
}

export interface BookmarkSuggestion {
  type: 'bookmark';
  text: string;
  url: string;
  subText: string;
}

export class TabBookmarksManager {
  private bookmarks: BookmarkItem[] = [];
  private readonly storagePath: string;

  constructor(customStoragePath?: string) {
    this.storagePath = customStoragePath || path.join(app.getPath('userData'), 'bookmarks.json');
    this.loadPersistedBookmarks();
  }

  public getBookmarks(): BookmarkItem[] {
    return [...this.bookmarks];
  }

  public setBookmarks(bookmarks: BookmarkItem[]): void {
    this.bookmarks = Array.isArray(bookmarks) ? [...bookmarks] : [];
    this.savePersistedBookmarks();
  }

  public addBookmark(url: string, title?: string): { ok: boolean; bookmarks: BookmarkItem[] } {
    const trimmedUrl = url.trim();
    if (!trimmedUrl) return { ok: false, bookmarks: this.getBookmarks() };

    const existing = this.bookmarks.find((b) => b.url === trimmedUrl);
    if (!existing) {
      this.bookmarks.push({
        id: trimmedUrl,
        title: (title || trimmedUrl).trim(),
        url: trimmedUrl,
        createdAt: Date.now(),
      });
      this.savePersistedBookmarks();
    }
    return { ok: true, bookmarks: this.getBookmarks() };
  }

  public removeBookmark(url: string): { ok: boolean; bookmarks: BookmarkItem[] } {
    const initialLength = this.bookmarks.length;
    this.bookmarks = this.bookmarks.filter((b) => b.url !== url);
    if (this.bookmarks.length !== initialLength) {
      this.savePersistedBookmarks();
    }
    return { ok: true, bookmarks: this.getBookmarks() };
  }

  public toggleBookmark(url: string, title?: string): { isBookmarked: boolean; bookmarks: BookmarkItem[] } {
    const existingIndex = this.bookmarks.findIndex((b) => b.url === url);
    if (existingIndex >= 0) {
      this.bookmarks.splice(existingIndex, 1);
      this.savePersistedBookmarks();
      return { isBookmarked: false, bookmarks: this.getBookmarks() };
    } else {
      this.bookmarks.push({
        id: randomUUID(),
        url,
        title: title || url,
        createdAt: Date.now(),
      });
      this.savePersistedBookmarks();
      return { isBookmarked: true, bookmarks: this.getBookmarks() };
    }
  }

  public isBookmarked(url: string): boolean {
    return this.bookmarks.some((b) => b.url === url);
  }

  public getTopBookmarkSuggestions(limit = 4): BookmarkSuggestion[] {
    return this.bookmarks.slice(0, limit).map((b) => ({
      type: 'bookmark' as const,
      text: b.title,
      url: b.url,
      subText: 'Dấu trang',
    }));
  }

  public searchBookmarks(query: string, seenUrls: Set<string>): BookmarkSuggestion[] {
    const lower = query.toLowerCase();
    const results: BookmarkSuggestion[] = [];
    for (const b of this.bookmarks) {
      if (b.title.toLowerCase().includes(lower) || b.url.toLowerCase().includes(lower)) {
        if (!seenUrls.has(b.url)) {
          seenUrls.add(b.url);
          results.push({
            type: 'bookmark',
            text: b.title,
            url: b.url,
            subText: 'Dấu trang',
          });
        }
      }
    }
    return results;
  }

  public loadPersistedBookmarks(): void {
    try {
      if (fs.existsSync(this.storagePath)) {
        const raw = fs.readFileSync(this.storagePath, 'utf8');
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed) && parsed.length > 0) {
          this.bookmarks = parsed;
        }
      }
    } catch {}
  }

  public savePersistedBookmarks(): void {
    try {
      fs.writeFileSync(this.storagePath, JSON.stringify(this.bookmarks, null, 2), 'utf8');
    } catch {}
  }
}
