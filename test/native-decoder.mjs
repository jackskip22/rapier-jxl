// SPDX-License-Identifier: MIT
// Persistent native oracle for development, with caller-sized output bounds and one request at a time.
import {spawn, spawnSync} from 'node:child_process';
import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';

export async function nativeDecoder({executable = process.env.JXL_FUZZ_NATIVE, timeout = 30000, float = false, format = float ? 'float32' : 'uint8', source = false, metadata = false} = {}) {
  if (!Number.isSafeInteger(timeout) || timeout < 1) throw new Error('Native oracle timeout must be a positive integer');
  if (!['uint8', 'uint16', 'float16', 'float32'].includes(format)) throw new Error('Unknown native oracle sample format');
  const sampleBytes = format === 'float32' ? 4 : format === 'uint8' ? 1 : 2;
  let temporary;
  if (!executable) {
    temporary = await mkdtemp(join(tmpdir(), 'jxl-native-')); executable = join(temporary, 'decode');
    const include = process.env.JXL_FUZZ_NATIVE_INCLUDE, library = process.env.JXL_FUZZ_NATIVE_LIB || '-ljxl';
    const build = spawnSync(process.env.CC || 'cc', ['-O2', '-std=c11', '-Wall', '-Wextra', ...(include ? ['-I', include] : []),
      fileURLToPath(new URL('./native-decoder.c', import.meta.url)), library, '-o', executable], {encoding: 'utf8', timeout, killSignal: 'SIGKILL'});
    if (build.status !== 0) { await rm(temporary, {recursive: true, force: true}); throw new Error('Native oracle needs a C compiler and libjxl development headers/library: ' + (build.error || build.stderr)); }
  }
  const args = format === 'float32' ? ['--float'] : format === 'uint16' ? ['--uint16'] : format === 'float16' ? ['--float16'] : [];
  if (source) args.push('--source'); if (metadata) args.push('--metadata');
  const child = spawn(executable, args, {stdio: ['pipe', 'pipe', 'pipe']});
  let queued = [], available = 0, waiting, failure, stderr = '', closed = false, closing;
  const ended = new Promise(resolve => child.once('close', resolve));
  const stop = error => { failure ||= error; if (waiting) { waiting.reject(failure); waiting = null; } };
  const take = length => {
    const bytes = Buffer.allocUnsafe(length); let at = 0;
    while (at < length) { const chunk = queued[0], count = Math.min(chunk.length, length - at); chunk.copy(bytes, at, 0, count); at += count;
      if (count === chunk.length) queued.shift(); else queued[0] = chunk.subarray(count); }
    available -= length; return bytes;
  };
  child.stdout.on('data', chunk => { queued.push(chunk); available += chunk.length; if (waiting && available >= waiting.length) {
    const job = waiting; waiting = null; job.resolve(take(job.length));
  } });
  child.stderr.on('data', chunk => { if (stderr.length < 8192) stderr += chunk; });
  child.on('error', stop); child.stdin.on('error', stop);
  child.on('exit', (code, signal) => { if (!closed) stop(new Error(`Native decoder exited (${code ?? signal}): ${stderr}`)); });
  const read = length => {
    if (failure) return Promise.reject(failure);
    if (available >= length) return Promise.resolve(take(length));
    return new Promise((resolve, reject) => { waiting = {length, resolve, reject}; });
  };
  const deadline = () => setTimeout(() => { stop(new Error('Native decoder timed out')); child.kill('SIGKILL'); }, timeout);
  const shutdown = async force => {
    closed = true;
    if (force) child.kill('SIGKILL'); else child.stdin.end();
    const timer = setTimeout(() => child.kill('SIGKILL'), timeout);
    try { await ended; }
    finally { clearTimeout(timer); if (temporary) await rm(temporary, {recursive: true, force: true}); }
  };
  let greeting;
  const startupTimer = deadline();
  try {
    greeting = await read(8);
    if (greeting.readUInt32LE(0) !== 0x314c584a) throw new Error('Native decoder protocol mismatch');
  } catch (error) { await shutdown(true); throw error; }
  finally { clearTimeout(startupTimer); }
  const version = greeting.readUInt32LE(4); let chain = Promise.resolve(), decodes = 0, lastMetadata;
  return {
    version: `${Math.floor(version / 1000000)}.${Math.floor(version / 1000) % 1000}.${version % 1000}`,
    get decodes() { return decodes; },
    get metadata() { return lastMetadata; },
    decode(bytes, width, height) {
      if (closing) return Promise.reject(new Error('Native decoder is closing'));
      const run = async () => {
        if (!(bytes instanceof Uint8Array) || !bytes.length || bytes.length > 16777216 || !Number.isInteger(width) || !Number.isInteger(height) ||
          width < 1 || height < 1 || width > 16384 || height > 16384 || width * height > 24000000) throw new Error('Native oracle input exceeds the admitted image bounds');
        if (closed) throw new Error('Native decoder is closed');
        const timer = deadline();
        try {
          const header = Buffer.allocUnsafe(12); header.writeUInt32LE(bytes.length, 0); header.writeUInt32LE(width, 4); header.writeUInt32LE(height, 8);
          child.stdin.write(header); child.stdin.write(bytes);
          const answer = await read(16), status = answer.readUInt32LE(0), w = answer.readUInt32LE(4), h = answer.readUInt32LE(8), length = answer.readUInt32LE(12);
          const expected=width*height*4*sampleBytes;
          if (length > Math.max(expected + (metadata ? 4096 : 0), 4096)) { child.kill('SIGKILL'); throw new Error('Native oracle returned an unbounded reply'); }
          let data = await read(length); decodes++;
          if (status) throw new Error(data.toString() + ': ' + stderr);
          if (metadata) {
            if (data.length < 4) throw new Error('Native oracle omitted metadata');
            const count = data.readUInt32LE(0);
            if (count > 4092 || count + 4 > data.length) throw new Error('Native oracle metadata exceeds its reply');
            lastMetadata = JSON.parse(data.subarray(4, count + 4).toString()); data = data.subarray(count + 4);
          }
          if (w !== width || h !== height || data.length !== expected) throw new Error('Native oracle returned different dimensions');
          if (sampleBytes === 1) return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
          const buffer = data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength);
          return format === 'float32' ? new Float32Array(buffer) : new Uint16Array(buffer);
        } finally { clearTimeout(timer); }
      };
      const result = chain.then(run); chain = result.catch(() => {}); return result;
    },
    close() { return closing ||= chain.then(() => shutdown(false)); },
  };
}
