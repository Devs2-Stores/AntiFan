#!/usr/bin/env node
/**
 * AntiFan B-Lite v2 Contract Validator
 *
 * Validates FixRequest v2 / FixResult v2 schemas, worked example pair,
 * and deliberate invalid examples for each refusal class.
 *
 * Runs with pure Node.js built-ins (no external npm dependencies).
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  DECISIONS,
  auditSelfVerification,
  auditToolSurface,
  auditTouchedPaths,
  auditDiffBudget,
  auditScopeExpansion,
  DEFAULT_FORBIDDEN_PATHS,
  DEFAULT_FORBIDDEN_TOOLS,
  DEFAULT_PERMITTED_TOOLS,
} from "../../../../.canary/tools/fix-loop/audits.mjs";


const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const EXTENSION_ROOT = path.resolve(__dirname, "..");

// Typed decision codes (exact strings)
const DECISION_CODES = DECISIONS;

/**
 * Pure contract audit function: evaluates request, result, and context using shared audits.mjs,
 * returning a typed decision code.
 */
function auditContract(request, result, context = {}) {
  // Gate 1: Self-verification claim is strictly forbidden
  const selfVerifyRes = auditSelfVerification(result.selfVerificationClaimed);
  if (selfVerifyRes.decision !== DECISION_CODES.OK) {
    return selfVerifyRes.decision;
  }

  // Gate 2: Tool surface validation
  // The pattern lists are policy and live in audits.mjs alone (the hook and the merge gate import
  // the same constants); schemas/tool-surface.json documents the shape. The declaration itself may
  // be an array or { usedTools }, which auditToolSurface normalizes.
  const toolSurfaceRes = auditToolSurface(
    result.toolSurface,
    DEFAULT_FORBIDDEN_TOOLS,
    DEFAULT_PERMITTED_TOOLS
  );
  if (toolSurfaceRes.decision !== DECISION_CODES.OK) {
    return toolSurfaceRes.decision;
  }

  // Gate 3: Base manifest drift detection
  if (context.currentBaseManifestHash && context.currentBaseManifestHash !== request.baseManifestHash) {
    return DECISION_CODES.REFUSED_DRIFT;
  }

  // Gate 4: Touched paths audit (touchedPaths ⊆ allowedFiles, no forbiddenPaths)
  // The default forbidden set is policy and a request may only add to it: an omitted
  // or empty `forbiddenPaths` must never un-forbid src/**, package.json, or the
  // manifest itself.
  const touchedRes = auditTouchedPaths(
    result.touchedPaths || [],
    request.allowedFiles || [],
    [...new Set([...DEFAULT_FORBIDDEN_PATHS, ...(request.forbiddenPaths || [])])]
  );
  if (touchedRes.decision !== DECISION_CODES.OK) {
    return touchedRes.decision;
  }

  // Gate 5: Diff budget audit — auditDiffBudget(touchedPaths, totalBytesChanged, diffBudget).
  // The byte total is the fixer's declared change volume and the file count the touched
  // list; one call enforces both ceilings, so there is no second, weaker check to
  // disagree with it.
  const diffBudgetRes = auditDiffBudget(
    result.touchedPaths || [],
    result.budgets?.bytes ?? 0,
    request.diffBudget
  );
  if (diffBudgetRes.decision !== DECISION_CODES.OK) {
    return diffBudgetRes.decision;
  }

  // Gate 6: Scope expansion audit (|T \ R| <= maxScopeExpansion)
  const scopeRes = auditScopeExpansion(
    result.touchedPaths || [],
    request.requestedTargets || [],
    request.maxScopeExpansion
  );
  if (scopeRes.decision !== DECISION_CODES.OK) {
    return scopeRes.decision;
  }

  return DECISION_CODES.OK;
}

/**
 * Validates that an object contains required properties and no snapshot artifact fields.
 */
function validateSchemaContract(obj, requiredFields, objectName) {
  const missing = requiredFields.filter((f) => !(f in obj));
  if (missing.length > 0) {
    throw new Error(`${objectName} missing required fields: ${missing.join(", ")}`);
  }

  // Enforce invariant: No HTML/CSS snapshot artifact
  const bannedSnapshotKeys = [
    "htmlSnapshot",
    "cssSnapshot",
    "domSnapshot",
    "snapshotArtifact",
    "htmlContent",
    "cssContent",
  ];
  for (const key of bannedSnapshotKeys) {
    if (key in obj) {
      throw new Error(`${objectName} carries forbidden snapshot artifact field '${key}'`);
    }
  }
}

/**
 * Main execution runner.
 */
function main() {
  const results = [];
  let failures = 0;

  console.log("AntiFan B-Lite v2 Contract Validation");
  console.log("=====================================");

  // 1. Schema Invariant Check (No HTML/CSS Snapshot)
  try {
    const reqSchema = JSON.parse(
      fs.readFileSync(path.join(EXTENSION_ROOT, "schemas/fix-request.v2.schema.json"), "utf8")
    );
    const resSchema = JSON.parse(
      fs.readFileSync(path.join(EXTENSION_ROOT, "schemas/fix-result.v2.schema.json"), "utf8")
    );

    const schemaStr = JSON.stringify(reqSchema) + JSON.stringify(resSchema);
    if (/htmlSnapshot|cssSnapshot|domSnapshot/i.test(schemaStr)) {
      throw new Error("Schema definitions reference forbidden snapshot artifacts");
    }
    results.push({ name: "no-snapshot-artifact", pass: true, detail: "Schema contains no HTML/CSS snapshot artifact" });
  } catch (err) {
    failures++;
    results.push({ name: "no-snapshot-artifact", pass: false, detail: err.message });
  }

  // 2. Worked Example Pair
  try {
    const workedRequest = JSON.parse(
      fs.readFileSync(path.join(EXTENSION_ROOT, "examples/worked-request.json"), "utf8")
    );
    const workedResult = JSON.parse(
      fs.readFileSync(path.join(EXTENSION_ROOT, "examples/worked-result.json"), "utf8")
    );

    validateSchemaContract(
      workedRequest,
      [
        "runId",
        "fixId",
        "surfaceId",
        "stagedRoot",
        "baseManifestHash",
        "allowedFiles",
        "forbiddenPaths",
        "diffBudget",
        "maxScopeExpansion",
        "requestedTargets",
        "evidenceRefs",
        "targetCauseCode",
        "returnShape",
      ],
      "worked-request"
    );

    validateSchemaContract(
      workedResult,
      [
        "decision",
        "touchedPaths",
        "budgets",
        "expandedPaths",
        "missingPaths",
        "toolSurface",
        "selfVerificationClaimed",
        "notes",
      ],
      "worked-result"
    );

    const decision = auditContract(workedRequest, workedResult);
    if (decision !== DECISION_CODES.OK) {
      throw new Error(`Worked example failed audit with decision: ${decision} (expected OK)`);
    }
    results.push({ name: "worked-example-pair", pass: true, detail: `decision: ${decision} (expected OK)` });
  } catch (err) {
    failures++;
    results.push({ name: "worked-example-pair", pass: false, detail: err.message });
  }

  // 3. Deliberately Invalid Examples (one per refusal class)
  const invalidCases = [
    { file: "refused-touched-path.json", expected: DECISION_CODES.REFUSED_TOUCHED_PATH },
    { file: "refused-diff-budget.json", expected: DECISION_CODES.REFUSED_DIFF_BUDGET },
    { file: "refused-diff-budget-bytes.json", expected: DECISION_CODES.REFUSED_DIFF_BUDGET },
    { file: "refused-forbidden-default.json", expected: DECISION_CODES.REFUSED_TOUCHED_PATH },
    { file: "refused-scope-expansion.json", expected: DECISION_CODES.REFUSED_SCOPE_EXPANSION },
    { file: "refused-drift.json", expected: DECISION_CODES.REFUSED_DRIFT },
    { file: "refused-tool-surface.json", expected: DECISION_CODES.REFUSED_TOOL_SURFACE },
    { file: "refused-self-verification.json", expected: DECISION_CODES.REFUSED_SELF_VERIFICATION },
  ];

  for (const testCase of invalidCases) {
    const testPath = path.join(EXTENSION_ROOT, "examples/invalid", testCase.file);
    try {
      if (!fs.existsSync(testPath)) {
        throw new Error(`Test file not found: ${testPath}`);
      }

      const caseData = JSON.parse(fs.readFileSync(testPath, "utf8"));
      const expected = caseData.expectedDecision || testCase.expected;

      if (caseData.expectedDecision && testCase.expected && caseData.expectedDecision !== testCase.expected) {
        throw new Error(
          `Expected code mismatch for '${testCase.file}': file specifies '${caseData.expectedDecision}', test expects '${testCase.expected}'`
        );
      }

      const actualDecision = auditContract(caseData.request, caseData.result, caseData.context);

      if (actualDecision !== expected) {
        throw new Error(
          `Decision mismatch for '${testCase.file}': got '${actualDecision}', expected '${expected}'`
        );
      }

      results.push({
        name: testCase.file.replace(".json", ""),
        pass: true,
        detail: `decision: ${actualDecision} (expected ${testCase.expected})`,
      });
    } catch (err) {
      failures++;
      results.push({
        name: testCase.file.replace(".json", ""),
        pass: false,
        detail: err.message,
      });
    }
  }

  // Print results
  for (const r of results) {
    const status = r.pass ? "PASS" : "FAIL";
    console.log(`[${status}] ${r.name}: ${r.detail}`);
  }

  console.log("-------------------------------------");
  const passed = results.filter((r) => r.pass).length;
  const total = results.length;
  console.log(`SUMMARY: ${passed}/${total} contract validation cases passed (${failures} failures)`);

  if (failures > 0) {
    process.exit(1);
  }
}

main();
