#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <wchar.h>
#include <stdlib.h>
#include <stdio.h>

/**
 * AntiFan Browser Desktop - Native Messaging Host Shim (Win32)
 *
 * This lightweight launcher is invoked directly by Chromium (Chrome, Edge, Brave)
 * via the registered Native Messaging Host manifest.
 *
 * It performs:
 * 1. Sets ELECTRON_RUN_AS_NODE=1 so Electron runs in headless Node.js mode.
 * 2. Resolves the main desktop executable and the host-runner script.
 * 3. Launches the process with CREATE_NO_WINDOW and inherited stdio handles.
 * 4. Forwards process exit codes to Chromium.
 */

int WINAPI wWinMain(HINSTANCE hInstance, HINSTANCE hPrevInstance, PWSTR pCmdLine, int nCmdShow) {
    (void)hInstance;
    (void)hPrevInstance;
    (void)pCmdLine;
    (void)nCmdShow;

    // 1. Set ELECTRON_RUN_AS_NODE = 1
    SetEnvironmentVariableW(L"ELECTRON_RUN_AS_NODE", L"1");

    // 2. Resolve executable directory
    WCHAR exeDir[MAX_PATH];
    DWORD len = GetModuleFileNameW(NULL, exeDir, MAX_PATH);
    if (len == 0 || len >= MAX_PATH) {
        return 1;
    }

    // Remove filename to get directory
    for (int i = (int)len - 1; i >= 0; i--) {
        if (exeDir[i] == L'\\' || exeDir[i] == L'/') {
            exeDir[i] = L'\0';
            break;
        }
    }

    // 3. Resolve target desktop executable and runner script
    WCHAR targetExe[MAX_PATH];
    WCHAR runnerScript[MAX_PATH];

    BOOL found = FALSE;

    // Layout 1: Packaged root (<exeDir>\antifan-browser-desktop.exe)
    _snwprintf(targetExe, MAX_PATH, L"%s\\antifan-browser-desktop.exe", exeDir);
    _snwprintf(runnerScript, MAX_PATH, L"%s\\resources\\app.asar.unpacked\\.compiled\\src\\main\\native-messaging\\host-runner.js", exeDir);
    if (GetFileAttributesW(targetExe) != INVALID_FILE_ATTRIBUTES && GetFileAttributesW(runnerScript) != INVALID_FILE_ATTRIBUTES) {
        found = TRUE;
    }

    // Layout 2: Packaged bin (<exeDir>\..\antifan-browser-desktop.exe)
    if (!found) {
        _snwprintf(targetExe, MAX_PATH, L"%s\\..\\antifan-browser-desktop.exe", exeDir);
        _snwprintf(runnerScript, MAX_PATH, L"%s\\..\\resources\\app.asar.unpacked\\.compiled\\src\\main\\native-messaging\\host-runner.js", exeDir);
        if (GetFileAttributesW(targetExe) != INVALID_FILE_ATTRIBUTES && GetFileAttributesW(runnerScript) != INVALID_FILE_ATTRIBUTES) {
            found = TRUE;
        }
    }

    // Layout 3: Dev bin (<exeDir>\..\node_modules\electron\dist\electron.exe + <exeDir>\..\.compiled\...)
    if (!found) {
        _snwprintf(targetExe, MAX_PATH, L"%s\\..\\node_modules\\electron\\dist\\electron.exe", exeDir);
        _snwprintf(runnerScript, MAX_PATH, L"%s\\..\\.compiled\\src\\main\\native-messaging\\host-runner.js", exeDir);
        if (GetFileAttributesW(targetExe) != INVALID_FILE_ATTRIBUTES && GetFileAttributesW(runnerScript) != INVALID_FILE_ATTRIBUTES) {
            found = TRUE;
        }
    }

    // Layout 4: Dev root (<exeDir>\node_modules\electron\dist\electron.exe + <exeDir>\.compiled\...)
    if (!found) {
        _snwprintf(targetExe, MAX_PATH, L"%s\\node_modules\\electron\\dist\\electron.exe", exeDir);
        _snwprintf(runnerScript, MAX_PATH, L"%s\\.compiled\\src\\main\\native-messaging\\host-runner.js", exeDir);
        if (GetFileAttributesW(targetExe) != INVALID_FILE_ATTRIBUTES && GetFileAttributesW(runnerScript) != INVALID_FILE_ATTRIBUTES) {
            found = TRUE;
        }
    }

    if (!found) {
        // Report error via native messaging framing to stdout
        const char* errJson = "{\"status\":\"ERROR\",\"error\":\"HOST_BINARIES_NOT_FOUND\",\"message\":\"AntiFan host binary or runner script could not be located.\"}";
        DWORD jsonLen = (DWORD)strlen(errJson);
        DWORD bytesWritten = 0;
        HANDLE hOut = GetStdHandle(STD_OUTPUT_HANDLE);
        WriteFile(hOut, &jsonLen, 4, &bytesWritten, NULL);
        WriteFile(hOut, errJson, jsonLen, &bytesWritten, NULL);
        return 1;
    }
    // 4. Build command line: "<targetExe>" "<runnerScript>" [pCmdLine]
    WCHAR cmdLine[4096];
    if (pCmdLine && wcslen(pCmdLine) > 0) {
        _snwprintf(cmdLine, 4096, L"\"%s\" \"%s\" %s", targetExe, runnerScript, pCmdLine);
    } else {
        _snwprintf(cmdLine, 4096, L"\"%s\" \"%s\"", targetExe, runnerScript);
    }

    // 5. Setup Process Startup Info with inherited stdio
    STARTUPINFOW si;
    ZeroMemory(&si, sizeof(si));
    si.cb = sizeof(si);
    si.dwFlags = STARTF_USESTDHANDLES;
    si.hStdInput = GetStdHandle(STD_INPUT_HANDLE);
    si.hStdOutput = GetStdHandle(STD_OUTPUT_HANDLE);
    si.hStdError = GetStdHandle(STD_ERROR_HANDLE);

    PROCESS_INFORMATION pi;
    ZeroMemory(&pi, sizeof(pi));

    // 6. Launch process with CREATE_NO_WINDOW
    BOOL success = CreateProcessW(
        NULL,
        cmdLine,
        NULL,
        NULL,
        TRUE,                 // Inherit stdio handles
        CREATE_NO_WINDOW,     // Do not create console window
        NULL,                 // Inherit environment (with ELECTRON_RUN_AS_NODE=1)
        exeDir,               // Working directory
        &si,
        &pi
    );

    if (!success) {
        return (int)GetLastError();
    }

    // 7. Wait for child process to terminate and forward exit code
    WaitForSingleObject(pi.hProcess, INFINITE);

    DWORD exitCode = 0;
    GetExitCodeProcess(pi.hProcess, &exitCode);

    CloseHandle(pi.hProcess);
    CloseHandle(pi.hThread);

    return (int)exitCode;
}
