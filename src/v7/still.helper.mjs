import {requireWebGPU} from './webgpu.mjs';
import * as module from './index.mjs';
import {moduleRuntime} from './module-runtime.mjs';
import {serveHelper} from '../helper-runtime.mjs';
import {WORKER_PROTOCOL} from './protocol.mjs';
import {serveBlockSplit} from '../block-split.mjs';
import {serveParallel} from '../parallel-serve.mjs';
const runtime = moduleRuntime(module, {name: 'rapier-jxl', gpu: requireWebGPU});
serveHelper(() => ({name: 'rapier-jxl', protocol: WORKER_PROTOCOL, run: (...call) => runtime.run(...call), serveSplit: serveBlockSplit, serveParallel}));
