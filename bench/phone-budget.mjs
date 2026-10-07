// SPDX-License-Identifier: MIT
// Fixed-work measurements, never a timing gate or a claim about a particular phone. The Linux governor limits
// aggregate process CPU time, including worker threads, without changing encoder options or interrupting a job.
// node bench/phone-budget.mjs --inputs=inputs.json --out=results --max-pixels=1200000 --efforts=1,9 \
//   --workers=0,1,2,4 --rounds=3 --cpu-share=0.5 --cpus=0-3 --profile
// inputs.json: [{id, kind, width, height, rgbaHash (SHA-256 of the raw RGBA bytes), pixels (their path, relative to the manifest)}, ...]
import assert from 'node:assert/strict';
import {readFileSync, writeFileSync, readlinkSync, mkdirSync} from 'node:fs';
import {readFile} from 'node:fs/promises';
import {resolve, dirname, relative, join} from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {createHash} from 'node:crypto';
import {spawn, spawnSync} from 'node:child_process';
import {Worker, isMainThread, parentPort, workerData} from 'node:worker_threads';
import {cpus, arch} from 'node:os';
import {setTimeout as delay} from 'node:timers/promises';

const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const file = fileURLToPath(import.meta.url);
if (!isMainThread) {
  const {servePool} = await import(pathToFileURL(join(workerData.root, 'pool.mjs')));
  parentPort.on('message', message => { const reply = servePool(message); if (reply) parentPort.postMessage(...reply); });
} else {
  const known = new Set(['inputs', 'root', 'out', 'max-pixels', 'efforts', 'workers', 'rounds', 'cpu-share', 'cpus', 'profile', 'reference', 'child']);
  const args = Object.create(null);
  for (const arg of process.argv.slice(2)) {
    const match = /^--([a-z-]+)(?:=(.*))?$/.exec(arg);
    assert(match && known.has(match[1]), 'Unknown argument: ' + arg);
    assert(!(match[1] in args), 'Duplicate argument: ' + arg);
    args[match[1]] = match[2] ?? true;
  }
  const integers = (text, minimum, maximum) => String(text).split(',').map(value => {
    const n = Number(value); assert(Number.isSafeInteger(n) && n >= minimum && n <= maximum, 'Invalid integer: ' + value); return n;
  });
  assert(typeof args.inputs === 'string' && typeof args.out === 'string', '--inputs and --out are required');
  const ceiling = Number(args['max-pixels']);
  assert(Number.isSafeInteger(ceiling) && ceiling > 0, '--max-pixels declares the positive fixed-work ceiling per corpus pass');
  const out = resolve(args.out), root = resolve(args.root || fileURLToPath(new URL('../src/', import.meta.url)));
  const efforts = integers(args.efforts ?? '1,2,3,4,5,6,7,8,9', 1, 9), workers = integers(args.workers ?? '0,1,2,4', 0, 4);
  const rounds = Number(args.rounds ?? 3);
  assert(Number.isSafeInteger(rounds) && rounds > 0, '--rounds is a positive integer');
  const share = args['cpu-share'] === undefined ? null : Number(args['cpu-share']);
  assert(share === null || Number.isFinite(share) && share > 0, '--cpu-share is a positive number of CPU seconds per wall second');
  const manifestFile = resolve(args.inputs), inputBytes = readFileSync(manifestFile), manifest = JSON.parse(inputBytes);
  assert(Array.isArray(manifest) && manifest.length, 'The manifest is a nonempty array');
  assert.equal(new Set(manifest.map(item => item.id)).size, manifest.length, 'Input IDs must be unique');
  let pixels = 0;
  for (const item of manifest) {
    assert(/^[a-zA-Z0-9_-]+$/.test(item.id), 'Input IDs use letters, digits, underscores and hyphens');
    assert(Number.isSafeInteger(item.width) && item.width > 0 && Number.isSafeInteger(item.height) && item.height > 0, 'Invalid dimensions');
    assert(/^[0-9a-f]{64}$/.test(item.rgbaHash), 'Every input has a SHA256');
    pixels += item.width * item.height;
  }
  assert(Number.isSafeInteger(pixels) && pixels <= ceiling, 'Corpus exceeds the declared fixed-work ceiling');
  mkdirSync(out, {recursive: true});

  if (!args.child && (share !== null || args.profile || args.cpus)) {
    assert(process.platform === 'linux' || share === null && !args.cpus, 'CPU governance and affinity require Linux');
    const profileArgs = args.profile ? ['--cpu-prof', '--cpu-prof-dir=' + out] : [];
    const invocation = [...profileArgs, file, ...process.argv.slice(2), '--child'];
    const command = args.cpus ? 'taskset' : process.execPath;
    const commandArgs = args.cpus ? ['-c', String(args.cpus), process.execPath, ...invocation] : invocation;
    const child = spawn(command, commandArgs, {stdio: ['inherit', 'inherit', 'inherit', 'ipc']}), started = performance.now();
    let ended = false, paused = false, pauses = 0, stoppedMs = 0, cpuSeconds = 0, observations = 0;
    const finished = new Promise(done => { child.once('error', error => { ended = true; done({code: 1, error: error.message}); }); child.once('exit', (code, signal) => { ended = true; done({code, signal}); }); });
    // The mounted /proc may expose a different PID namespace. The child identifies only its own accounting path.
    const procId = await new Promise(done => { child.once('message', message => done(message.procId)); child.once('exit', () => done(null)); child.once('error', () => done(null)); });
    const tick = share === null ? 0 : Number(spawnSync('getconf', ['CLK_TCK'], {encoding: 'utf8'}).stdout);
    assert(share === null || tick > 0, 'Cannot read the Linux CPU accounting frequency');
    while (!ended && share !== null) {
      try {
        assert(/^\d+$/.test(procId), 'The child did not identify its CPU accounting path');
        const stat = await readFile('/proc/' + procId + '/stat', 'utf8'), fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
        cpuSeconds = (Number(fields[11]) + Number(fields[12])) / tick;
        observations++;
        const aheadMs = 1000 * cpuSeconds / share - (performance.now() - started);
        if (aheadMs > 10) {
          const stopped = performance.now(); child.kill('SIGSTOP'); paused = true; pauses++;
          await delay(Math.min(aheadMs, 200));
          child.kill('SIGCONT'); paused = false; stoppedMs += performance.now() - stopped;
        } else await delay(5);
      } catch (error) { if (!ended && error.code !== 'ENOENT') { if (paused) child.kill('SIGCONT'); child.kill('SIGTERM'); throw error; } }
    }
    const result = await finished;
    writeFileSync(join(out, 'governor.json'), JSON.stringify({cpuSecondsPerWallSecond: share, affinity: args.cpus ?? null,
      accountingHz: tick || null, pollingMs: 5, pauseThresholdMs: 10, pauses, stoppedMs, observations, observedCpuSeconds: cpuSeconds,
      wallMs: performance.now() - started, exit: result,
      meaning: 'Synthetic aggregate CPU envelope on this host. No ARM, thermal, frequency, battery or browser equivalence is inferred.'}, null, 2) + '\n');
    assert(share === null || observations > 0, 'CPU governance recorded no accounting observations');
    process.exitCode = result.code ?? 1;
  } else {
    if (process.send) { process.send({procId: process.platform === 'linux' ? readlinkSync('/proc/self') : null}); process.disconnect(); }
    const files = new Map();
    const visit = name => {
      if (files.has(name)) return;
      const bytes = readFileSync(name); files.set(name, hash(bytes));
      for (const match of bytes.toString().matchAll(/\b(?:from\s*|import\s*)['"](\.[^'"]+)['"]/g)) visit(resolve(dirname(name), match[1]));
    };
    visit(join(root, 'effort.mjs')); visit(join(root, 'pool.mjs'));
    const sourceHashes = Object.fromEntries([...files].map(([name, sha256]) => [relative(root, name), sha256]).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0));
    const {encode} = await import(pathToFileURL(join(root, 'effort.mjs'))), {encodePool} = await import(pathToFileURL(join(root, 'pool.mjs')));
    const members = [];
    const spawnWorker = () => {
      // Profiles describe the caller. Worker time is included in aggregate CPU accounting, without per-job profile files.
      const thread = new Worker(import.meta.url, {workerData: {root}, execArgv: []});
      let ending = false;
      const worker = {postMessage: (message, transfer) => thread.postMessage(message, transfer),
        terminate: () => { ending = true; return thread.terminate(); }, onmessage: null, onerror: null};
      members.push(new Promise(done => thread.once('exit', done)));
      thread.on('message', data => worker.onmessage?.({data})); thread.on('error', error => worker.onerror?.(error));
      thread.on('exit', code => { if (!ending) worker.onerror?.(new Error('Worker exited: ' + code)); });
      return worker;
    };
    const report = {complete: false, node: process.version, platform: process.platform, arch: arch(), machine: cpus()[0]?.model,
      mode: share === null ? 'Host CPU, ungoverned' : 'Synthetic aggregate CPU envelope', cpuSecondsPerWallSecond: share,
      affinity: args.cpus ?? null, workerMeaning: 'Additional worker threads; the caller also codes groups. Zero calls the synchronous effort entry.',
      profileMeaning: 'V8 caller samples; worker threads excluded from profiles and included in process CPU samples.',
      cpuMeaning: 'cpuMs is aggregate process CPU; callerCpuMs is current-thread CPU. Both exclude voluntary pauses and blocked wall time.',
      root, sourceHashes, sourceSha256: hash(JSON.stringify(sourceHashes)), benchmarkSha256: hash(readFileSync(file)),
      inputSha256: hash(inputBytes), fixedWork: {ceilingPixels: ceiling, pixels, inputs: manifest.length, efforts, workers,
        warmupsPerCombination: 1, rounds, encodes: manifest.length * efforts.length * workers.length * (rounds + 1)}, rows: []};
    const save = () => writeFileSync(join(out, 'measurement.json'), JSON.stringify(report, null, 2) + '\n');
    save();
    for (const item of manifest) {
      const data = new Uint8Array(readFileSync(resolve(dirname(manifestFile), item.pixels)));
      assert.equal(data.length, item.width * item.height * 4); assert.equal(hash(data), item.rgbaHash);
      for (const effort of efforts) for (const workerCount of workers) {
        const name = item.id + '-e' + effort + '-w' + workerCount + '.jxl', samples = [];
        let reference;
        for (let round = 0; round <= rounds; round++) {
          const start = performance.now(), cpu = process.cpuUsage(), callerCpu = process.threadCpuUsage();
          let bytes;
          if (workerCount) {
            const job = encodePool(data, item.width, item.height, {effort}, {spawn: spawnWorker, workers: workerCount});
            for await (const _ of job); bytes = job.bytes;
          } else bytes = encode(data, item.width, item.height, {effort});
          const wallMs = performance.now() - start, used = process.cpuUsage(cpu), callerUsed = process.threadCpuUsage(callerCpu);
          if (!reference) reference = bytes; else assert.deepEqual(bytes, reference, 'Repeated encode changed bytes');
          if (round) samples.push({wallMs, cpuMs: (used.user + used.system) / 1000, callerCpuMs: (callerUsed.user + callerUsed.system) / 1000});
          await Promise.all(members.splice(0));
        }
        if (args.reference) assert.deepEqual(reference, new Uint8Array(readFileSync(join(resolve(args.reference), name))), 'Reference stream differs: ' + name);
        writeFileSync(join(out, name), reference);
        const row = {id: item.id, kind: item.kind, width: item.width, height: item.height, rgbaHash: item.rgbaHash,
          effort, workers: workerCount, bytes: reference.length, sha256: hash(reference), samples};
        report.rows.push(row); save(); console.log(JSON.stringify(row));
      }
      assert.equal(hash(data), item.rgbaHash, 'Input was mutated');
    }
    for (const [name, sha256] of files) assert.equal(hash(readFileSync(name)), sha256, 'Encoder source changed during measurement');
    assert.equal(hash(readFileSync(manifestFile)), report.inputSha256, 'Input manifest changed during measurement');
    report.peakRSSKiB = process.resourceUsage().maxRSS; report.complete = true; save();
  }
}
