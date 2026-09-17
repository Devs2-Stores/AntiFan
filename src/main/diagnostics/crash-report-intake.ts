/**
 * AntiFan Browser Desktop — Crash Report Intake
 *
 * Turns the dumps a previous death left in `<runtime>/crashDumps` into records the Hub can
 * show. `index.ts` arms the crash reporter because "for that class of death the dump is the
 * only surviving artifact"; this is the half that reads it, so a native death arrives in the
 * issue register as a named P0 instead of as silence.
 *
 * Rules that keep this honest:
 *  - Never invent a cause. The record carries exactly what the dump says (exception code and
 *    name, faulting module and offset, faulting access, thread count, loaded native addons)
 *    and nothing about what the app was doing, which the dump cannot know.
 *  - Never touch the dump files. Retention belongs to `pruneOldCrashDumps`; this reads only.
 *  - Never flood the register. A crash loop would otherwise write one P0 per death; intake
 *    reports the newest few and states how many it did not report.
 *  - Never throw. Intake runs during bootstrap and must not be the reason a launch fails.
 */

import * as path from 'node:path';
import { IssueRegister } from '../session/issue-register';
import { StorageLocations } from '../config/storage-locations';
import { recordLifecycleEvent } from './main-lifecycle-log';
import { listCrashDumps, summarizeCrashDump, type CrashDumpSummary } from './crash-dump-forensics';

/** Reported per launch at most, so a crash loop cannot bury every other open issue. */
const MAX_REPORTS_PER_LAUNCH = 5;

export interface CrashReportIntakeResult {
  /** Dumps summarized and recorded as issues on this launch. */
  reported: CrashDumpSummary[];
  /** Dump files present but unreadable — themselves evidence of a death. */
  unreadable: string[];
  /** Dumps already on record from an earlier launch. */
  alreadyReported: number;
  /**
   * New dumps left unreported because the per-launch cap was reached. They are named
   * "discarded", not deferred: retention keeps only the newest few, so these files are
   * deleted before any later launch could report them.
   */
  discarded: number;
  /**
   * False when intake itself failed (the catch path). Callers that delete dumps —
   * retention — must gate on this: pruning after a failed intake turns unnamed deaths
   * back into silence.
   */
  completed: boolean;
}

function resolveCrashDumpsDir(override?: string): string {
  return override ?? path.join(StorageLocations.getRuntimeDir(), 'crashDumps');
}

/**
 * Read every dump that is not yet on record and record it. Returns what it did so a caller
 * (or a test) can assert on the effect rather than on the absence of an exception.
 */
export async function intakeCrashReports(options?: {
  crashDumpsDir?: string;
  maxReports?: number;
}): Promise<CrashReportIntakeResult> {
  const result: CrashReportIntakeResult = { reported: [], unreadable: [], alreadyReported: 0, discarded: 0, completed: false };
  try {
    const dir = resolveCrashDumpsDir(options?.crashDumpsDir);
    const dumps = listCrashDumps(dir);
    if (dumps.length === 0) {
      result.completed = true;
      return result;
    }

    const register = IssueRegister.getInstance();
    // `list({ errorCode })` also matches reasonCode, so the candidates are filtered
    // strictly: an unrelated issue whose reasonCode happens to equal one of these codes
    // must not mark a dump as already reported.
    const accountedFor = new Set<string>(
      [...register.list({ errorCode: 'NATIVE_CRASH' }), ...register.list({ errorCode: 'CRASH_DUMP_UNREADABLE' })]
        .filter((issue) => issue.errorCode === 'NATIVE_CRASH' || issue.errorCode === 'CRASH_DUMP_UNREADABLE')
        .flatMap((issue) => issue.affected ?? [])
    );

    // Deduplicate on the path relative to the dumps dir, not the basename: nested report
    // directories can hold same-named dumps that are different deaths.
    const dumpKey = (dump: string): string => path.relative(dir, dump).split(path.sep).join('/');
    const pending = dumps.filter((dump) => {
      if (accountedFor.has(dumpKey(dump))) {
        result.alreadyReported += 1;
        return false;
      }
      return true;
    });
    if (pending.length === 0) {
      result.completed = true;
      return result;
    }

    const maxReports = options?.maxReports ?? MAX_REPORTS_PER_LAUNCH;
    const selected = pending.slice(0, maxReports);
    result.discarded = pending.length - selected.length;

    for (const dump of selected) {
      const filename = dumpKey(dump);
      const summary = await summarizeCrashDump(dump);
      if (!summary) {
        // An unreadable dump still proves a death happened; saying so is the whole point of
        // keeping the file. It is reported at P1 because the exception itself is unknown.
        result.unreadable.push(filename);
        recordLifecycleEvent('crashReport.unreadable', { filename });
        register.record({
          toolName: 'runtime.process',
          errorCode: 'CRASH_DUMP_UNREADABLE',
          severity: 'P1',
          status: 'OPEN',
          errorMessage: `A crash dump was written but its contents could not be read: ${filename}`,
          affected: [filename],
          notes: 'The dump proves a process death but does not name it; inspect the file by hand.',
        });
        continue;
      }

      result.reported.push(summary);
      recordLifecycleEvent('crashReport.detected', {
        filename: summary.filename,
        dumpModifiedAt: summary.dumpModifiedAt,
        processType: summary.processType,
        crashedPid: summary.pid,
        productVersion: summary.productVersion,
        exceptionCode: summary.exceptionCode,
        exceptionName: summary.exceptionName,
        instructionPointer: summary.instructionPointer,
        faultingModule: summary.faultingModule?.name ?? null,
        faultingModuleOffset: summary.faultingModule?.offset ?? null,
        faultingAccess: summary.faultingAccess,
        faultingAddress: summary.faultingAddress,
        threadCount: summary.threadCount,
        nativeAddons: summary.nativeAddons,
      });
      register.record({
        toolName: 'runtime.process',
        errorCode: 'NATIVE_CRASH',
        severity: 'P0',
        status: 'OPEN',
        // The register dedupes on (toolName, errorMessage), so two deaths that fault at the
        // same offset would collapse into a single row sharing one `affected` list — a crash
        // loop would then read as one death. Naming the dump keeps one row per death, which
        // is the contract this intake promises, while `affected` still carries the witness.
        errorMessage: `${summary.headline} (dump ${filename})`,
        reasonCode: summary.exceptionName,
        affected: [filename],
        notes: JSON.stringify({
          dump: summary.filename,
          occurredAt: summary.dumpModifiedAt,
          processType: summary.processType,
          pid: summary.pid,
          electronVersion: summary.productVersion,
          exceptionCode: summary.exceptionCode,
          instructionPointer: summary.instructionPointer,
          faultingModule: summary.faultingModule,
          faultingAccess: summary.faultingAccess,
          faultingAddress: summary.faultingAddress,
          threadCount: summary.threadCount,
          nativeAddons: summary.nativeAddons,
        }),
      });
    }

    if (result.discarded > 0) {
      recordLifecycleEvent('crashReport.discarded', { discarded: result.discarded, reported: result.reported.length });
    }
    result.completed = true;
    return result;
  } catch (err) {
    recordLifecycleEvent('crashReport.intakeFailed', { detail: String(err) });
    return result;
  }
}
