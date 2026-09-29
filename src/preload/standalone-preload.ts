import { contextBridge, ipcRenderer, clipboard } from 'electron';
import { BRIDGE_CHANNELS, PROJECT_WINDOW_CHANNELS, TERMINAL_CHANNELS } from '../shared/contracts';
import type {
  BridgeHealthReport,
  CapsuleBrief,
  CapsuleBriefResult,
  ProjectOpenListResult,
  ProjectOpenPickerAnswerPayload,
  ProjectOpenPickerPush,
  ProjectOpenResult,
  ProjectRemoveRequest,
  ProjectRenameResult,
  ProjectRemoveResult,
  RunCardState,
  RunControlOp,
  RunControlResult,
  TerminalDataPayload,
  TerminalTabPrefs,
  TabsUpdatedPayload,
} from '../shared/contracts';

/**
 * The tab broadcast is one object carrying both halves the renderer reads. Normalizing
 * at this boundary keeps that contract total: a payload from a build that predates the
 * affinity map — or a malformed one — reads as "no affinities" instead of arriving as a
 * shape the renderer would index blindly.
 */
function normalizeTabsUpdatedPayload(d: unknown): TabsUpdatedPayload {
  const source: Record<string, unknown> = (d && typeof d === 'object' && !Array.isArray(d))
    ? d as Record<string, unknown>
    : { tabs: d };
  const tabs = source.tabs;
  const affinities = source.terminalAffinities;
  return {
    tabs: Array.isArray(tabs) ? tabs as TabsUpdatedPayload['tabs'] : [],
    terminalAffinities: (affinities && typeof affinities === 'object')
      ? affinities as TabsUpdatedPayload['terminalAffinities']
      : {},
  };
}

const api = {
  copyToClipboard: (text: string) => clipboard.writeText(text),
  readFromClipboard: () => clipboard.readText(),
  pasteImageFromClipboard: () => ipcRenderer.invoke('antifan:terminal:paste-image'),
  openWorkspace: (sessionId?: string) => ipcRenderer.invoke('antifan:standalone:open-workspace', { sessionId }),
  // The one explicit user intention to open a project. With no id, Main presents its own
  // project-opening surface; the renderer never guesses a project from a title, a path or
  // whatever tab happens to be focused.
  openProject: (projectId?: string): Promise<ProjectOpenResult> =>
    ipcRenderer.invoke(PROJECT_WINDOW_CHANNELS.PROJECT_OPEN, { projectId }),
  // The picker's own three calls: the inventory Main offers, the push that asks this
  // surface to host the modal, and the one answer that settles the request. The renderer
  // echoes the requestId Main gave it back verbatim — it is the only proof the answer
  // belongs to this request.
  listProjects: (): Promise<ProjectOpenListResult> =>
    ipcRenderer.invoke(PROJECT_WINDOW_CHANNELS.PROJECT_LIST),
  onProjectOpenPicker: (cb: (payload: ProjectOpenPickerPush) => void) => {
    const handler = (_e: unknown, payload: ProjectOpenPickerPush) => cb(payload);
    ipcRenderer.on(PROJECT_WINDOW_CHANNELS.PROJECT_OPEN_PICKER, handler);
    return () => ipcRenderer.removeListener(PROJECT_WINDOW_CHANNELS.PROJECT_OPEN_PICKER, handler);
  },
  answerProjectOpenPicker: (payload: ProjectOpenPickerAnswerPayload) =>
    ipcRenderer.invoke(PROJECT_WINDOW_CHANNELS.PROJECT_OPEN_PICKER_ANSWER, payload),
  // Rename/remove asks the picker modal drives on a row. `confirmed` rides the remove
  // request — the modal's inline confirmation is the answer, and
  // `answerProjectRemove` exists only for the test/probe seam that answers explicitly.
  renameProject: (request: { projectId: string; name: string }): Promise<ProjectRenameResult> =>
    ipcRenderer.invoke(PROJECT_WINDOW_CHANNELS.PROJECT_RENAME, request),
  removeProject: (request: ProjectRemoveRequest): Promise<ProjectRemoveResult> =>
    ipcRenderer.invoke(PROJECT_WINDOW_CHANNELS.PROJECT_REMOVE, request),
  answerProjectRemove: (payload: { projectId: string; confirmed: boolean }): Promise<ProjectRemoveResult> =>
    ipcRenderer.invoke(PROJECT_WINDOW_CHANNELS.PROJECT_REMOVE_ANSWER, payload),
  getInitialState: () => ipcRenderer.invoke('antifan:sidebar:get-initial-state'),
  startTerminal: (cwd?: string) => ipcRenderer.invoke('antifan:terminal:start', cwd),
  sendTerminalInput: (input: string) => ipcRenderer.invoke('antifan:terminal:input', input),
  sendTerminalInputTo: (id: string, input: string) => ipcRenderer.send('antifan:terminal:input-session', { id, input }),
  restartTerminal: (cwd?: string) => ipcRenderer.invoke('antifan:terminal:restart', cwd),
  killTerminal: () => ipcRenderer.invoke('antifan:terminal:kill'),
  resizeTerminal: (cols: number, rows: number) => ipcRenderer.invoke('antifan:terminal:resize', { cols, rows }),
  resizeTerminalTo: (id: string, cols: number, rows: number) => ipcRenderer.invoke('antifan:terminal:resize-session', { id, cols, rows }),
  newTerminal: (cwd?: string) => ipcRenderer.invoke('antifan:terminal:new-session', cwd),
  splitTerminal: (parentId: string, options?: string | { cwd?: string; cols?: number; rows?: number }) => {
    const payload = typeof options === 'string' ? { parentId, cwd: options } : { parentId, ...(options || {}) };
    return ipcRenderer.invoke('antifan:terminal:split-session', payload);
  },
  unsplitTerminal: (parentId: string) => ipcRenderer.invoke('antifan:terminal:unsplit-session', parentId),
  listTerminals: () => ipcRenderer.invoke('antifan:terminal:list-sessions'),
  switchTerminal: (id: string) => ipcRenderer.invoke('antifan:terminal:switch-session', id),
  renameTerminal: (id: string, name: string) => ipcRenderer.invoke('antifan:terminal:rename-session', { id, name }),
  reorderTerminals: (orderIds: string[]) => ipcRenderer.invoke('antifan:terminal:reorder-sessions', orderIds),
  rebindTerminalAffinity: (tabId?: string, terminalId?: string) => ipcRenderer.invoke('antifan:terminal:rebind-affinity', { tabId, terminalId }),
  adoptTabAffinity: (tabId: string, terminalId?: string) => ipcRenderer.invoke('antifan:terminal:adopt-tab', { tabId, terminalId }),
  removeTabAffinity: (tabId: string, terminalId?: string) => ipcRenderer.invoke('antifan:terminal:remove-tab', { tabId, terminalId }),
  getTerminalAffinity: (terminalId?: string) => ipcRenderer.invoke('antifan:terminal:get-affinity', terminalId),
  // One round-trip for every tab's affinity: the per-id loop was N+1 IPC calls
  // per tab-strip render and each generation-less lookup cost an O(E) scan.
  getTerminalAffinities: () => ipcRenderer.invoke(TERMINAL_CHANNELS.GET_ALL_AFFINITIES),
  sleepTerminal: (id: string) => ipcRenderer.invoke(TERMINAL_CHANNELS.SLEEP_SESSION, id),
  wakeTerminal: (id: string) => ipcRenderer.invoke(TERMINAL_CHANNELS.WAKE_SESSION, id),
  setCategory: (id: string, category?: string) => ipcRenderer.invoke(TERMINAL_CHANNELS.SET_CATEGORY, { id, category }),
  getTabs: () => ipcRenderer.invoke('antifan:tabs:get-list'),
  closeTerminal: (id: string) => ipcRenderer.invoke('antifan:terminal:close-session', id),
  listCapsules: () => ipcRenderer.invoke('antifan:capsule:list'),
  pickWorkspaceFolder: (sessionId?: string) => ipcRenderer.invoke('antifan:capsule:pick-folder', { sessionId }),
  createCapsule: (name: string, workspacePath: string) => ipcRenderer.invoke('antifan:capsule:create', { name, workspacePath }),
  switchCapsule: (id: string, sessionId?: string) => ipcRenderer.invoke('antifan:capsule:switch', { capsuleId: id, sessionId }),
  capsuleGetBrief: (capsuleId: string): Promise<CapsuleBriefResult> =>
    ipcRenderer.invoke('antifan:capsule:get-brief', { capsuleId }),
  capsuleSetBrief: (capsuleId: string, brief: CapsuleBrief | null): Promise<CapsuleBriefResult> =>
    ipcRenderer.invoke('antifan:capsule:set-brief', { capsuleId, brief }),
  // Hand one terminal to the window that owns the target project. Distinct from `switchCapsule`,
  // which re-points the whole calling window: this moves one session out of the window it is in.
  // Main decides whether the caller may (the shared manager may) and answers with a refusal
  // reason when it may not, so the renderer never has to guess an outcome.
  assignTerminalProject: (sessionId: string, projectId: string) =>
    ipcRenderer.invoke(TERMINAL_CHANNELS.ASSIGN_PROJECT, { sessionId, projectId }),
  // A terminal's URL belongs to the project that owns the session, never to whichever window has
  // focus when the link handler runs.
  openTerminalLink: (sessionId: string, url: string) =>
    ipcRenderer.invoke(TERMINAL_CHANNELS.OPEN_LINK, { sessionId, url }),
  openInVSCode: (path?: string) =>
    ipcRenderer.invoke(TERMINAL_CHANNELS.OPEN_IN_VSCODE, path),
  togglePanel: () => ipcRenderer.invoke('antifan:toolbar:toggle-sidebar'),
  setPanelWidth: (width: number) => ipcRenderer.invoke('antifan:sidebar:set-width', width),
  setTerminalTabPrefs: (prefs: Partial<TerminalTabPrefs>) => ipcRenderer.invoke(TERMINAL_CHANNELS.SET_TAB_PREFS, prefs),
  popoutTerminal: () => ipcRenderer.invoke('antifan:terminal:popout'),
  openNewTerminalWindow: (sessionId?: string) => ipcRenderer.invoke('antifan:terminal:new-window', { sessionId }),
  closeTerminalWindow: () => ipcRenderer.invoke('antifan:terminal:close-window'),
  setActiveTerminalSession: (sessionId: string, splitSessionId?: string) => ipcRenderer.invoke('antifan:terminal:set-active-session', { sessionId, splitSessionId }),
  redockTerminal: () => ipcRenderer.invoke('antifan:terminal:redock'),
  isTerminalPopout: () => ipcRenderer.invoke('antifan:terminal:get-popout-state'),
  toggleFullScreen: () => ipcRenderer.invoke('antifan:window:toggle-fullscreen'),
  createTab: (url?: string) => ipcRenderer.invoke('antifan:toolbar:create-tab', url),
  openExternal: (url?: string) => ipcRenderer.invoke('antifan:toolbar:open-external', url),
  focusTab: (tabId: string) => ipcRenderer.invoke('antifan:toolbar:switch-tab', tabId),
  onTerminalPopoutChanged: (cb: (isPopout: boolean) => void) => {
    const h = (_e: unknown, v: boolean) => cb(v);
    ipcRenderer.on('antifan:terminal:popout-state-changed', h);
    return () => ipcRenderer.removeListener('antifan:terminal:popout-state-changed', h);
  },
  getFullBuffer: (sessionId?: string) => ipcRenderer.invoke('antifan:terminal:get-full-buffer', sessionId),
  getTerminalDelta: (sessionId: string, generation: number, fromSeq: number) =>
    ipcRenderer.invoke('antifan:terminal:get-delta', { sessionId, generation, fromSeq }),
  dumpTerminalDiagnostics: () => ipcRenderer.invoke('antifan:terminal:dump-diagnostics'),
  syncTerminalView: (query: { sessionId: string; knownGeneration: number; lastAppliedSeq: number }) =>
    ipcRenderer.invoke('antifan:terminal:sync-view', query),
  ackTerminalChunk: (payload: { rendererInstanceId: string; sessionId: string; generation: number; seq: number; role?: 'DOCK' | 'POPOUT' }) =>
    ipcRenderer.send('antifan:terminal:ack', payload),
  onTerminalData: (cb: (data: TerminalDataPayload) => void) => { const h = (_e: unknown, d: TerminalDataPayload) => cb(d); ipcRenderer.on('antifan:terminal:data', h); return () => ipcRenderer.removeListener('antifan:terminal:data', h); },
  onTerminalActivity: (cb: (data: TerminalDataPayload) => void) => { const h = (_e: unknown, d: TerminalDataPayload) => cb(d); ipcRenderer.on(TERMINAL_CHANNELS.ACTIVITY, h); return () => ipcRenderer.removeListener(TERMINAL_CHANNELS.ACTIVITY, h); },
  onTerminalSession: (cb: (state: unknown) => void) => { const h = (_e: unknown, d: unknown) => cb(d); ipcRenderer.on('antifan:terminal:session', h); return () => ipcRenderer.removeListener('antifan:terminal:session', h); },
  onTabsUpdated: (cb: (payload: TabsUpdatedPayload) => void) => {
    const h = (_e: unknown, d: unknown) => cb(normalizeTabsUpdatedPayload(d));
    ipcRenderer.on('antifan:tabs:updated', h);
    return () => ipcRenderer.removeListener('antifan:tabs:updated', h);
  },
  getBridgeStatus: (): Promise<BridgeHealthReport> =>
    ipcRenderer.invoke(BRIDGE_CHANNELS.GET_STATUS),
  onBridgeStatus: (cb: (report: BridgeHealthReport) => void) => {
    const h = (_e: unknown, report: BridgeHealthReport) => cb(report);
    ipcRenderer.on(BRIDGE_CHANNELS.STATUS_CHANGED, h);
    return () => ipcRenderer.removeListener(BRIDGE_CHANNELS.STATUS_CHANGED, h);
  },
  runControl: (terminalSessionId: string, op: RunControlOp, text?: string): Promise<RunControlResult> =>
    ipcRenderer.invoke(TERMINAL_CHANNELS.RUN_CONTROL, { terminalSessionId, op, text }),
  onRunCardState: (cb: (cards: RunCardState[]) => void) => {
    const h = (_e: unknown, cards: RunCardState[]) => cb(cards);
    ipcRenderer.on(TERMINAL_CHANNELS.RUN_STATE, h);
    return () => ipcRenderer.removeListener(TERMINAL_CHANNELS.RUN_STATE, h);
  },
};
contextBridge.exposeInMainWorld('antifanStandalone', api);
