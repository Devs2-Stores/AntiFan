/**
 * Returns the process exit code when Electron cannot acquire the single-instance lock.
 * Normal launches retain exit code 0 for second-instance window handoff; test lanes
 * opt into a non-zero exit so lock contention cannot masquerade as a passing test.
 */
export function singleInstanceLockExitCode(
  gotTheLock: boolean,
  failOnContention: boolean,
): number | null {
  if (gotTheLock) return null;
  return failOnContention ? 1 : 0;
}

/**
 * The launch flag a second process sends to ask the running instance to quit cleanly.
 * It rides the single-instance handoff because that is the one channel that needs no
 * credential: the bridge's quit is refused for attachment-bound connections and the
 * master token is never written to disk.
 */
export const QUIT_REQUEST_ARGUMENT = '--antifan-quit-request';

/** True when a second launch's argv carries the quit request flag (exact token match). */
export function isQuitRequestArgv(argv: readonly string[] | undefined): boolean {
  if (!Array.isArray(argv)) return false;
  return argv.some((arg) => arg === QUIT_REQUEST_ARGUMENT);
}
