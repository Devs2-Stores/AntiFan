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
