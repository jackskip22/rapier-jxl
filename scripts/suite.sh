#!/bin/bash
# suite.sh <log> [vitest arguments...]: one whole-suite arm, run from SnapDOM's checkout with BROWSER set.
#
# WebKit's page can crash mid-suite ("Browser connection was closed", seen at visual.demos.5 in runs 13 and 15),
# after which vitest prints its summary and never exits. Every arm here therefore:
# - starts with no browser left over from an earlier arm (each is stopped by its exact PID);
# - runs WebKit with two workers (SnapDOM's own config notes WebKit runs out of room at the default);
# - ends after ARM_MINUTES (default 30) with a red that can be read, never a job cancelled at its limit;
# - after a crash, keeps that log as <log>.crashed and runs the arm once more in a fresh browser.
# Both arms of a comparison go through this script, so they are treated the same.
log=$1; shift
# Browser processes by name prefix (ps cuts a name at 15 characters: WPENetworkProcess reads WPENetworkProce).
browsers='MiniBrowser|WPE|WebKit|firefox|Web Content|chrome|headless_shell'
stop_browsers() {
  for pid in $(ps -eo pid=,comm= | awk -v re="^($browsers)" '{pid=$1; $1=""; sub(/^ /, "")} $0 ~ re {print pid}'); do kill -9 "$pid" 2>/dev/null; done
}
workers=(); [ "$BROWSER" = webkit ] && workers=(--maxWorkers=2)
run() {
  stop_browsers
  set -o pipefail
  timeout -k 60 "${ARM_MINUTES:-30}m" node scripts/vitest.mjs run "$@" "${workers[@]}" --browser.headless --reporter=dot 2>&1 | tee "$log"
  local code=$?
  [ "$code" = 124 ] && echo "::warning::$(basename "$log"): stopped after ${ARM_MINUTES:-30} minutes"
  stop_browsers
  return $code
}
run "$@"; code=$?
crashed=$(grep -o 'Failed to run the test `[^`]*`' "$log" | head -1)
if grep -q 'Browser connection was closed' "$log"; then
  echo "::warning::$(basename "$log"): the page crashed (${crashed:-no file named}); the arm runs again in a fresh browser"
  mv "$log" "$log.crashed"
  run "$@"; code=$?
  grep -q 'Browser connection was closed' "$log" && echo "::warning::$(basename "$log"): the page crashed again ($(grep -o 'Failed to run the test `[^`]*`' "$log" | head -1))"
fi
exit $code
