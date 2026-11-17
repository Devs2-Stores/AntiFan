/**
 * spawnOwned: the one way main-process code starts a long-lived child. The child is registered with the
 * ProcessRegistry (so a crash leaves a start-time marker the next boot can sweep) and unregistered when it closes,
 * and it carries this main generation's run token in its environment (ANTIFAN_HOST_RUN_TOKEN) and, for Node
 * scripts we author, as an `--antifan-host=<token8>` argument so an orphan scan can read it from the command line
 * without touching the child's environment.
 *
 * Not for the terminal daemon-host or PTYs: those are detached on purpose and must outlive main (see
 * NEVER_SWEEP_OWNERS in process-registry.ts); registering them would also make main's exit hook kill them.
 */
import * as cp from 'node:child_process';
import { ProcessRegistry } from './process-registry';

export interface SpawnOwnedOptions extends cp.SpawnOptions {
  /** Registry owner, e.g. 'core-health'. */
  owner: string;
  /** Human-readable name recorded with the process. */
  name?: string;
  /** Append `--antifan-host=<token8>` to args (only for Node scripts that ignore unknown flags). */
  tagArgv?: boolean;
}

export function spawnOwned(file: string, args: string[], options: SpawnOwnedOptions): cp.ChildProcess {
  const { owner, name, tagArgv, ...spawnOptions } = options;
  const registry = ProcessRegistry.getInstance();
  const finalArgs = tagArgv ? [...args, `--antifan-host=${registry.runToken.slice(0, 8)}`] : args;
  const child = cp.spawn(file, finalArgs, {
    ...spawnOptions,
    env: { ...(spawnOptions.env ?? process.env), ANTIFAN_HOST_RUN_TOKEN: registry.runToken },
  });
  const pid = child.pid;
  if (pid) {
    registry.register({ pid, owner, name, command: finalArgs.join(' '), processRef: child, osStartTime: Date.now() });
    const release = (code?: number | null) => {
      registry.unregister(pid, code);
    };
    child.once('close', release);
    child.once('error', () => release());
  }
  return child;
}
