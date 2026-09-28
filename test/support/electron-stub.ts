/**
 * The Electron transport does not exist under plain `node --test`, and `src/main/index` reaches for
 * it while the module is being loaded (an exit interceptor binds `app.quit`, the profile paths are
 * read from `app.getPath`). A test file that imports that module must therefore install this
 * stand-in *before* the import runs.
 *
 * This is not a convenience: an import that throws leaves the file with no registered case, and the
 * runner reports that file as one passing test. A stub missing one API silently voids every case in
 * the file instead of failing it.
 */
export function installElectronStub(): void {
  const noop = (): void => undefined;
  const stub = {
    app: {
      isPackaged: false,
      commandLine: { appendSwitch: noop, appendArgument: noop },
      requestSingleInstanceLock: () => false,
      hasSingleInstanceLock: () => false,
      releaseSingleInstanceLock: noop,
      getAppMetrics: () => [] as unknown[],
      on: noop,
      once: noop,
      off: noop,
      removeListener: noop,
      removeAllListeners: noop,
      whenReady: () => Promise.withResolvers<void>().promise,
      quit: noop,
      exit: noop,
      relaunch: noop,
      focus: noop,
      hide: noop,
      getPath: () => '',
      setPath: noop,
      getAppPath: () => process.cwd(),
      getName: () => 'AntiFan',
      getVersion: () => '0.0.0-test',
      getLocale: () => 'en-US',
      isReady: () => false,
      setLoginItemSettings: noop,
      getLoginItemSettings: () => ({ openAtLogin: false }),
    },
    protocol: { registerSchemesAsPrivileged: noop, handle: noop, unhandle: noop, isProtocolHandled: () => false },
    BrowserWindow: class {},
    BaseWindow: class {},
    WebContentsView: class {},
    Menu: { setApplicationMenu: noop, buildFromTemplate: () => ({}) as unknown, getApplicationMenu: () => null },
    MenuItem: class {},
    ipcMain: { handle: noop, handleOnce: noop, on: noop, once: noop, removeHandler: noop, removeAllListeners: noop },
    ipcRenderer: { invoke: async () => undefined, on: noop, send: noop },
    dialog: {
      showMessageBox: async () => ({ response: 0 }),
      showMessageBoxSync: () => 2,
      showErrorBox: noop,
      showOpenDialog: async () => ({ canceled: true, filePaths: [] as string[] }),
    },
    session: { defaultSession: {}, fromPartition: () => ({}) },
    nativeTheme: { on: noop, shouldUseDarkColors: false, themeSource: 'system' },
    webContents: { fromId: () => null, getAllWebContents: () => [] },
    crashReporter: { start: noop },
    shell: { openExternal: async () => undefined, showItemInFolder: noop },
    clipboard: { writeText: noop, readText: () => '' },
    safeStorage: {
      isEncryptionAvailable: () => false,
      encryptString: () => Buffer.alloc(0),
      decryptString: () => '',
    },
    powerMonitor: { on: noop, off: noop },
    screen: { on: noop, getPrimaryDisplay: () => ({ workAreaSize: { width: 1280, height: 800 } }) },
  };
  const electronPath = require.resolve('electron');
  // A cache entry is what `require` reads; Node's own Module constructor produces one.
  const entry = new (require('node:module').Module)(electronPath);
  entry.loaded = true;
  entry.exports = stub;
  require.cache[electronPath] = entry;
}
