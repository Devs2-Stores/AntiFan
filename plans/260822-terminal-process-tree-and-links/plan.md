# Plan: Terminal Process Tree Kill (Windows) & Click-to-Open Web Links Addon

## Overview
Nâng cấp hai tính năng cốt lõi cho AntiFan Terminal:
1. **Process Tree Kill on Windows**: Tự động dọn dẹp sạch toàn bộ cây tiến trình con (`taskkill /pid <PID> /T /F`) khi đóng tab hoặc restart session, ngăn chặn triệt để lỗi khóa port (`EADDRINUSE`) và tiến trình ma (ghost node/vite/python processes).
2. **Click-to-Open Web Links (`@xterm/addon-web-links`)**: Tích hợp addon nhận diện URL trong xterm terminal và cho phép click (hoặc Ctrl+Click) để tự động mở trực tiếp đường dẫn đó trong một tab mới trên AntiFan Browser.

## Status: COMPLETED
- Mode: `--interactive` with `--advice` (KongMing Advisory Supervision)
- Completion Date: 2026-08-22

## Phases
1. [phase-01-process-tree-kill-windows.md](phase-01-process-tree-kill-windows.md) - [COMPLETED] Implement reliable Windows Process Tree Kill helper & wire to session lifecycle in `TerminalManager`.
2. [phase-02-web-links-click-to-open.md](phase-02-web-links-click-to-open.md) - [COMPLETED] Add `@xterm/addon-web-links` script and wire click handler in `standalone.html` / `standalone.js` with `standalone-preload.ts` IPC.
3. [phase-03-tests-and-verification.md](phase-03-tests-and-verification.md) - [COMPLETED] Add unit & contract tests, verify clean process termination and web-link opening, and verify full test suite.
