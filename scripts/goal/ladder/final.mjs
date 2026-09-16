/**
 * The acceptance contract's Final condition, as a pure function so it can be tested
 * without running a ladder.
 *
 * PASS == 31 alone is not the condition. Two states hide behind a full PASS count:
 * a judged orphan unit that mergeLadder retained after its spec item vanished (it
 * keeps its FAIL verdict and is still counted), and a PASS whose receipt is missing a
 * revision-bound field. Each is excluded explicitly, so the number that opens the gate
 * is one a reader can trust rather than one that merely looks complete.
 */
export function finalHoldsFor(tally, missingReceiptFields = []) {
  return (
    (tally.PASS ?? 0) === 31 &&
    (tally.FAIL ?? 0) === 0 &&
    (tally.NOT_IMPLEMENTED ?? 0) === 0 &&
    (tally.BLOCKED ?? 0) === 0 &&
    missingReceiptFields.length === 0
  );
}
