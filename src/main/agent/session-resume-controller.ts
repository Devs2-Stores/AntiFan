import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

export interface SessionManifest {
  sessionId: string;
  name: string;
  cwd: string;
  capsuleId?: string;
  lastPid?: number;
  isAlive?: boolean;
  createdAt: number;
  updatedAt: number;
}

export class SessionResumeController {
  private readonly storageDir: string;

  constructor(customDir?: string) {
    this.storageDir = customDir || process.env.ANTIFAN_CONFIG_DIR || path.join(os.homedir(), '.antifan', 'sessions');
    try {
      fs.mkdirSync(this.storageDir, { recursive: true });
    } catch {}
  }

  public getManifestPath(sessionId: string): string {
    const safeId = sessionId.replace(/[^a-zA-Z0-9_-]/g, '_');
    return path.join(this.storageDir, `${safeId}.json`);
  }

  public saveManifest(manifest: SessionManifest): void {
    try {
      const filePath = this.getManifestPath(manifest.sessionId);
      const data = JSON.stringify({ ...manifest, updatedAt: Date.now() }, null, 2);
      fs.writeFileSync(filePath, data, 'utf8');
    } catch (err) {
      console.warn('[session-resume] Failed to save session manifest:', err);
    }
  }

  public loadManifest(sessionId: string): SessionManifest | null {
    try {
      const filePath = this.getManifestPath(sessionId);
      if (!fs.existsSync(filePath)) return null;
      const data = fs.readFileSync(filePath, 'utf8');
      const manifest = JSON.parse(data) as SessionManifest;
      manifest.isAlive = typeof manifest.lastPid === 'number' ? this.isProcessAlive(manifest.lastPid) : false;
      return manifest;
    } catch {
      return null;
    }
  }

  public listManifests(): SessionManifest[] {
    try {
      if (!fs.existsSync(this.storageDir)) return [];
      const files = fs.readdirSync(this.storageDir).filter((f) => f.endsWith('.json'));
      const list: SessionManifest[] = [];
      for (const file of files) {
        try {
          const content = fs.readFileSync(path.join(this.storageDir, file), 'utf8');
          const manifest = JSON.parse(content) as SessionManifest;
          manifest.isAlive = typeof manifest.lastPid === 'number' ? this.isProcessAlive(manifest.lastPid) : false;
          list.push(manifest);
        } catch {}
      }
      return list;
    } catch {
      return [];
    }
  }

  public deleteManifest(sessionId: string): void {
    try {
      const filePath = this.getManifestPath(sessionId);
      if (fs.existsSync(filePath)) {
        fs.unlinkSync(filePath);
      }
    } catch {}
  }

  public isProcessAlive(pid: number): boolean {
    if (typeof pid !== 'number' || pid <= 0) return false;
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  }
}
