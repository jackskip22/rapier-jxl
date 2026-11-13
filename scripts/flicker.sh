#!/bin/bash
# Each named test alone, ten times, in one engine: prints "<label> <engine> passes n/10 <file> > <name>".
#   bash flicker.sh <browser> <label> < tests.txt     (lines: <file>|<test name>)
set -u
browser=$1; label=$2
while IFS='|' read -r file name; do
  [ -z "$file" ] && continue
  passed=0
  for i in $(seq 10); do
    if BROWSER=$browser npx vitest run "__tests__/$file" -t "$name" --browser.headless --reporter=dot > /dev/null 2>&1; then passed=$((passed + 1)); fi
  done
  echo "$label $browser passes $passed/10 $file > $name"
  echo "::notice title=flicker $browser::$file > $name: $label, passes $passed/10"
done
