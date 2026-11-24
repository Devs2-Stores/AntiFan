// Shared by the leader-job-*.test.mjs suites that drive the ledger through `record`: not a test file itself.
//
// `record --kind storefront|dashboard --status PASS|WARN` now needs an --evidence file (the gate has its own suite,
// leader-qa-gaps.test.mjs, which calls the CLI without this shim). The older suites exercise the ledger's states, not the
// gate, so their record calls get a file shaped like the real measurement: the dashboard probe's output, or a
// theme.qa_validate result with summary.certification CERTIFIED.

import fs from "node:fs";
import path from "node:path";

let counter = 0;

/** `args` of a record call, plus an --evidence file when the gate would ask for one; every other call is returned unchanged. */
export function evidenceArgs(w, args) {
  if (args[0] !== "record" || args.includes("--evidence")) return args;
  const kind = args[args.indexOf("--kind") + 1];
  const status = args[args.indexOf("--status") + 1];
  if (!["storefront", "dashboard"].includes(kind) || !["PASS", "WARN"].includes(status)) return args;
  const file = path.join(w.root, `evidence-${++counter}.json`);
  const body = kind === "dashboard" ? { ok: true, value: { found: true, commentsSource: "getComments", commentCount: 1 } } : { ok: true, summary: { certification: "CERTIFIED", verdict: "PASS" } };
  fs.writeFileSync(file, JSON.stringify(body));
  return [...args, "--evidence", file];
}
