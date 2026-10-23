import { createRequire } from 'node:module';
import type * as KoffiModule from 'koffi';

/**
 * Win32 view of the message boxes Electron draws for page JavaScript dialogs.
 *
 * A page `alert` / `confirm` is shown by Electron as a native `#32770` box titled with the app
 * name, owned by the tab's window, or unowned when the tab is in no window (a background tab) or
 * the window already shows another box. Answering the dialog over CDP
 * (`Page.handleJavaScriptDialog`) resumes the page but leaves that box on screen; closing it with
 * WM_CLOSE afterwards is harmless (the page already holds its answer). The box's message text is
 * drawn by a DirectUIHWND child and is not readable through Win32 window text, so a box is matched
 * by process, class, title, owner window and visibility, never by its message.
 *
 * koffi is loaded on first use and only on Windows; every other platform reports no boxes.
 */

const lazyRequire = createRequire(__filename);
const GW_OWNER = 4;
const WM_CLOSE = 0x0010;
const DIALOG_CLASS = '#32770';

/** koffi does not export its function type; every `func` overload returns it. */
type KoffiFunction = ReturnType<KoffiModule.LibraryHandle['func']>;

interface User32 {
  koffi: typeof KoffiModule;
  enumWindowsProc: KoffiModule.TypeObject;
  EnumWindows: KoffiFunction;
  GetClassNameW: KoffiFunction;
  GetWindowTextW: KoffiFunction;
  GetWindow: KoffiFunction;
  GetWindowThreadProcessId: KoffiFunction;
  IsWindowVisible: KoffiFunction;
  PostMessageW: KoffiFunction;
}

let user32: User32 | null | undefined;

function loadUser32(): User32 | null {
  if (user32 !== undefined) return user32;
  if (process.platform !== 'win32') {
    user32 = null;
    return user32;
  }
  try {
    const koffi = lazyRequire('koffi') as typeof KoffiModule;
    const lib = koffi.load('user32.dll');
    const enumWindowsProc = koffi.proto('bool __stdcall AntiFanEnumWindowsProc(intptr hwnd, intptr lParam)');
    user32 = {
      koffi,
      enumWindowsProc,
      EnumWindows: lib.func('bool __stdcall EnumWindows(AntiFanEnumWindowsProc *cb, intptr lParam)'),
      GetClassNameW: lib.func('int __stdcall GetClassNameW(intptr hwnd, _Out_ uint16_t *buf, int max)'),
      GetWindowTextW: lib.func('int __stdcall GetWindowTextW(intptr hwnd, _Out_ uint16_t *buf, int max)'),
      GetWindow: lib.func('intptr __stdcall GetWindow(intptr hwnd, uint32 cmd)'),
      GetWindowThreadProcessId: lib.func('uint32 __stdcall GetWindowThreadProcessId(intptr hwnd, _Out_ uint32 *pid)'),
      IsWindowVisible: lib.func('bool __stdcall IsWindowVisible(intptr hwnd)'),
      PostMessageW: lib.func('bool __stdcall PostMessageW(intptr hwnd, uint32 msg, intptr w, intptr l)'),
    };
  } catch (err) {
    console.warn(`[native-dialog-boxes] user32 unavailable: ${err instanceof Error ? err.message : String(err)}`);
    user32 = null;
  }
  return user32;
}

function readWindowString(fn: KoffiFunction, hwnd: unknown): string {
  const buf = new Uint16Array(256);
  const n = Number(fn(hwnd, buf, buf.length));
  return n > 0 ? Buffer.from(buf.buffer).toString('utf16le', 0, n * 2) : '';
}

/**
 * Visible `#32770` boxes of this process owned by `ownerHwnd` and titled `title`, as HWND values.
 * `ownerHwnd` 0 lists the unowned boxes.
 */
export function listOwnedMessageBoxes(ownerHwnd: bigint, title: string): bigint[] {
  const api = loadUser32();
  if (!api) return [];
  const found: bigint[] = [];
  const callback = api.koffi.register((hwnd: number | bigint) => {
    const pid = [0];
    api.GetWindowThreadProcessId(hwnd, pid);
    if (pid[0] !== process.pid) return true;
    if (readWindowString(api.GetClassNameW, hwnd) !== DIALOG_CLASS) return true;
    if (!api.IsWindowVisible(hwnd)) return true;
    if (BigInt(api.GetWindow(hwnd, GW_OWNER) as number | bigint) !== ownerHwnd) return true;
    if (readWindowString(api.GetWindowTextW, hwnd) !== title) return true;
    found.push(BigInt(hwnd));
    return true;
  }, api.koffi.pointer(api.enumWindowsProc));
  try {
    api.EnumWindows(callback, 0);
  } finally {
    api.koffi.unregister(callback);
  }
  return found;
}

/** Posts WM_CLOSE to `hwnd`; false when the window is gone or user32 is unavailable. */
export function postClose(hwnd: bigint): boolean {
  const api = loadUser32();
  if (!api) return false;
  return Boolean(api.PostMessageW(hwnd, WM_CLOSE, 0, 0));
}

/** The HWND of an Electron window handle buffer (`BaseWindow.getNativeWindowHandle()`). */
export function hwndOf(handle: Buffer): bigint {
  return handle.length >= 8 ? handle.readBigUInt64LE(0) : BigInt(handle.readUInt32LE(0));
}
