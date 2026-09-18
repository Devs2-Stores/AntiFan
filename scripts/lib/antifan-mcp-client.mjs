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

    const isProxy = !this.options.mcpScript;
    const env = { ...process.env };
    // A binding inherited from the caller's shell describes a different session, and the proxy
    // prefers the env channel over the pipe: leaving it in place would silently retarget this
    // pinned client.
    delete env.ANTIFAN_MCP_BOOTSTRAP;
    delete env.ANTIFAN_ATTACHMENT_SECRET;
    delete env.ANTIFAN_BOUND_TAB_ID;
    env.ANTIFAN_ATTACHMENT_ID = session.attachmentId;
    env.ANTIFAN_AUTHORITY_REVISION = session.authorityRevision;
    env.ANTIFAN_MCP_PORT = String(session.port);
    if (!isProxy) {
      // The environment block is readable by every same-user process, so the real proxy takes the
      // secret on stdin instead. A test double cannot read the pipe preface, so it keeps the env
      // channel — it never sees a real session secret.
      env.ANTIFAN_MCP_BOOTSTRAP = JSON.stringify(bootstrapObj);
      env.ANTIFAN_ATTACHMENT_SECRET = session.secret;
    }

    const mcpScript = isProxy
      ? path.resolve('scripts/antifan-omp-mcp.cjs')
      : path.resolve(this.options.mcpScript);
    this.mcpProc = spawn(process.execPath, [mcpScript], {
      env,
      stdio: ['pipe', 'pipe', 'inherit'],
    });
    if (isProxy) {
      this.mcpProc.stdin.write(`${JSON.stringify(bootstrapObj)}\n`);
    }

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
          const { resolve, reject, timer } = this.pending.get(json.id);
          this.pending.delete(json.id);
          clearTimeout(timer);
          if (json.error) {
            reject(new Error(json.error.message || JSON.stringify(json.error)));
          } else {
            resolve(json.result);
          }
        }
      } catch (err) {
        if (typeof this.options.onMalformedLine === 'function') {
          this.options.onMalformedLine(trimmed, err);
        } else if (!this.options.silent) {
          console.error(`[AntiFanMcpClient] Malformed MCP stdout: ${trimmed}`);
        }
        for (const { reject, timer } of this.pending.values()) {
          clearTimeout(timer);
          reject(new Error(`MCP server emitted invalid JSON: ${trimmed}`));
        }
        this.pending.clear();
      }
    });

    this.mcpProc.on('error', (err) => {
      this.mcpProc = null;
      this.initialized = false;
      for (const { reject, timer } of this.pending.values()) {
        clearTimeout(timer);
        reject(new Error(`MCP process error: ${err.message}`));
      }
      this.pending.clear();
    });

    this.mcpProc.on('exit', (code) => {
      this.mcpProc = null;
      this.initialized = false;
      for (const { reject, timer } of this.pending.values()) {
        clearTimeout(timer);
        reject(new Error(`MCP process exited with code ${code}`));
      }
      this.pending.clear();
    });

    try {
      // Initialize MCP handshake
      await this.sendRaw('initialize', {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'antifan-omp-client', version: '1.3.6' },
      });
      this.initialized = true;
    } catch (err) {
      this.close();
      throw err;
    }
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

  sendRaw(method, params = {}, timeoutOrOptions = {}) {
    if (!this.mcpProc) {
      throw new Error('MCP client is not connected');
    }
    const timeoutMs = typeof timeoutOrOptions === 'number'
      ? timeoutOrOptions
      : (timeoutOrOptions?.timeoutMs ?? timeoutOrOptions?.timeout ?? this.options.timeoutMs ?? this.options.timeout ?? 30000);

    const id = this.msgId++;
    const payload = { jsonrpc: '2.0', id, method, params };
    return new Promise((resolve, reject) => {
      let timer = null;
      if (timeoutMs > 0 && Number.isFinite(timeoutMs)) {
        timer = setTimeout(() => {
          if (this.pending.has(id)) {
            this.pending.delete(id);
            reject(new Error(`MCP request '${method}' timed out after ${timeoutMs}ms`));
          }
        }, timeoutMs);
        if (typeof timer.unref === 'function') {
          timer.unref();
        }
      }

      this.pending.set(id, { resolve, reject, timer, method });
      try {
        this.mcpProc.stdin.write(JSON.stringify(payload) + '\n');
      } catch (err) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(err);
      }
    });
  }

  async listTools(options = {}) {
    await this.connect();
    const res = await this.sendRaw('tools/list', {}, options);
    return res.tools || [];
  }

  async callTool(name, args = {}, options = {}) {
    await this.connect();
    const res = await this.sendRaw('tools/call', {
      name,
      arguments: args,
    }, options);
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
    for (const { reject, timer } of this.pending.values()) {
      clearTimeout(timer);
      reject(new Error('MCP client closed'));
    }
    this.pending.clear();
    if (this.mcpProc) {
      this.mcpProc.kill();
      this.mcpProc = null;
      this.initialized = false;
    }
  }
}

export default AntiFanMcpClient;
