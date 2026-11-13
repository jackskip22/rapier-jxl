// The failures the two suites do not share, then a verdict on each by the rule below (thirty alone a side; unstable
// tests sixty a side, interleaved). Counts are always passes: "passes 29/30".
// Every list and count is also printed as a ::notice annotation.
//   node verdict.mjs <baseline log> <patched log> <browser> <snapdom dir> <unpatched commit>
// Exit 1 only when a test is ours.
//
// LISTS="<title>|<first label>|<second label>": the two logs' lists as one notice under that title. Used by the order,
// A/A and swapped-order jobs: "<second label> only" are the failures the second log has and the first does not. With
// RERUN=1 (the order job: first unpatched, second patched) the verdict below follows under the same title.
// Every comparison also says how often each log holds a mock that was not in place ("mockReturnValue is not a function").
import {readFileSync, readdirSync} from 'node:fs';
import {spawnSync} from 'node:child_process';

const [firstLog, secondLog, browser, dir, base] = process.argv.slice(2);
// A half of the suite (SHARD=1/2) says so in its notices' titles.
const label = browser + (process.env.SHARD ? ' ' + process.env.SHARD : '');
// vitest lists failures in sections: "Failed Tests n" (tests, what the summary's "Tests ... n failed" counts) and
// "Failed Suites n" (a file or describe that failed as a whole, in a hook or at import). A suite line can read
// "file > describe", like a test, so the section decides. Suite failures stay in the comparison as "[suite] <name>"
// but are not counted against the summary. A log with no section headers is read line by line, all as tests.
function failures(file) {
  const tests = new Set(), suites = new Set();
  let section = null;
  for (const raw of readFileSync(file, 'utf8').replace(/\x1b\[[0-9;]*m/g, '').split('\n')) {
    const head = raw.match(/Failed (Tests|Suites) \d+/);
    if (head) { section = head[1]; continue; }
    if (/⎯{3,}.*(Unhandled|Errors)/.test(raw)) { section = 'Errors'; continue; }
    const name = raw.match(/(?:FAIL|×)\s+(?:\S+\s+)?(__tests__\/\S+\.test\.[jt]sx?.*?)\s*(?:\[[^\]]*\]\s*)?(?:\d+\s*ms)?\s*$/)?.[1]?.trim();
    if (!name || section === 'Errors') continue;
    (section === 'Suites' ? suites : tests).add(name);
  }
  return {tests, suites, all: new Set([...tests, ...[...suites].map(x => `[suite] ${x}`)])};
}
const parsedFirst = failures(firstLog), parsedSecond = failures(secondLog);
const first = parsedFirst.all, second = parsedSecond.all;
const git = (...a) => spawnSync('git', a, {cwd: dir, encoding: 'utf8'});

// The guard: a log counts only as a finished suite. It needs vitest's "Tests ... (n)" summary with n > 0. The test
// failures parsed must equal the summaries' failed counts (a network-gate rerun adds a second summary, summed). The
// two arms' test-file totals may differ only by the test files the patches add. Anything else is inconclusive, never
// "no failures".
function summary(file) {
  const text = readFileSync(file, 'utf8').replace(/\x1b\[[0-9;]*m/g, '');
  const tests = [...text.matchAll(/^\s*Tests\s+(.+?)\s+\((\d+)\)\s*$/gm)], files = text.match(/^\s*Test Files\s+(.+?)\s+\((\d+)\)\s*$/m);
  if (!tests.length || !files) return null;
  const count = (m, word) => +(m[1].match(new RegExp(`(\\d+) ${word}`))?.[1] ?? 0);
  // "Tests (n)" counts skips too: executed is passed + failed of the first (whole-suite) summary.
  return {total: +tests[0][2], executed: count(tests[0], 'passed') + count(tests[0], 'failed'),
    failed: tests.reduce((n, m) => n + count(m, 'failed'), 0), files: +files[2],
    errors: +(text.match(/^\s*Errors\s+(\d+) errors?/m)?.[1] ?? 0)};
}
// The test files the patches add, read from patches/*.patch beside this script's folder (the same in every job).
const patchDir = new URL('../patches/', import.meta.url);
const added = (() => { try { return readdirSync(patchDir).filter(f => f.endsWith('.patch'))
  .flatMap(f => [...readFileSync(new URL(f, patchDir), 'utf8').matchAll(/^diff --git a\/(__tests__\/\S+\.test\.[jt]sx?) .*\nnew file mode/gm)]).length; } catch { return 0; } })();
const inconclusive = [];
for (const [label, file, parsed] of [['first', firstLog, parsedFirst], ['second', secondLog, parsedSecond]]) {
  const sum = summary(file), tests = parsed.tests.size;
  if (!sum) inconclusive.push(`${label} log has no finished vitest summary`);
  else if (!sum.executed) inconclusive.push(`${label} log ran no tests (${sum.total} counted, all skipped)`);
  else if (sum.failed !== tests) inconclusive.push(`${label} log: summary says ${sum.failed} failed, parsed ${tests} (${[...parsed.tests].join(' ; ')})`);
}
const s1 = summary(firstLog), s2 = summary(secondLog);
// Per arm, apart from test failures: suites that failed whole and vitest's unhandled errors.
const arms = (a, b) => [[a, s1, parsedFirst], [b, s2, parsedSecond]]
  .map(([l, sum, p]) => `${l}: ran ${sum?.executed ?? '-'} tests, ${p.suites.size} suites failed, ${sum?.errors ?? '-'} unhandled errors`).join('; ');
if (s1 && s2 && Math.abs(s1.files - s2.files) > added) inconclusive.push(`test files ${s1.files} against ${s2.files} (the patches add ${added})`);
const only = (a, b) => [...a].filter(x => !b.has(x)).sort();
const secondOnly = only(second, first), firstOnly = only(first, second), shared = [...second].filter(x => first.has(x)).sort();
const clip = s => s.length > 900 ? s.slice(0, 897) + '...' : s;
const notice = (title, text) => console.log(`::notice title=${title}::${clip(text.replace(/\r?\n/g, ' '))}`);
const list = rows => rows.length ? rows.join(' ; ') : '-';
const MOCK = 'mockReturnValue is not a function';
const mocks = file => readFileSync(file, 'utf8').split(MOCK).length - 1;
const mockNote = (a, b) => `"${MOCK}": ${a} ${mocks(firstLog)}, ${b} ${mocks(secondLog)}`;

if (inconclusive.length) {
  const title = process.env.LISTS ? process.env.LISTS.split('|')[0] : 'verdict';
  console.log(`INCONCLUSIVE ${browser}: ${inconclusive.join('; ')}`);
  notice(`${title} ${label}`, `inconclusive: ${inconclusive.join('; ')}`);
  process.exit(2);
}

if (process.env.LISTS) {
  const [title, a, b] = process.env.LISTS.split('|');
  const same = !secondOnly.length && !firstOnly.length;
  console.log(`${b} only (${secondOnly.length})\n  ${secondOnly.join('\n  ')}\n${a} only (${firstOnly.length})\n  ${firstOnly.join('\n  ')}\nboth (${shared.length})`);
  notice(`${title} ${label}`, `same failures by name: ${same ? 'yes' : 'NO'} | ${arms(a, b)} | ${mockNote(a, b)} | both ${shared.length} | ${b} only ${secondOnly.length}: ${list(secondOnly)} | ${a} only ${firstOnly.length}: ${list(firstOnly)}`);
  if (!process.env.RERUN) process.exit(0);
}
const title = process.env.LISTS ? process.env.LISTS.split('|')[0] + ' verdict' : 'verdict';

console.log(`only with the patches (${secondOnly.length})\n  ${secondOnly.join('\n  ')}`);
console.log(`in both (${shared.length})\n  ${shared.join('\n  ')}`);
console.log(`only without (${firstOnly.length})\n  ${firstOnly.join('\n  ')}`);
if (!process.env.LISTS) notice(`compare ${label}`, `${arms('without', 'with')} | ${mockNote('without', 'with')} | both ${shared.length} | only with ${secondOnly.length}: ${list(secondOnly)} | only without ${firstOnly.length}: ${list(firstOnly)}`);

// The rule, the same for every rerun test whichever list it came from:
// - thirty runs alone a side, patched first, then unpatched;
// - unstable: the unpatched arm passes more than 10% and less than 90% of the time. Then sixty a side, interleaved
//   (one patched, one unpatched, alternating), and ours only at ten or more extra failures with the patches;
// - otherwise ours only at five or more extra failures of thirty with the patches; anything less is flaky.
// A test in a file the patches add has no unpatched arm: ours if it fails alone at all.
const RUNS = 30, MARGIN = 5, LONG = 60, LONG_MARGIN = 10;
const head = git('rev-parse', 'HEAD').stdout.trim();
// One run alone: a pass counts only when vitest's summary shows a test passed and none failed; a run in which no test ran
// (a startup error, a name that matched nothing) is counted as not run and makes the test inconclusive.
const notRun = new Map();
function once(entry) {
  const [file, ...path] = entry.split(' > ');
  const pattern = (path.at(-1) ?? '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const run = spawnSync('npx', ['vitest', 'run', file, '-t', pattern, '--browser.headless', '--reporter=dot'],
    {cwd: dir, encoding: 'utf8', env: {...process.env, BROWSER: browser, NO_COLOR: '1'}});
  const line = `${run.stdout}${run.stderr}`.match(/^\s*Tests\s+(.+?)\s+\(\d+\)\s*$/m)?.[1] ?? '';
  const passed = +(line.match(/(\d+) passed/)?.[1] ?? 0), failed = +(line.match(/(\d+) failed/)?.[1] ?? 0);
  if (!passed && !failed) { notRun.set(entry, (notRun.get(entry) ?? 0) + 1); return false; }
  return run.status === 0 && passed > 0 && !failed;
}
const at = commit => git('checkout', '-q', commit);
const existsIn = (entry, commit) => git('cat-file', '-e', `${commit}:${entry.split(' > ')[0]}`).status === 0;
const passes = (entry, n) => { let p = 0; for (let i = 0; i < n; i++) p += once(entry); return p; };

const sideOnly = [...secondOnly, ...firstOnly];
const counts = new Map();
if (sideOnly.length) {
  at(head);
  for (const s of sideOnly) counts.set(s, {with: passes(s, RUNS), runs: RUNS});
  at(base);
  for (const s of sideOnly) counts.get(s).without = existsIn(s, base) ? passes(s, RUNS) : null;
  for (const s of sideOnly) {
    const c = counts.get(s);
    if (c.without === null || c.without <= RUNS * 0.1 || c.without >= RUNS * 0.9) continue;
    c.unstable = true; c.with = 0; c.without = 0; c.runs = LONG;
    for (let i = 0; i < LONG; i++) { at(head); c.with += once(s); at(base); c.without += once(s); }
  }
  at(head);
}

let ours = 0, flaky = 0, unstable = 0, unknown = 0;
const lines = [];
for (const s of sideOnly) {
  const c = counts.get(s), side = secondOnly.includes(s) ? 'failed only with' : 'failed only without';
  const isOurs = c.without === null ? c.with < c.runs : c.without - c.with >= (c.unstable ? LONG_MARGIN : MARGIN);
  const verdict = notRun.get(s) ? 'inconclusive' : isOurs ? 'ours' : c.unstable ? 'unstable' : 'flaky';
  ours += verdict === 'ours'; flaky += verdict === 'flaky'; unstable += verdict === 'unstable'; unknown += verdict === 'inconclusive';
  const line = `${s} (${side} in the suite): alone${c.unstable ? ', interleaved' : ''}, passes ${c.without ?? '-'}/${c.runs} without, ${c.with}/${c.runs} with${notRun.get(s) ? `, did not run ${notRun.get(s)} times` : ''}: ${verdict}`;
  console.log(line);
  lines.push(line);
}
console.log(`${ours || unknown ? 'FAIL' : 'OK'} ${browser}: ${ours} ours, ${flaky} flaky, ${unstable} unstable, ${unknown} inconclusive`);
notice(`${title} ${label}`, `${ours} ours, ${flaky} flaky, ${unstable} unstable, ${unknown} inconclusive, ${shared.length} SnapDOM's own at this commit (${shared.filter(x => !x.startsWith('[suite] ')).length} tests, ${shared.filter(x => x.startsWith('[suite] ')).length} suites)${lines.length ? ' | ' + lines.join(' ; ') : ''}`);
process.exitCode = ours ? 1 : unknown ? 2 : 0;
