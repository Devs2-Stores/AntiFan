/**
 * AntiFan Browser Desktop — Antigravity Live Transcript Syncer
 * Automatically discovers active Antigravity IDE conversation sessions in ~/.gemini/antigravity-ide/brain/
 * and streams real-time messages, thinking steps, and tool calls directly into the Sidebar Chat.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import * as cp from 'node:child_process';
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
  private lastTranscriptMtime: number = 0;
  private lastTranscriptSize: number = 0;
  private watchDebounceTimer: NodeJS.Timeout | null = null;
  private cachedAvailableSessions: SessionInfo[] = [];
  private lastSessionsFetchTime: number = 0;
  private lastBrainDirMtime: number = 0;

  constructor(customBrainDir?: string) {
    super();
    this.brainDir = customBrainDir || path.join(os.homedir(), '.gemini', 'antigravity-ide', 'brain');
  }

  public start(): void {
    this.findAndBindActiveSession();

    // High-responsiveness 500ms stat check (0.01ms CPU when idle due to mtime/size guards)
    let tickCount = 0;
    this.pollInterval = setInterval(() => {
      tickCount++;
      // Only check active session switch every 6 ticks (3 seconds)
      if (this.isAutoFollow && tickCount % 6 === 0) {
        this.findAndBindActiveSession();
      }
      this.readNewTranscriptLines();
    }, 500);
  }

  public getActiveSessionId(): string {
    return this.currentSessionId;
  }

  private isArchivedSession(sessionPath: string, name: string, title?: string): boolean {
    const lowerName = name.toLowerCase();
    if (
      lowerName === 'tempmediastorage' ||
      lowerName === '.system_generated' ||
      lowerName === 'archive' ||
      lowerName === '_archive' ||
      lowerName.startsWith('archive_') ||
      lowerName.endsWith('_archived') ||
      lowerName.startsWith('.')
    ) {
      return true;
    }

    if (
      fs.existsSync(path.join(sessionPath, '.archived')) ||
      fs.existsSync(path.join(sessionPath, 'archived.json')) ||
      fs.existsSync(path.join(sessionPath, 'archive.json'))
    ) {
      return true;
    }

    const titleFile = path.join(sessionPath, 'session_title.txt');
    if (fs.existsSync(titleFile)) {
      try {
        const text = fs.readFileSync(titleFile, 'utf8').toLowerCase();
        if (text.includes('[archived]') || text.includes('(archived)') || text.includes('status: archived')) {
          return true;
        }
      } catch {}
    }

    if (title) {
      const lowerTitle = title.toLowerCase();
      if (lowerTitle.includes('[archived]') || lowerTitle.includes('(archived)') || lowerTitle.includes('status: archived')) {
        return true;
      }
    }

    const metaFile = path.join(sessionPath, 'metadata.json');
    if (fs.existsSync(metaFile)) {
      try {
        const meta = JSON.parse(fs.readFileSync(metaFile, 'utf8'));
        if (meta.archived === true || meta.status === 'archived' || meta.isArchived === true) {
          return true;
        }
      } catch {}
    }

    return false;
  }

  public getAvailableSessions(): SessionInfo[] {
    if (!fs.existsSync(this.brainDir)) return [];

    const now = Date.now();
    try {
      const brainStats = fs.statSync(this.brainDir);
      if (
        this.cachedAvailableSessions.length > 0 &&
        brainStats.mtimeMs === this.lastBrainDirMtime &&
        now - this.lastSessionsFetchTime < 3000
      ) {
        return this.cachedAvailableSessions;
      }
      this.lastBrainDirMtime = brainStats.mtimeMs;
      this.lastSessionsFetchTime = now;

      const entries = fs.readdirSync(this.brainDir, { withFileTypes: true });
      const sessions: SessionInfo[] = [];

      for (const e of entries) {
        if (!e.isDirectory()) continue;

        const sessionPath = path.join(this.brainDir, e.name);
        if (this.isArchivedSession(sessionPath, e.name)) continue;

        const transcriptPath = path.join(sessionPath, '.system_generated', 'logs', 'transcript.jsonl');
        let mtime = 0;
        let title = '';
        let messageCount = 0;
        let isRunning = false;

        if (fs.existsSync(transcriptPath)) {
          const stats = fs.statSync(transcriptPath);
          mtime = stats.mtimeMs;
          title = this.extractSessionTitle(transcriptPath, sessionPath, e.name);
          if (this.isArchivedSession(sessionPath, e.name, title)) continue;
          try {
            const raw = fs.readFileSync(transcriptPath, 'utf8').trim();
            const lines = raw.split('\n').filter((l) => l.trim().length > 0);
            messageCount = lines.length;
            if (lines.length > 0) {
              const lastLine = lines[lines.length - 1]!;
              const lastObj = JSON.parse(lastLine);
              if (lastObj.type === 'USER_INPUT') {
                // User input submitted, agent is planning/working
                isRunning = (now - mtime) < 180000;
              } else if (lastObj.type === 'PLANNER_RESPONSE') {
                const hasText = typeof lastObj.content === 'string' && lastObj.content.trim().length > 0;
                const hasTools = Array.isArray(lastObj.tool_calls) && lastObj.tool_calls.length > 0;
                if (hasTools) {
                  // Agent called tools: actively running tools in background!
                  isRunning = (now - mtime) < 180000;
                } else if (hasText) {
                  // Assistant provided final conversational response with NO pending tools -> DONE
                  isRunning = false;
                } else {
                  isRunning = (now - mtime) < 30000;
                }
              } else {
                // Tool result / system message / background task update: agent is in middle of work cycle
                isRunning = (now - mtime) < 120000;
              }
            }
          } catch {}
        } else {
          mtime = fs.statSync(sessionPath).mtimeMs;
          title = `Session (${e.name.slice(0, 8)}...)`;
          if (this.isArchivedSession(sessionPath, e.name, title)) continue;
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

        const status: 'running' | 'done' | 'idle' = isRunning ? 'running' : 'done';

        const workspacePath = this.getSessionWorkspace(e.name);

        sessions.push({
          id: e.name,
          title: title || `Session ${e.name.slice(0, 8)}`,
          mtime,
          active: e.name === this.currentSessionId,
          status,
          messageCount,
          projectGroup,
          workspacePath,
        });
      }

      return sessions.sort((a, b) => b.mtime - a.mtime);
    } catch {
      return [];
    }
  }

  private customTitles: Map<string, string> = new Map();
  private sessionWorkspaces: Map<string, string> = new Map();

  private findWorkspaceRoot(startPath: string): string {
    let cur = startPath;
    if (fs.existsSync(cur) && fs.statSync(cur).isFile()) {
      cur = path.dirname(cur);
    }
    while (cur && cur !== path.dirname(cur)) {
      if (
        fs.existsSync(path.join(cur, 'package.json')) ||
        fs.existsSync(path.join(cur, 'config', 'settings_data.json')) ||
        fs.existsSync(path.join(cur, '.antigravity')) ||
        fs.existsSync(path.join(cur, '.git'))
      ) {
        return cur;
      }
      const parent = path.dirname(cur);
      const parentBase = path.basename(parent).toLowerCase();
      if (parentBase === 'customizes' || parentBase === 'themes' || parentBase === 'apps') {
        return cur;
      }
      cur = parent;
    }
    return startPath;
  }

  public getSessionWorkspace(id: string): string | undefined {
    if (!id || id === 'auto') return undefined;
    if (this.sessionWorkspaces.has(id)) {
      return this.sessionWorkspaces.get(id);
    }

    const sessionPath = path.join(this.brainDir, id);
    const transcriptPath = path.join(sessionPath, '.system_generated', 'logs', 'transcript.jsonl');
    if (fs.existsSync(transcriptPath)) {
      try {
        const text = fs.readFileSync(transcriptPath, 'utf8');
        // 1. Check workspace mapping: e:\Work\... -> Devs2-Stores...
        const matchWs = text.match(/([a-zA-Z]:\\[^\r\n<>"\t]+?)\s*->\s*[^\r\n<>"\t]+/);
        if (matchWs && matchWs[1]) {
          const ws = this.findWorkspaceRoot(matchWs[1].trim());
          if (fs.existsSync(ws)) {
            this.sessionWorkspaces.set(id, ws);
            return ws;
          }
        }

        // 2. Check tool call Cwd or SearchPath arguments
        const matchToolCwd = text.match(/"(?:Cwd|SearchPath|workspacePath|workspace)"\s*:\s*"\\"?([a-zA-Z]:(?:\\\\|\\)[^"\r\n]+?)\\"?"/i);
        if (matchToolCwd && matchToolCwd[1]) {
          const rawP = matchToolCwd[1].replace(/\\\\/g, '\\').trim();
          const ws = this.findWorkspaceRoot(rawP);
          if (fs.existsSync(ws)) {
            this.sessionWorkspaces.set(id, ws);
            return ws;
          }
        }

        // 3. Check Active Document or Cwd text in prompt metadata
        const matchDoc = text.match(/(?:Active Document|Cwd|project directory as `?):\s*([a-zA-Z]:\\[^\r\n<>"`]+)/i);
        if (matchDoc && matchDoc[1]) {
          const ws = this.findWorkspaceRoot(matchDoc[1].trim());
          if (fs.existsSync(ws)) {
            this.sessionWorkspaces.set(id, ws);
            return ws;
          }
        }

        // 4. Check file:/// URIs in transcript
        const matchFileUri = text.match(/file:\/\/\/([a-zA-Z]:\/[^\r\n<>'"\t]+)/);
        if (matchFileUri && matchFileUri[1]) {
          const p = matchFileUri[1].replace(/\//g, '\\').trim();
          const ws = this.findWorkspaceRoot(p);
          if (fs.existsSync(ws)) {
            this.sessionWorkspaces.set(id, ws);
            return ws;
          }
        }
      } catch {}
    }

    // 4. Heuristic based on title / project group
    const title = this.extractSessionTitle(transcriptPath, sessionPath, id).toLowerCase();
    const candidates = [
      'e:\\Work\\apps\\antigravity-browser-desktop',
      'e:\\Work\\apps\\antigravity-browser',
      'e:\\Work\\customizes\\Mnbakery',
      'e:\\Work\\customizes\\Seahorse2',
      'e:\\Work\\customizes\\Sunriseplus',
      'e:\\Work\\themes\\mnbakery',
      'e:\\Work\\themes\\seahorse',
      'e:\\Work\\themes\\sunriseplus',
    ];
    for (const cand of candidates) {
      const base = path.basename(cand).toLowerCase();
      if (title.includes(base) && fs.existsSync(cand)) {
        this.sessionWorkspaces.set(id, cand);
        return cand;
      }
    }

    return undefined;
  }

  private validateSessionPathContainment(targetId: string): { ok: boolean; sessionPath?: string } {
    if (!targetId || typeof targetId !== 'string') return { ok: false };
    if (!/^[A-Za-z0-9_-]{4,128}$/.test(targetId)) return { ok: false };

    // Must be a member of discovered available sessions
    const discovered = this.getAvailableSessions();
    const isMember = discovered.some((s) => s.id === targetId);
    if (!isMember) return { ok: false };

    const resolvedBrain = path.resolve(this.brainDir);
    const resolvedSession = path.resolve(this.brainDir, targetId);

    // Direct child containment proof: parent directory must equal resolvedBrain
    if (path.dirname(resolvedSession).toLowerCase() !== resolvedBrain.toLowerCase()) {
      return { ok: false };
    }

    // If directory exists on disk, check realpath containment to prevent symlink traversal
    if (fs.existsSync(resolvedSession)) {
      try {
        const realBrain = fs.realpathSync(resolvedBrain);
        const realSession = fs.realpathSync(resolvedSession);
        if (path.dirname(realSession).toLowerCase() !== realBrain.toLowerCase()) {
          return { ok: false };
        }
      } catch {
        return { ok: false };
      }
    }

    return { ok: true, sessionPath: resolvedSession };
  }

  public renameSession(sessionId: string, newTitle: string): boolean {
    const trimmed = newTitle.trim();
    if (!trimmed || trimmed.length > 256) return false;
    const targetId = sessionId === 'auto' ? this.currentSessionId : sessionId;
    const validation = this.validateSessionPathContainment(targetId);
    if (!validation.ok || !validation.sessionPath) return false;

    this.customTitles.set(targetId, trimmed);
    try {
      fs.writeFileSync(path.join(validation.sessionPath, 'session_title.txt'), trimmed, 'utf8');
    } catch {}
    this.emit('sessions-updated', this.getAvailableSessions());
    return true;
  }

  public deleteSession(sessionId: string): boolean {
    const targetId = sessionId === 'auto' ? this.currentSessionId : sessionId;
    const validation = this.validateSessionPathContainment(targetId);
    if (!validation.ok || !validation.sessionPath) return false;

    this.customTitles.delete(targetId);

    // If active session is being deleted, release active file watcher first
    if (this.currentSessionId === targetId) {
      if (this.fileWatcher) {
        try {
          this.fileWatcher.close();
        } catch {}
        this.fileWatcher = null;
      }
      this.currentSessionId = '';
      this.currentTranscriptPath = '';
    }

    const sessionPath = validation.sessionPath;
    if (fs.existsSync(sessionPath)) {
      try {
        fs.rmSync(sessionPath, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
      } catch (err) {
        console.error('[transcript-syncer] Failed to remove session dir:', err);
        return false;
      }
    }

    if (!this.currentSessionId) {
      this.isAutoFollow = true;
      this.findAndBindActiveSession();
    }

    this.emit('sessions-updated', this.getAvailableSessions());
    return true;
  }

  private extractSessionTitle(transcriptPath: string, sessionPath: string, id: string): string {
    // 0. Check custom title first
    if (this.customTitles.has(id)) {
      return this.customTitles.get(id)!;
    }
    const customTitleFile = path.join(sessionPath, 'session_title.txt');
    if (fs.existsSync(customTitleFile)) {
      try {
        const text = fs.readFileSync(customTitleFile, 'utf8').trim();
        if (text) {
          this.customTitles.set(id, text);
          return text;
        }
      } catch {}
    }

    // 1. Check implementation_plan.md first
    const planPath = path.join(sessionPath, 'implementation_plan.md');
    if (fs.existsSync(planPath)) {
      try {
        const planText = fs.readFileSync(planPath, 'utf8');
        const match = planText.match(/^#\s+(.*?)$/m);
        if (match && match[1]) {
          return match[1].trim();
        }
      } catch {}
    }

    // 2. Check first user request in transcript
    try {
      const text = fs.readFileSync(transcriptPath, 'utf8');
      const lines = text.split('\n').filter(Boolean);
      for (const line of lines.slice(0, 15)) {
        try {
          const p = JSON.parse(line);
          if (p.type === 'USER_INPUT' && p.content) {
            let userPrompt = p.content;
            const reqMatch = userPrompt.match(/<USER_REQUEST>([\s\S]*?)<\/USER_REQUEST>/);
            if (reqMatch) userPrompt = reqMatch[1];
            userPrompt = userPrompt.trim().replace(/^\{\{[\s\S]*?\}\}\s*/, '');
            if (userPrompt && !userPrompt.startsWith('{{ CHECKPOINT')) {
              return userPrompt.slice(0, 45) + (userPrompt.length > 45 ? '...' : '');
            }
          }
        } catch {}
      }
    } catch {}

    return `IDE Session (${id.slice(0, 8)})`;
  }

  public switchSession(sessionId: string): boolean {
    if (sessionId === 'auto') {
      this.isAutoFollow = true;
      this.findAndBindActiveSession();
      return true;
    }

    this.isAutoFollow = false;
    const targetSessionPath = path.join(this.brainDir, sessionId);
    const targetTranscript = path.join(targetSessionPath, '.system_generated', 'logs', 'transcript.jsonl');

    if (fs.existsSync(targetTranscript)) {
      this.bindSession(sessionId, targetTranscript);
      this.emit('session-switched', sessionId);
      return true;
    }
    return false;
  }

  private findAndBindActiveSession(): void {
    if (!this.isAutoFollow) return;
    if (!fs.existsSync(this.brainDir)) return;

    try {
      const entries = fs.readdirSync(this.brainDir, { withFileTypes: true });
      const sessionDirs = entries
        .filter((e) => e.isDirectory() && !this.isArchivedSession(path.join(this.brainDir, e.name), e.name))
        .map((e) => {
          const fullPath = path.join(this.brainDir, e.name);
          const fullTranscriptFile = path.join(fullPath, '.system_generated', 'logs', 'transcript_full.jsonl');
          const compactTranscriptFile = path.join(fullPath, '.system_generated', 'logs', 'transcript.jsonl');
          const transcriptFile = fs.existsSync(fullTranscriptFile) ? fullTranscriptFile : compactTranscriptFile;
          let mtime = 0;
          if (fs.existsSync(transcriptFile)) {
            mtime = fs.statSync(transcriptFile).mtimeMs;
          } else if (fs.existsSync(compactTranscriptFile)) {
            mtime = fs.statSync(compactTranscriptFile).mtimeMs;
          } else {
            mtime = fs.statSync(fullPath).mtimeMs;
          }
          return { id: e.name, fullPath, transcriptFile, mtime };
        })
        .sort((a, b) => b.mtime - a.mtime);

      if (sessionDirs.length > 0) {
        const top = sessionDirs[0]!;
        if (top.id !== this.currentSessionId || top.transcriptFile !== this.currentTranscriptPath) {
          if (!this.currentSessionId || !fs.existsSync(this.currentTranscriptPath)) {
            this.bindSession(top.id, top.transcriptFile);
          } else {
            const currentMtime = fs.existsSync(this.currentTranscriptPath) ? fs.statSync(this.currentTranscriptPath).mtimeMs : 0;
            // Only switch if top session has new activity and is at least 10000ms newer than current session
            if (top.mtime > currentMtime + 10000 && (Date.now() - top.mtime) < 30000) {
              this.bindSession(top.id, top.transcriptFile);
            }
          }
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
        const stats = fs.statSync(transcriptPath);
        this.lastTranscriptMtime = stats.mtimeMs;
        this.lastTranscriptSize = stats.size;
        const content = fs.readFileSync(transcriptPath, 'utf8');
        const lines = content.split('\n').filter((l) => l.trim().length > 0);
        this.lastProcessedLine = lines.length;
        initialMessages = this.parseTranscriptLines(lines).slice(-40);
      } catch {
        this.lastProcessedLine = 0;
      }

      try {
        const logDir = path.dirname(transcriptPath);
        this.fileWatcher = fs.watch(logDir, (_eventType) => {
          if (this.watchDebounceTimer) clearTimeout(this.watchDebounceTimer);
          this.watchDebounceTimer = setTimeout(() => {
            this.readNewTranscriptLines();
          }, 80);
        });
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
      return this.parseTranscriptLines(lines).slice(-limit);
    } catch {
      return [];
    }
  }

  private readNewTranscriptLines(): void {
    if (!this.currentTranscriptPath || !fs.existsSync(this.currentTranscriptPath)) return;

    try {
      const stats = fs.statSync(this.currentTranscriptPath);
      if (stats.mtimeMs === this.lastTranscriptMtime && stats.size === this.lastTranscriptSize) {
        return; // Zero change on disk, bail out immediately!
      }
      this.lastTranscriptMtime = stats.mtimeMs;
      this.lastTranscriptSize = stats.size;

      const content = fs.readFileSync(this.currentTranscriptPath, 'utf8');
      const lines = content.split('\n').filter((l) => l.trim().length > 0);

      this.lastProcessedLine = lines.length;
      const messages = this.parseTranscriptLines(lines).slice(-40);

      let isRunning = false;
      if (lines.length > 0) {
        const lastLine = lines[lines.length - 1]!;
        try {
          const lastObj = JSON.parse(lastLine);
          const timeSinceLastWrite = Date.now() - stats.mtimeMs;
          if (lastObj.type === 'USER_INPUT') {
            isRunning = timeSinceLastWrite < 300000;
          } else if (lastObj.type === 'PLANNER_RESPONSE') {
            const hasTools = Array.isArray(lastObj.tool_calls) && lastObj.tool_calls.length > 0;
            const hasText = typeof lastObj.content === 'string' && lastObj.content.trim().length > 0;
            if (hasTools) {
              isRunning = timeSinceLastWrite < 300000;
            } else if (hasText && !hasTools) {
              isRunning = false;
            } else {
              isRunning = timeSinceLastWrite < 45000;
            }
          } else {
            isRunning = timeSinceLastWrite < 120000;
          }
        } catch {}
      }

      this.emit('session-changed', {
        sessionId: this.currentSessionId,
        messages,
        isRunning,
      });
    } catch {}
  }

  public parseTranscriptLines(lines: string[]): ChatMessage[] {
    const messages: ChatMessage[] = [];
    let currentAssistantTurn: ChatMessage | null = null;

    for (let i = 0; i < lines.length; i++) {
      const lineStr = lines[i]!;
      let obj: any;
      try {
        obj = JSON.parse(lineStr);
      } catch {
        continue;
      }
      if (!obj || typeof obj !== 'object') continue;

      // Extract User Input
      if (obj.type === 'USER_INPUT') {
        if (currentAssistantTurn) {
          messages.push(currentAssistantTurn);
          currentAssistantTurn = null;
        }

        let content = obj.content || '';
        const match = content.match(/<USER_REQUEST>([\s\S]*?)<\/USER_REQUEST>/);
        if (match) {
          content = match[1].trim();
        }
        if (!content || content.startsWith('{{ CHECKPOINT') || content.startsWith('The following is a <SYSTEM_MESSAGE>')) {
          continue;
        }

        const attachedImages: Array<{ name: string; dataUrl: string }> = [];

        // Extract and clean @[path:line] or @[path] attachment links
        const attachRegex = /@\[([^\]]+?)(?::L\d+(?:-\d+)?)?\]/g;
        const cleanContent = content.replace(attachRegex, (_fullMatch: string, rawPath?: string) => {
          const filePath = (rawPath || '').trim();
          const fileName = path.basename(filePath);

          if (/\.(png|jpg|jpeg|gif|webp|svg)$/i.test(filePath)) {
            if (fs.existsSync(filePath)) {
              try {
                const b64 = fs.readFileSync(filePath).toString('base64');
                const ext = path.extname(filePath).slice(1) || 'png';
                attachedImages.push({
                  name: fileName,
                  dataUrl: `data:image/${ext};base64,${b64}`,
                });
              } catch {}
            } else {
              attachedImages.push({
                name: fileName,
                dataUrl: '',
              });
            }
            return '';
          }

          return ` \`📄 ${fileName}\` `;
        }).trim();

        messages.push({
          id: `msg-user-${obj.step_index || i}`,
          role: 'user',
          text: cleanContent || content,
          attachedImages: attachedImages.length > 0 ? attachedImages : undefined,
          timestamp: Date.now(),
        });
      } else if (obj.type === 'PLANNER_RESPONSE') {
        const content = (obj.content || '').trim();
        const toolCalls = (obj.tool_calls || []).map((t: any, idx: number) => ({
          id: `tool-${i}-${idx}`,
          name: t.tool_name || t.name || 'tool',
          args: t.arguments || t.args,
          status: 'done' as const,
        }));
        const thought = obj.thought || obj.thinking || undefined;

        if (!content && toolCalls.length === 0 && !thought) {
          continue;
        }

        if (!currentAssistantTurn) {
          currentAssistantTurn = {
            id: `msg-asst-${obj.step_index || i}`,
            role: 'assistant',
            text: content,
            thinking: thought,
            toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
            timestamp: Date.now(),
          };
        } else {
          // Merge consecutive assistant steps of this turn into ONE single turn message
          if (content) {
            currentAssistantTurn.text = content;
          }
          if (thought) {
            currentAssistantTurn.thinking = thought;
          }
          if (toolCalls.length > 0) {
            currentAssistantTurn.toolCalls = currentAssistantTurn.toolCalls
              ? [...currentAssistantTurn.toolCalls, ...toolCalls]
              : toolCalls;
          }
        }
      }
    }

    if (currentAssistantTurn) {
      messages.push(currentAssistantTurn);
    }

    return messages;
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
