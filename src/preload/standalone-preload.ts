import { contextBridge, ipcRenderer, clipboard } from 'electron';
import { BRIDGE_CHANNELS, PROJECT_WINDOW_CHANNELS, TERMINAL_CHANNELS } from '../shared/contracts';
import type {
  BridgeHealthReport,
  CapsuleBrief,
  CapsuleBriefResult,
  ProjectAppearanceRequest,
  ProjectAppearanceResult,
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
  TerminalNewInFolderResult,
  SpaceOpenResult,
  SpaceInitResult,
  TerminalTabPrefs,
} from '../shared/contracts';

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
  setProjectAppearance: (request: ProjectAppearanceRequest): Promise<ProjectAppearanceResult> =>
    ipcRenderer.invoke(PROJECT_WINDOW_CHANNELS.PROJECT_SET_APPEARANCE, request),
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
  // Mint a terminal bound to one real folder and nothing else: no capsule switch, no cwd
  // re-point, no other window touched. `folder` skips the chooser — the hub's per-group
  // mint and its header button differ only in who picked the directory.
  newTerminalInFolder: (folder?: string): Promise<TerminalNewInFolderResult> =>
    ipcRenderer.invoke(TERMINAL_CHANNELS.NEW_IN_FOLDER, folder ? { folder } : {}),
  // The picker's folder choice without the picker: Main resolves the directory to the
  // project that owns it or creates one, exactly as its folder chooser would.
  openProjectFromFolder: (folder: string): Promise<ProjectOpenResult> =>
    ipcRenderer.invoke(PROJECT_WINDOW_CHANNELS.PROJECT_OPEN, { folder }),
  // Open a folder's declared Space. The first call may answer NEEDS_CONFIRM with the exact
  // commands; the confirming call echoes the hash it was shown.
  openSpace: (folder: string, confirmHash?: string): Promise<SpaceOpenResult> =>
    ipcRenderer.invoke(TERMINAL_CHANNELS.SPACE_OPEN, confirmHash ? { folder, confirmHash } : { folder }),
  // Scaffold `.antifan/space.json` from the folder's current terminals and tabs (never overwrites).
  createSpaceManifest: (folder: string): Promise<SpaceInitResult> =>
    ipcRenderer.invoke(TERMINAL_CHANNELS.SPACE_INIT, { folder }),
  splitTerminal: (parentId: string, options?: string | { cwd?: string; cols?: number; rows?: number }) => {
    const payload = typeof options === 'string' ? { parentId, cwd: options } : { parentId, ...(options || {}) };
    return ipcRenderer.invoke('antifan:terminal:split-session', payload);
  },
  unsplitTerminal: (parentId: string) => ipcRenderer.invoke('antifan:terminal:unsplit-session', parentId),
  listTerminals: () => ipcRenderer.invoke('antifan:terminal:list-sessions'),
  switchTerminal: (id: string) => ipcRenderer.invoke('antifan:terminal:switch-session', id),
  renameTerminal: (id: string, name: string) => ipcRenderer.invoke('antifan:terminal:rename-session', { id, name }),
  reorderTerminals: (orderIds: string[]) => ipcRenderer.invoke('antifan:terminal:reorder-sessions', orderIds),
  sleepTerminal: (id: string) => ipcRenderer.invoke(TERMINAL_CHANNELS.SLEEP_SESSION, id),
  setTerminalRole: (id: string, role: 'sync' | null, opts?: { acknowledgeDuplicate?: boolean }) => ipcRenderer.invoke(TERMINAL_CHANNELS.SET_ROLE, { id, role, acknowledgeDuplicate: opts?.acknowledgeDuplicate === true }),
  wakeTerminal: (id: string) => ipcRenderer.invoke(TERMINAL_CHANNELS.WAKE_SESSION, id),
  setCategory: (id: string, category?: string) => ipcRenderer.invoke(TERMINAL_CHANNELS.SET_CATEGORY, { id, category }),
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
  toggleFullScreen: () => ipcRenderer.invoke('antifan:window:toggle-fullscreen'),
  createTab: (url?: string) => ipcRenderer.invoke('antifan:toolbar:create-tab', url),
  openExternal: (url?: string) => ipcRenderer.invoke('antifan:toolbar:open-external', url),
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
