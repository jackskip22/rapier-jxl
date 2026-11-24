// The calls and their bridge, with no React and no WebView in them: `createCodec` takes a `send` that delivers one message
// to the hidden page and a `loadModule` that returns a module's source, and returns the calls and the page's receiver.
import {decodeBase64, encodeBase64} from './base64.ts';

export type Bytes = Uint8Array | ArrayBuffer;
export interface CallOptions {
  /** Aborting rejects the call with `JXL_CANCELED`; the next call runs normally. */
  signal?: AbortSignal;
}
type Effort = 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9;
export interface StillOptions extends CallOptions {
  /** 1 to 100. Default 80. */
  quality?: number;
  /** 1 to 3. Default 3. */
  effort?: 1 | 2 | 3;
  /** The input's type. Default: read from its first bytes. */
  mime?: string;
}
export interface AnimationOptions extends Omit<StillOptions, 'effort'> {
  /** 1 to 9. Default 3. */
  effort?: Effort;
  /** 0 to 1, as frames are read and encoded. */
  onProgress?: (fraction: number) => void;
}
export interface JXLCodec {
  /** A photo (JPEG, PNG, WebP, ...) in, JPEG XL out. */
  encode(photo: Bytes, options?: StillOptions): Promise<Uint8Array>;
  /** The same, keeping every pixel. */
  encodeExact(photo: Bytes, options?: StillOptions): Promise<Uint8Array>;
  /** A JPEG's own bytes, smaller. `restore` gives the same JPEG back. */
  recompress(jpeg: Bytes, options?: CallOptions & {effort?: Effort}): Promise<Uint8Array>;
  /** The JPEG a `recompress` call made, exactly. */
  restore(jxl: Bytes, options?: CallOptions): Promise<Uint8Array>;
  /** A video (every frame, each with its time) or a GIF in, an animated JPEG XL out. */
  animate(video: Bytes, options?: AnimationOptions): Promise<Uint8Array>;
}

/** A refusal or a stop, with the package's `JXL_` code. */
export class JXLError extends Error {
  code: string;
  constructor(code: string, message: string) { super(message); this.name = 'JXLError'; this.code = code; }
}

export const CHUNK = 196608;          // bytes per message: a multiple of 3, so each base64 chunk stands alone
const TEXT_CHUNK = 262144;            // characters per module message

type Op = 'encode' | 'encodeExact' | 'recompress' | 'restore' | 'animate';
interface Job {
  id: string; op: Op; bytes: Uint8Array; mime: string; quality: number; effort: number;
  onProgress?: (fraction: number) => void;
  out?: Uint8Array; got: number; settled: boolean; done: Promise<void>; release(): void;
  resolve(bytes: Uint8Array): void; reject(error: JXLError): void;
}

export function sniffMime(bytes: Uint8Array): string {
  const at = (i: number, text: string) => [...text].every((c, k) => bytes[i + k] === c.charCodeAt(0));
  if (bytes[0] === 0xff && bytes[1] === 0xd8) return 'image/jpeg';
  if (bytes[0] === 0x89 && at(1, 'PNG')) return 'image/png';
  if (at(0, 'GIF8')) return 'image/gif';
  if (at(0, 'RIFF') && at(8, 'WEBP')) return 'image/webp';
  if (at(4, 'ftyp')) return at(8, 'qt') ? 'video/quicktime' : 'video/mp4';
  if (bytes[0] === 0x1a && bytes[1] === 0x45 && bytes[2] === 0xdf && bytes[3] === 0xa3) return 'video/webm';
  return 'application/octet-stream';
}

export function createCodec(send: (message: object) => void, loadModule: (name: string) => Promise<string>) {
  let counter = 0, tail: Promise<unknown> = Promise.resolve();
  let ready!: () => void, dropPage!: () => void;
  const freshPage = () => new Promise<void>((resolve, reject) => { ready = resolve; dropPage = () => reject(new Error('reset')); });
  let page = freshPage();
  const waiting = new Set<Job>(), jobs = new Map<string, Job>();
  const pause = () => new Promise<void>(resolve => setTimeout(resolve, 0));   // lets touches and frames through between chunks

  const settle = (job: Job, error?: JXLError, bytes?: Uint8Array) => {
    if (job.settled) return;
    job.settled = true; waiting.delete(job); jobs.delete(job.id); job.release();
    if (error) job.reject(error); else job.resolve(bytes!);
  };

  async function run(job: Job) {
    if (job.settled) return;
    waiting.add(job);
    try { await page; } catch { return; }
    waiting.delete(job);
    if (job.settled) return;
    jobs.set(job.id, job);
    send({type: 'run', id: job.id, op: job.op, mime: job.mime, quality: job.quality, effort: job.effort, size: job.bytes.length});
    for (let at = 0, i = 0; at < job.bytes.length && !job.settled; at += CHUNK, i++) {
      send({type: 'in', id: job.id, i, d: encodeBase64(job.bytes, at, Math.min(at + CHUNK, job.bytes.length))});
      await pause();
    }
    if (job.bytes.length === 0) send({type: 'in', id: job.id, i: 0, d: ''});
    await job.done;
  }

  function call(op: Op, input: Bytes, options: AnimationOptions = {}): Promise<Uint8Array> {
    const {signal} = options;
    const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
    return new Promise<Uint8Array>((resolve, reject) => {
      if (signal?.aborted) return reject(new JXLError('JXL_CANCELED', 'The call was canceled.'));
      let release!: () => void;
      const done = new Promise<void>(yes => { release = yes; });
      const job: Job = {
        id: `job${++counter}`, op, bytes, mime: options.mime ?? sniffMime(bytes),
        quality: options.quality ?? 80, effort: options.effort ?? 3, onProgress: options.onProgress,
        got: 0, settled: false, done, release, resolve, reject
      };
      signal?.addEventListener('abort', () => {
        if (job.settled) return;
        if (jobs.has(job.id)) send({type: 'cancel', id: job.id});
        settle(job, new JXLError('JXL_CANCELED', 'The call was canceled.'));
      }, {once: true});
      tail = tail.then(() => run(job)).catch(() => undefined);   // one call at a time
    });
  }

  async function sendModule(name: string) {
    try {
      const text = await loadModule(name), n = Math.ceil(text.length / TEXT_CHUNK);
      for (let i = 0; i < n; i++) { send({type: 'module', name, i, n, d: text.slice(i * TEXT_CHUNK, (i + 1) * TEXT_CHUNK)}); await pause(); }
    } catch (error) { fail('JXL_PACKAGE', `The ${name} module could not be read: ${(error as Error)?.message ?? error}`); }
  }

  /** Every call waiting or running fails, and the next call waits for a new page's `ready`. */
  function fail(code: string, message: string) {
    for (const job of [...waiting, ...jobs.values()]) settle(job, new JXLError(code, message));
  }

  function receive(message: {type: string; id?: string | null; [key: string]: any}) {
    const job = message.id ? jobs.get(message.id) : undefined;
    switch (message.type) {
      case 'ready': ready(); break;
      case 'need': void sendModule(message.name); break;
      case 'progress': job?.onProgress?.(message.fraction); break;
      case 'out':
        if (!job) break;
        job.out ??= new Uint8Array(message.size);
        job.got += decodeBase64(message.d, job.out, message.i * CHUNK);
        break;
      case 'done':
        if (job) {
          if (job.out && job.got === job.out.length) settle(job, undefined, job.out);
          else settle(job, new JXLError('JXL_BRIDGE', 'The result did not arrive whole.'));
        }
        break;
      case 'error':
        if (job) settle(job, new JXLError(message.code, message.message));
        else if (!message.id) fail(message.code, message.message);
        break;
    }
  }

  /** The page was lost (the OS ended its process): every call fails with `code`, and a new page is awaited. */
  function reset(code: string, message: string) {
    const prevDrop = dropPage;
    page = freshPage();
    fail(code, message);
    prevDrop();
  }

  const codec: JXLCodec = {
    encode: (input, options) => call('encode', input, options),
    encodeExact: (input, options) => call('encodeExact', input, options),
    recompress: (input, options) => call('recompress', input, options),
    restore: (input, options) => call('restore', input, options),
    animate: (input, options) => call('animate', input, options)
  };
  return {codec, receive, reset};
}
