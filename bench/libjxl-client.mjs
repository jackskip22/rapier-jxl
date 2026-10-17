// SPDX-License-Identifier: MIT
// Client for the persistent libjxl helper built from libjxl.cc. One request encodes one image at one effort and
// distance (0 is lossless); the helper decodes every output it times and reports the median encode time.
import {spawn} from 'node:child_process';

export class LibjxlHelper {
  constructor(binary, {env = process.env} = {}) {
    this.binary = binary; this.env = env; this.buffer = Buffer.alloc(0); this.ended = false; this.failure = null; this.notify = null; this.stderr = '';
  }
  wake() { const callback = this.notify; this.notify = null; callback?.(); }
  async start() {
    const child = this.child = spawn(this.binary, [], {stdio: ['pipe', 'pipe', 'pipe'], env: this.env});
    child.stdout.on('data', chunk => { this.buffer = Buffer.concat([this.buffer, chunk]); this.wake(); });
    child.stderr.on('data', chunk => { this.stderr += chunk; });
    child.once('error', error => { this.failure = error; this.wake(); });
    child.stdin.on('error', error => { this.failure = error; this.wake(); });
    this.exited = new Promise(done => child.once('exit', (code, signal) => {
      this.ended = true;
      if (code !== 0) this.failure = new Error('libjxl helper exited ' + code + ' ' + signal + ' ' + this.stderr);
      this.wake(); done({code, signal});
    }));
    this.version = await this.line();
    return this.version;
  }
  async wait() {
    if (this.failure) throw this.failure;
    if (this.ended) throw new Error('libjxl helper closed its output');
    await new Promise(done => { this.notify = done; });
  }
  async line() {
    let at;
    while ((at = this.buffer.indexOf(10)) < 0) await this.wait();
    const text = this.buffer.subarray(0, at).toString('utf8'); this.buffer = this.buffer.subarray(at + 1);
    return JSON.parse(text);
  }
  async take(count) {
    while (this.buffer.length < count) await this.wait();
    const value = Buffer.from(this.buffer.subarray(0, count)); this.buffer = this.buffer.subarray(count);
    return value;
  }
  send(value) { return new Promise((done, fail) => this.child.stdin.write(value, error => error ? fail(error) : done())); }
  // rgba: Uint8Array of width * height * 4. Returns {meta, bytes}.
  async encode({width, height, rgba, effort, distance = 0, warmups = 1, repeats = 3}) {
    await this.send(Buffer.from([width, height, effort, warmups, repeats, rgba.byteLength, distance].join(' ') + '\n'));
    await this.send(rgba);
    const meta = await this.line();
    if (!meta.ok) throw new Error('libjxl helper refused the request');
    return {meta, bytes: await this.take(meta.bytes)};
  }
  async close() {
    if (this.ended) return;
    this.child.stdin.end();
    const exit = await this.exited;
    if (exit.code !== 0) throw new Error('libjxl helper exited ' + exit.code);
  }
}
