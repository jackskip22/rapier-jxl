// Failures in the patched suite that the unpatched suite does not have, then a verdict on each: the test runs alone
// thirty times with the patches and thirty times on the unpatched commit. It is ours only when it fails alone in at
// least five more of the thirty runs with the patches; otherwise it is flaky. Counts are always passes: "passes 29/30".
// Every list and count is also printed as a ::notice annotation.
//   node verdict.mjs <baseline log> <patched log> <browser> <snapdom dir> <unpatched commit>
// Exit 1 only when a test is ours.
//
// LISTS="<title>|<first label>|<second label>": the two logs' lists as one notice under that title. Used by the order,
// A/A and swapped-order jobs: "<second label> only" are the failures the second log has and the first does not. With
// RERUN=1 (the order job: first unpatched, second patched) the verdict below follows under the same title.
// Every comparison also says how often each log holds a mock that was not in place ("mockReturnValue is not a function").
import {readFileSync} from 'node:fs';
import {spawnSync} from 'node:child_process';

const [firstLog, secondLog, browser, dir, base] = process.argv.slice(2);
const failures = file => new Set(readFileSync(file, 'utf8').replace(/\x1b\[[0-9;]*m/g, '').split('\n')
  .map(line => line.match(/(?:FAIL|×)\s+(?:\S+\s+)?(__tests__\/\S+\.test\.[jt]sx?.*?)\s*(?:\d+\s*ms)?\s*$/)?.[1]?.trim())
  .filter(Boolean));
const first = failures(firstLog), second = failures(secondLog);
const only = (a, b) => [...a].filter(x => !b.has(x)).sort();
const secondOnly = only(second, first), firstOnly = only(first, second), shared = [...second].filter(x => first.has(x)).sort();
const clip = s => s.length > 900 ? s.slice(0, 897) + '...' : s;
const notice = (title, text) => console.log(`::notice title=${title}::${clip(text.replace(/\r?\n/g, ' '))}`);
const list = rows => rows.length ? rows.join(' ; ') : '-';
const git = (...a) => spawnSync('git', a, {cwd: dir, encoding: 'utf8'});
const MOCK = 'mockReturnValue is not a function';
const mocks = file => readFileSync(file, 'utf8').split(MOCK).length - 1;
const mockNote = (a, b) => `"${MOCK}": ${a} ${mocks(firstLog)}, ${b} ${mocks(secondLog)}`;

if (process.env.LISTS) {
  const [title, a, b] = process.env.LISTS.split('|');
  const same = !secondOnly.length && !firstOnly.length;
  console.log(`${b} only (${secondOnly.length})\n  ${secondOnly.join('\n  ')}\n${a} only (${firstOnly.length})\n  ${firstOnly.join('\n  ')}\nboth (${shared.length})`);
  notice(`${title} ${browser}`, `same failures by name: ${same ? 'yes' : 'NO'} | ${b} only ${secondOnly.length}: ${list(secondOnly)} | ${a} only ${firstOnly.length}: ${list(firstOnly)} | both ${shared.length} | ${mockNote(a, b)}`);
  if (!process.env.RERUN) process.exit(0);
}
const title = process.env.LISTS ? process.env.LISTS.split('|')[0] + ' verdict' : 'verdict';

console.log(`only with the patches (${secondOnly.length})\n  ${secondOnly.join('\n  ')}`);
console.log(`in both (${shared.length})\n  ${shared.join('\n  ')}`);
console.log(`only without (${firstOnly.length})\n  ${firstOnly.join('\n  ')}`);
if (!process.env.LISTS) notice(`compare ${browser}`, `only with ${secondOnly.length}: ${list(secondOnly)} | both ${shared.length}: ${list(shared)} | without ${firstOnly.length}: ${list(firstOnly)} | ${mockNote('without', 'with')}`);

const RUNS = 30, MARGIN = 5;
// The test alone, RUNS times: a file and the test's own name (the last part after ' > '). Returns the passes.
function alone(entry) {
  const [file, ...path] = entry.split(' > ');
  const name = path.at(-1) ?? '', pattern = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  let passed = 0;
  for (let i = 0; i < RUNS; i++) {
    const run = spawnSync('npx', ['vitest', 'run', file, '-t', pattern, '--browser.headless', '--reporter=dot'],
      {cwd: dir, encoding: 'utf8', env: {...process.env, BROWSER: browser}});
    if (run.status === 0) passed++;
  }
  return passed;
}
const existsIn = entry => git('cat-file', '-e', `HEAD:${entry.split(' > ')[0]}`).status === 0;
// Every test on one side only, both ways: the patched arm first, then the unpatched commit, then back.
const sideOnly = [...secondOnly, ...firstOnly];
const counts = new Map();
if (sideOnly.length) {
  for (const s of sideOnly) counts.set(s, {with: alone(s)});
  const head = git('rev-parse', 'HEAD').stdout.trim();
  git('checkout', '-q', base);
  for (const s of sideOnly) counts.get(s).without = existsIn(s) ? alone(s) : null;
  git('checkout', '-q', head);
}

let ours = 0;
const lines = [];
for (const s of secondOnly) {
  const c = counts.get(s);
  // A file the patches add has no unpatched arm: ours if it fails alone at all.
  const isOurs = c.without === null ? c.with < RUNS : c.without - c.with >= MARGIN;
  ours += isOurs;
  const line = `${s}: alone, passes ${c.without ?? '-'}/${RUNS} without, ${c.with}/${RUNS} with: ${isOurs ? 'ours' : 'flaky'}`;
  console.log(line);
  lines.push(line);
}
for (const s of firstOnly) {
  const c = counts.get(s);
  const line = `${s} (failed only without): alone, passes ${c.without ?? '-'}/${RUNS} without, ${c.with}/${RUNS} with`;
  console.log(line);
  lines.push(line);
}
console.log(`${ours ? 'FAIL' : 'OK'} ${browser}: ${ours} ours, ${secondOnly.length - ours} flaky (ours = at least ${MARGIN} more failures of ${RUNS} with the patches)`);
notice(`${title} ${browser}`, `${ours} ours, ${secondOnly.length - ours} flaky, ${shared.length} SnapDOM's own at this commit${lines.length ? ' | ' + lines.join(' ; ') : ''}`);
process.exitCode = ours ? 1 : 0;
