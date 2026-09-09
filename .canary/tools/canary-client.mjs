/**
 * Canary-bound control-plane RPC client.
 *
 * The ambient ANTIFAN_MCP_BOOTSTRAP in a dev shell points at the USER's
 * long-running instance (bridge 20130), which may predate local edits. Every
 * canary probe MUST bind to the isolated canary instance (bridge 20131) using
 * the persisted canary session, so results reflect the build under test.
 */
import fs from 'node:fs';
import path from 'node:path';

const SESSION_FILE = path.resolve('.canary/state/canary-session.json');
const session = JSON.parse(fs.readFileSync(SESSION_FILE, 'utf8'));

process.env.ANTIFAN_MCP_BOOTSTRAP = JSON.stringify({
  port: session.port,
  secret: session.secret,
  attachmentId: session.attachmentId,
  authorityRevision: session.authorityRevision,
  runId: session.runId,
  attemptId: session.attemptId,
  projectId: session.projectId,
  workspaceId: session.workspaceId,
  tabId: session.tabId,
});

const lib = await import('./lib-rpc.mjs');

export const bootstrap = lib.bootstrap;
export const call = lib.call;
export const rpcCall = lib.rpcCall;
export const evalOn = lib.evalOn;
export const sessionInfo = session;

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(import.meta.filename)) {
  const [, , capability, paramsJson] = process.argv;
  if (!capability) {
    console.error('usage: node .canary/tools/canary-client.mjs <capability> [jsonParams]');
    process.exit(1);
  }
  const params = paramsJson ? JSON.parse(paramsJson) : {};
  try {
    const result = await call(capability, params, 120000);
    console.log(JSON.stringify(result, null, 2));
  } catch (err) {
    console.error(JSON.stringify({ code: err.code, message: err.message, details: err.details }, null, 2));
    process.exit(2);
  }
}
