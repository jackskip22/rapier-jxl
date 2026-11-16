#!/usr/bin/env bash
set -euo pipefail
cd -- "$(dirname -- "$0")"
compiler="${KOTLINC:-kotlinc}"
if ! command -v "$compiler" >/dev/null 2>&1; then
  echo 'JXL_TEST_TOOLCHAIN: Install Kotlin or set KOTLINC; alternatively run ./gradlew testDebugUnitTest.' >&2
  exit 1
fi
work="$(mktemp -d)"
trap 'rm -rf -- "$work"' EXIT
"$compiler" -J-Xmx256m \
  app/src/main/java/app/rapier/jxlexample/BridgeProtocol.kt \
  app/src/test/java/app/rapier/jxlexample/BridgeProtocolChecks.kt \
  -include-runtime -d "$work/bridge-checks.jar"
java -Xmx256m -jar "$work/bridge-checks.jar"
