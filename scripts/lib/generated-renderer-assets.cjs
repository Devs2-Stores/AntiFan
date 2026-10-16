'use strict';
// Shared modules scripts/copy-static.mjs wraps as classic-script globals for the standalone
// renderer and writes into both .compiled and src/renderer. scripts/launch-guard.cjs reads the
// same list to skip these derived files when it checks for stale sources, so the two can never
// disagree: a file missing from the launcher's copy read as newer than its build on every launch
// and forced a recompile each time.
module.exports = Object.freeze([
  Object.freeze({ file: 'terminal-write-dispatcher.js', globals: ['TerminalWriteDispatcher', 'globalTerminalWriteDispatcher'] }),
  Object.freeze({ file: 'session-activity.js', globals: ['SessionActivityTracker', 'sessionActivityLevel'] }),
  Object.freeze({ file: 'terminal-file-links.js', globals: ['findTerminalFileLinks', 'findTerminalFileLinkRanges'] }),
]);
