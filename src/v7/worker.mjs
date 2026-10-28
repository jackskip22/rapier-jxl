import {install} from './worker-runtime.mjs';
install(typeof globalThis.addEventListener === 'function' ? globalThis : globalThis.process?.getBuiltinModule?.('node:worker_threads')?.parentPort ?? globalThis);
