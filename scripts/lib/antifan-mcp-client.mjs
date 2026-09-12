/**
 * AntiFan MCP Client for OMP Orchestration
 * Provides robust JSON-RPC stdio client to invoke AntiFan MCP tools directly.
 * Adheres to Audit Mandate: OMP -> AntiFan MCP -> AntiFan Core -> Haravan -> Chromium.
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import readline from 'node:readline';

export class AntiFanMcpClient {
  constructor(options = {}) {
    this.options = options;
    this.mcpProc = null;
    this.msgId = 1;
    this.pending = new Map();
    this.initialized = false;
  }

  async connect() {
    if (this.mcpProc) return;

    const session = this.resolveSession();
    const bootstrapObj = session.bootstrap;

    const env = {
      ...process.env,
      ANTIFAN_MCP_BOOTSTRAP: JSON.stringify(bootstrapObj),
      ANTIFAN_ATTACHMENT_ID: session.attachmentId,
      ANTIFAN_ATTACHMENT_SECRET: session.secret,
      ANTIFAN_AUTHORITY_REVISION: session.authorityRevision,
      ANTIFAN_MCP_PORT: String(session.port),
    };

    const mcpScript = this.options.mcpScript
      ? path.resolve(this.options.mcpScript)
      : path.resolve('scripts/antifan-omp-mcp.cjs');
    this.mcpProc = spawn(process.execPath, [mcpScript], {
      env,
      stdio: ['pipe', 'pipe', 'inherit'],
    });

    const rl = readline.createInterface({
      input: this.mcpProc.stdout,
      crlfDelay: Infinity,
    });

    rl.on('line', (line) => {
      const trimmed = line.trim();
      if (!trimmed) return;
      try {
        const json = JSON.parse(trimmed);
        if (json.id && this.pending.has(json.id)) {
          const { resolve, reject } = this.pending.get(json.id);
          this.pending.delete(json.id);
          if (json.error) {
            reject(new Error(json.error.message || JSON.stringify(json.error)));
          } else {
            resolve(json.result);
          }
        }
      } catch (e) {}
    });

    this.mcpProc.on('exit', (code) => {
      this.mcpProc = null;
      this.initialized = false;
      for (const { reject } of this.pending.values()) {
        reject(new Error(`MCP process exited with code ${code}`));
      }
      this.pending.clear();
    });

    // Initialize MCP handshake
    await this.sendRaw('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'antifan-omp-client', version: '1.3.6' },
    });
    this.initialized = true;
  }

  /**
   * Live runs read the canary session record; a caller that supplies an explicit bootstrap
   * (tests, alternate harnesses) skips that read so it does not depend on ambient state.
   */
  resolveSession() {
    if (this.options.bootstrap) {
      const bootstrap = this.options.bootstrap;
      return {
        bootstrap,
        port: bootstrap.port,
        secret: bootstrap.secret,
        attachmentId: bootstrap.attachmentId ?? null,
        authorityRevision: bootstrap.authorityRevision ?? null,
      };
    }

    const sessionPath = path.resolve('.canary/state/canary-session.json');
    if (!fs.existsSync(sessionPath)) {
      throw new Error(`Canary session record missing at ${sessionPath}`);
    }

    const sessionData = JSON.parse(fs.readFileSync(sessionPath, 'utf8'));
    return {
      port: sessionData.port,
      secret: sessionData.secret,
      attachmentId: sessionData.attachmentId,
      authorityRevision: sessionData.authorityRevision,
      bootstrap: {
        port: sessionData.port,
        secret: sessionData.secret,
        token: sessionData.secret,
        attachmentId: sessionData.attachmentId,
        authorityRevision: sessionData.authorityRevision,
        runId: sessionData.runId,
        attemptId: sessionData.attemptId,
        projectId: sessionData.projectId,
        workspaceId: sessionData.workspaceId,
        tabId: sessionData.tabId,
        ownerPid: sessionData.instancePid,
      },
    };
  }

  sendRaw(method, params = {}) {
    if (!this.mcpProc) {
      throw new Error('MCP client is not connected');
    }
    const id = this.msgId++;
    const payload = { jsonrpc: '2.0', id, method, params };
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.mcpProc.stdin.write(JSON.stringify(payload) + '\n');
    });
  }

  async listTools() {
    await this.connect();
    const res = await this.sendRaw('tools/list', {});
    return res.tools || [];
  }

  async callTool(name, args = {}) {
    await this.connect();
    const res = await this.sendRaw('tools/call', {
      name,
      arguments: args,
    });
    // Parse MCP content format
    if (res && res.content && Array.isArray(res.content)) {
      const textItem = res.content.find(c => c.type === 'text');
      if (textItem && typeof textItem.text === 'string') {
        // A failed tool call is an error, not a result: returning the message as
        // data hides the cause behind whatever shape the caller expected next.
        if (res.isError) {
          throw new Error(`MCP tool '${name}' failed: ${textItem.text}`);
        }
        try {
          return JSON.parse(textItem.text);
        } catch {
          return textItem.text;
        }
      }
      if (res.isError) {
        throw new Error(`MCP tool '${name}' failed: ${JSON.stringify(res.content)}`);
      }
      return res.content;
    }
    if (res && res.isError) {
      throw new Error(`MCP tool '${name}' failed: ${JSON.stringify(res)}`);
    }
    return res;
  }

  close() {
    if (this.mcpProc) {
      this.mcpProc.kill();
      this.mcpProc = null;
      this.initialized = false;
    }
  }
}

export default AntiFanMcpClient;
