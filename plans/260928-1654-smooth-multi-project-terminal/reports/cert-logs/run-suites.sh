#!/bin/sh
LOGS=plans/260928-1654-smooth-multi-project-terminal/reports/cert-logs
run_suite() {
  key="$1"; f="$2"
  start=$(date +%s%3N)
  node --test "$f" > "$LOGS/$key.log" 2>&1
  code=$?
  end=$(date +%s%3N)
  dur=$((end - start))
  summary_pass=$(grep -oE '^# pass [0-9]+' "$LOGS/$key.log" | head -1 | awk '{print $3}')
  summary_fail=$(grep -oE '^# fail [0-9]+' "$LOGS/$key.log" | head -1 | awk '{print $3}')
  summary_dur=$(grep -oE '^# duration_ms [0-9.]+' "$LOGS/$key.log" | head -1 | awk '{print $3}')
  echo "$key | exit=$code | #pass=$summary_pass #fail=$summary_fail | suite_dur=${summary_dur}ms | wall=${dur}ms"
}
run_suite 01-output-router .compiled/test/main/terminal-output-router.test.js
run_suite 02-lazy-pane .compiled/test/renderer/terminal-lazy-pane.test.js
run_suite 03-backpressure .compiled/test/unit/browser/terminal-backpressure.test.js
run_suite 04-output-batcher .compiled/test/unit/terminal-daemon/output-batcher.test.js
run_suite 05-tab-hibernation .compiled/test/unit/browser/tab-hibernation.test.js
run_suite 06-sleep-lifecycle .compiled/test/unit/browser/terminal-sleep-lifecycle.test.js
run_suite 07-presented-view .compiled/test/unit/native-tab-host-presented-view.test.js
run_suite 08-transcript .compiled/test/unit/browser/terminal-transcript-lifecycle.test.js
run_suite 09-daemon-batching-e2e .compiled/test/e2e/terminal-daemon-batching.test.js
run_suite 10-rename-remove .compiled/test/main/project-rename-remove.test.js
run_suite 11-open-picker .compiled/test/renderer/project-open-picker.test.js
run_suite 12-daemon-provenance .compiled/test/main/terminal-daemon-provenance.test.js
