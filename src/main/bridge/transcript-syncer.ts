/**
 * AntiFan Browser Desktop — Antigravity Live Transcript Syncer
 * Automatically discovers active Antigravity IDE conversation sessions in ~/.gemini/antigravity-ide/brain/
 * and streams real-time messages, thinking steps, and tool calls directly into the Sidebar Chat.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { EventEmitter } from 'node:events';
import { ChatMessage, SessionInfo } from '../../shared/contracts';

export class TranscriptSyncer extends EventEmitter {
  private brainDir: string;
  private currentSessionId: string = '';
  private currentTranscriptPath: string = '';
  private fileWatcher: fs.FSWatcher | null = null;
  private lastProcessedLine: number = 0;
  private pollInterval: NodeJS.Timeout | null = null;
  private isAutoFollow: boolean = true;

  constructor() {
    super();
    this.brainDir = path.join(os.homedir(), '.gemini', 'antigravity-ide', 'brain');
  }

  public start(): void {
    this.findAndBindActiveSession();

    // Check periodically for session updates, new lines, and active steps
    this.pollInterval = setInterval(() => {
      if (this.isAutoFollow) {
        this.findAndBindActiveSession();
      } else {
        this.readNewTranscriptLines();
      }
    }, 1000);
  }

  public getActiveSessionId(): string {
    return this.currentSessionId;
  }

  private resolveTranscriptPath(sessionPath: string): string {
    const fullLog = path.join(sessionPath, '.system_generated', 'logs', 'transcript_full.jsonl');
    if (fs.existsSync(fullLog)) return fullLog;
    return path.join(sessionPath, '.system_generated', 'logs', 'transcript.jsonl');
  }

  public getAvailableSessions(): SessionInfo[] {
    if (!fs.existsSync(this.brainDir)) return [];

    try {
      const entries = fs.readdirSync(this.brainDir, { withFileTypes: true });
      const sessions: SessionInfo[] = [];
      const now = Date.now();

      for (const e of entries) {
        if (!e.isDirectory() || e.name === 'tempmediaStorage' || e.name === '.system_generated') continue;

        const sessionPath = path.join(this.brainDir, e.name);
        const transcriptPath = this.resolveTranscriptPath(sessionPath);
        let mtime = 0;
        let title = '';
        let messageCount = 0;
        let isRecentlyActive = false;

        if (fs.existsSync(transcriptPath)) {
          const stats = fs.statSync(transcriptPath);
          mtime = stats.mtimeMs;
          title = this.extractSessionTitle(transcriptPath, sessionPath, e.name);
          isRecentlyActive = (now - mtime) < 25000;
          try {
            const raw = fs.readFileSync(transcriptPath, 'utf8');
            messageCount = raw.split('\n').filter(l => l.trim().length > 0).length;
          } catch {}
        } else {
          mtime = fs.statSync(sessionPath).mtimeMs;
          title = `Session (${e.name.slice(0, 8)}...)`;
        }

        // Project Group Extraction
        let projectGroup = 'General';
        const lowerTitle = title.toLowerCase();
        if (lowerTitle.includes('mnbakery')) projectGroup = 'Mnbakery';
        else if (lowerTitle.includes('seahorse')) projectGroup = 'Seahorse';
        else if (lowerTitle.includes('sunriseplus')) projectGroup = 'Sunriseplus';
        else if (lowerTitle.includes('antigravity-browser-desktop') || lowerTitle.includes('antifan')) projectGroup = 'Antigravity Desktop';
        else if (lowerTitle.includes('antigravity-browser') || lowerTitle.includes('extension')) projectGroup = 'Antigravity Extension';
        else if (lowerTitle.includes('haravan')) projectGroup = 'Haravan Themes';
        else if (lowerTitle.includes('sapo')) projectGroup = 'Sapo Themes';
        else if (lowerTitle.includes('shopify')) projectGroup = 'Shopify Themes';

        sessions.push({
          id: e.name,
          title,
          active: e.name === this.currentSessionId,
          mtime,
          messageCount,
          status: isRecentlyActive ? 'running' : 'done',
          projectGroup,
        });
      }

      return sessions.sort((a, b) => b.mtime - a.mtime);
    } catch (err) {
      console.error('[antifan syncer] Failed to list sessions:', err);
      return [];
    }
  }

  private customTitles: Map<string, string> = new Map();

  public renameSession(sessionId: string, newTitle: string): boolean {
    const trimmed = newTitle.trim();
    if (!trimmed) return false;
    const targetId = sessionId === 'auto' ? this.currentSessionId : sessionId;
    if (!targetId) return false;

    this.customTitles.set(targetId, trimmed);
    const sessionPath = path.join(this.brainDir, targetId);
    if (fs.existsSync(sessionPath)) {
      try {
        fs.writeFileSync(path.join(sessionPath, 'session_title.txt'), trimmed, 'utf8');
      } catch {}
    }
    this.emit('sessions-updated', this.getAvailableSessions());
    return true;
  }

  public deleteSession(sessionId: string): boolean {
    if (!sessionId || sessionId === 'auto') return false;
    const targetSessionPath = path.join(this.brainDir, sessionId);
    if (!fs.existsSync(targetSessionPath)) return false;

    try {
      if (this.currentSessionId === sessionId) {
        if (this.fileWatcher) {
          try {
            this.fileWatcher.close();
          } catch {}
          this.fileWatcher = null;
        }
        this.currentSessionId = '';
        this.currentTranscriptPath = '';
        this.lastProcessedLine = 0;
      }

      fs.rmSync(targetSessionPath, { recursive: true, force: true });

      if (this.isAutoFollow) {
        this.findAndBindActiveSession();
      }
      return true;
    } catch (err) {
      console.error(`[antifan syncer] Failed to delete session ${sessionId}:`, err);
      return false;
    }
  }

  private extractSessionTitle(transcriptPath: string, sessionPath: string, dirName: string): string {
    // 1. Try reading implementation_plan.md first header
    try {
      const planFile = path.join(sessionPath, 'implementation_plan.md');
      if (fs.existsSync(planFile)) {
        const planContent = fs.readFileSync(planFile, 'utf8');
        const match = planContent.match(/^#\s+(.+)$/m);
        if (match && match[1]) {
          return match[1].trim();
        }
      }
    } catch {}

    // 2. Try extracting from first USER_INPUT in transcript
    try {
      const content = fs.readFileSync(transcriptPath, 'utf8');
      const lines = content.split('\n');
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const parsed = JSON.parse(line);
          if (parsed.type === 'USER_INPUT' && parsed.content) {
            const match = parsed.content.match(/<USER_REQUEST>([\s\S]*?)<\/USER_REQUEST>/);
            const userText = match ? match[1].trim() : parsed.content.trim();
            if (userText && !userText.startsWith('{{ CHECKPOINT') && !userText.startsWith('The following is a <SYSTEM_MESSAGE>')) {
              const firstLine = userText.split('\n')[0]!.trim();
              return firstLine.length > 50 ? firstLine.slice(0, 47) + '...' : firstLine;
            }
          }
        } catch {}
      }
    } catch {}

    return `Session (${dirName.slice(0, 8)}...)`;
  }

  public switchSession(sessionId: string): boolean {
    if (sessionId === 'auto') {
      this.isAutoFollow = true;
      this.findAndBindActiveSession();
      return true;
    }

    this.isAutoFollow = false;
    const targetSessionPath = path.join(this.brainDir, sessionId);
    const targetTranscript = this.resolveTranscriptPath(targetSessionPath);

    if (fs.existsSync(targetTranscript)) {
      this.bindSession(sessionId, targetTranscript);
      this.emit('session-switched', sessionId);
      return true;
    }
    return false;
  }

  private findAndBindActiveSession(): void {
    if (!fs.existsSync(this.brainDir)) return;

    try {
      const entries = fs.readdirSync(this.brainDir, { withFileTypes: true });
      const sessionDirs = entries
        .filter((e) => e.isDirectory() && e.name !== 'tempmediaStorage' && e.name !== '.system_generated')
        .map((e) => {
          const fullPath = path.join(this.brainDir, e.name);
          const transcriptFile = this.resolveTranscriptPath(fullPath);
          let mtime = 0;
          if (fs.existsSync(transcriptFile)) {
            mtime = fs.statSync(transcriptFile).mtimeMs;
          } else {
            mtime = fs.statSync(fullPath).mtimeMs;
          }
          return { id: e.name, fullPath, transcriptFile, mtime };
        })
        .sort((a, b) => b.mtime - a.mtime);

      if (sessionDirs.length > 0) {
        const top = sessionDirs[0]!;
        if (top.id !== this.currentSessionId || top.transcriptFile !== this.currentTranscriptPath) {
          this.bindSession(top.id, top.transcriptFile);
        } else {
          this.readNewTranscriptLines();
        }
      }
    } catch (err) {
      console.error('[antifan syncer] Failed to find active session:', err);
    }
  }

  private bindSession(sessionId: string, transcriptPath: string): void {
    this.currentSessionId = sessionId;
    this.currentTranscriptPath = transcriptPath;

    if (this.fileWatcher) {
      try {
        this.fileWatcher.close();
      } catch {}
      this.fileWatcher = null;
    }

    let initialMessages: ChatMessage[] = [];
    if (fs.existsSync(transcriptPath)) {
      try {
        const content = fs.readFileSync(transcriptPath, 'utf8');
        const lines = content.split('\n').filter((l) => l.trim().length > 0);
        this.lastProcessedLine = lines.length; // Set to end so we don't re-emit old lines individually

        for (let i = Math.max(0, lines.length - 40); i < lines.length; i++) {
          const parsed = this.parseTranscriptLine(lines[i]!, i);
          if (parsed) initialMessages.push(parsed);
        }
      } catch {
        this.lastProcessedLine = 0;
      }

      try {
        const logDir = path.dirname(transcriptPath);
        if (fs.existsSync(logDir)) {
          this.fileWatcher = fs.watch(logDir, (_eventType, filename) => {
            if (!filename || filename.includes('transcript')) {
              this.readNewTranscriptLines();
            }
          });
        }
      } catch {}
    }

    this.emit('session-changed', {
      sessionId,
      messages: initialMessages,
    });
  }

  public getRecentMessages(limit = 40): ChatMessage[] {
    if (!this.currentTranscriptPath || !fs.existsSync(this.currentTranscriptPath)) {
      this.findAndBindActiveSession();
    }
    if (!this.currentTranscriptPath || !fs.existsSync(this.currentTranscriptPath)) {
      return [];
    }

    try {
      const content = fs.readFileSync(this.currentTranscriptPath, 'utf8');
      const lines = content.split('\n').filter((l) => l.trim().length > 0);
      const messages: ChatMessage[] = [];

      for (let i = 0; i < lines.length; i++) {
        const parsed = this.parseTranscriptLine(lines[i]!, i);
        if (parsed) {
          messages.push(parsed);
        }
      }

      return messages.slice(-limit);
    } catch {
      return [];
    }
  }

  private readNewTranscriptLines(): void {
    if (this.currentSessionId) {
      const optimal = this.resolveTranscriptPath(path.join(this.brainDir, this.currentSessionId));
      if (optimal !== this.currentTranscriptPath && fs.existsSync(optimal)) {
        this.currentTranscriptPath = optimal;
      }
    }
    if (!this.currentTranscriptPath || !fs.existsSync(this.currentTranscriptPath)) return;

    try {
      const content = fs.readFileSync(this.currentTranscriptPath, 'utf8');
      const lines = content.split('\n').filter((l) => l.trim().length > 0);

      if (lines.length > this.lastProcessedLine) {
        for (let i = this.lastProcessedLine; i < lines.length; i++) {
          const parsed = this.parseTranscriptLine(lines[i]!, i);
          if (parsed) {
            this.emit('message', parsed);
          }
        }
        this.lastProcessedLine = lines.length;
      }
    } catch {}
  }

  private parseTranscriptLine(lineStr: string, index: number): ChatMessage | null {
    try {
      const obj = JSON.parse(lineStr);
      if (!obj || typeof obj !== 'object') return null;

      // Extract System Auto-proceed Messages
      if (obj.type === 'SYSTEM_MESSAGE' || (obj.type === 'USER_INPUT' && typeof obj.content === 'string' && obj.content.includes('<SYSTEM_MESSAGE>'))) {
        const raw = obj.content || '';
        if (raw.includes('automatically approved') || raw.includes('Proceed to execution')) {
          return {
            id: `msg-${obj.step_index ?? index}`,
            role: 'system',
            text: '⚡ **Auto-proceeded with Implementation Plan**',
            timestamp: Date.now(),
          };
        }
        return null;
      }

      // Extract User Input
      if (obj.type === 'USER_INPUT') {
        let content = obj.content || '';
        const match = content.match(/<USER_REQUEST>([\s\S]*?)<\/USER_REQUEST>/);
        if (match) {
          content = match[1].trim();
        }
        if (!content || content.startsWith('{{ CHECKPOINT') || content.startsWith('The following is a <SYSTEM_MESSAGE>')) {
          return null;
        }

        return {
          id: `msg-${obj.step_index ?? index}`,
          role: 'user',
          text: content,
          timestamp: Date.now(),
        };
      }

      // Extract Assistant Planner Response
      if (obj.type === 'PLANNER_RESPONSE') {
        const content = obj.content || '';
        const toolCalls = (obj.tool_calls || []).map((t: any, idx: number) => ({
          id: `tool-${idx}`,
          name: t.tool_name || t.name || 'tool',
          args: t.arguments || t.args,
          status: 'done',
        }));

        if (!content && toolCalls.length === 0) return null;

        return {
          id: `msg-${obj.step_index ?? index}`,
          role: 'assistant',
          text: content,
          thinking: obj.thought || obj.thinking || undefined,
          toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
          timestamp: Date.now(),
        };
      }

      return null;
    } catch {
      return null;
    }
  }

  public dispose(): void {
    if (this.pollInterval) {
      clearInterval(this.pollInterval);
      this.pollInterval = null;
    }
    if (this.fileWatcher) {
      try {
        this.fileWatcher.close();
      } catch {}
      this.fileWatcher = null;
    }
  }
}
