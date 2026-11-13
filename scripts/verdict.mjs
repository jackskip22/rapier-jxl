// Failures in the patched suite that the unpatched suite does not have, then a verdict on each: the test runs alone
// ten times with the patches and ten times on the unpatched commit. It is ours only when it fails alone more often
// with the patches; otherwise it is flaky. Every list and count is also printed as a ::notice annotation.
//   node verdict.mjs <baseline log> <patched log> <browser> <snapdom dir> <unpatched commit>
// Exit 1 only when a test is ours.
import {readFileSync} from 'node:fs';
import {spawnSync} from 'node:child_process';

const [baselineLog, patchedLog, browser, dir, base] = process.argv.slice(2);
const failures = file => new Set(readFileSync(file, 'utf8').replace(/\x1b\[[0-9;]*m/g, '').split('\n')
  .map(line => line.match(/(?:FAIL|×)\s+(?:\S+\s+)?(__tests__\/\S+\.test\.[jt]sx?.*?)\s*(?:\d+\s*ms)?\s*$/)?.[1]?.trim())
  .filter(Boolean));
const baseline = failures(baselineLog), patched = failures(patchedLog);
const only = (a, b) => [...a].filter(x => !b.has(x)).sort();
const suspects = only(patched, baseline), gone = only(baseline, patched), shared = [...patched].filter(x => baseline.has(x)).sort();
const clip = s => s.length > 900 ? s.slice(0, 897) + '...' : s;
const notice = (title, text) => console.log(`::notice title=${title}::${clip(text.replace(/\r?\n/g, ' '))}`);
const list = rows => rows.length ? rows.join(' ; ') : '-';
const git = (...a) => spawnSync('git', a, {cwd: dir, encoding: 'utf8'});

console.log(`only with the patches (${suspects.length})\n  ${suspects.join('\n  ')}`);
console.log(`in both (${shared.length})\n  ${shared.join('\n  ')}`);
console.log(`only without (${gone.length})\n  ${gone.join('\n  ')}`);
notice(`compare ${browser}`, `only with ${suspects.length}: ${list(suspects)} | both ${shared.length}: ${list(shared)} | without ${gone.length}: ${list(gone)}`);

// The test alone, ten times: a file and the test's own name (the last part after ' > ').
function alone(entry) {
  const [file, ...path] = entry.split(' > ');
  const name = path.at(-1) ?? '', pattern = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  let passed = 0;
  for (let i = 0; i < 10; i++) {
    const run = spawnSync('npx', ['vitest', 'run', file, '-t', pattern, '--browser.headless', '--reporter=dot'],
      {cwd: dir, encoding: 'utf8', env: {...process.env, BROWSER: browser}});
    if (run.status === 0) passed++;
  }
  return passed;
}
const counts = new Map();
if (suspects.length) {
  for (const s of suspects) counts.set(s, {with: alone(s)});
  const head = git('rev-parse', 'HEAD').stdout.trim();
  git('checkout', '-q', base);
  for (const s of suspects) counts.get(s).without = existsIn(s) ? alone(s) : null;
  git('checkout', '-q', head);
}
function existsIn(entry) { return git('cat-file', '-e', `HEAD:${entry.split(' > ')[0]}`).status === 0; }

let ours = 0;
const lines = [];
for (const s of suspects) {
  const c = counts.get(s), verdict = c.without === null ? 'ours (a file the patches add)' : c.with < c.without ? 'ours' : 'flaky';
  if (verdict.startsWith('ours') && (c.without === null ? c.with < 10 : true)) ours++;
  const line = `${s}: without ${c.without ?? '-'}/10, with ${c.with}/10 alone: ${c.without === null && c.with === 10 ? 'passes alone (the patches add this file)' : verdict}`;
  console.log(line);
  lines.push(line);
}
console.log(`${ours ? 'FAIL' : 'OK'} ${browser}: ${ours} ours, ${suspects.length - ours} flaky`);
notice(`verdict ${browser}`, `${ours} ours, ${suspects.length - ours} flaky, ${shared.length} SnapDOM's own at this commit${lines.length ? ' | ' + lines.join(' ; ') : ''}`);
process.exitCode = ours ? 1 : 0;
