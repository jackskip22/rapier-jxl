// Failures in the patched suite that the unpatched suite does not have.
//   node compare.mjs <baseline log> <patched log>
// Reads vitest's FAIL lines (colors off), without the engine label or timings. Exit 1 when a failure is new.
import {readFileSync} from 'node:fs';
const failures = file => new Set(readFileSync(file, 'utf8').replace(/\x1b\[[0-9;]*m/g, '').split('\n')
  .map(line => line.match(/(?:FAIL|×)\s+(?:\S+\s+)?(__tests__\/\S+\.test\.[jt]sx?.*?)\s*(?:\d+\s*ms)?\s*$/)?.[1]?.trim())
  .filter(Boolean));
const [baseline, patched] = process.argv.slice(2).map(failures);
const only = (a, b) => [...a].filter(x => !b.has(x)).sort();
const ours = only(patched, baseline), gone = only(baseline, patched), shared = [...patched].filter(x => baseline.has(x)).sort();
const list = (title, rows) => console.log(`${title} (${rows.length})${rows.length ? '\n  ' + rows.join('\n  ') : ''}`);
list('Failing only with the patches (ours)', ours);
list('Failing in both (SnapDOM at this commit)', shared);
list('Failing only without the patches', gone);
process.exitCode = ours.length ? 1 : 0;
