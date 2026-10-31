import * as module from './format.mjs';
import {moduleRuntime} from './module-runtime.mjs';
import {serveHelper} from '../helper-runtime.mjs';
import {WORKER_PROTOCOL} from './protocol.mjs';
import {serveSplit} from '../photo-split.mjs';
import {serveParallel} from '../parallel-serve.mjs';
const runtime = moduleRuntime(module, {name: 'rapier-jxl/format', gpu: true});
serveHelper(() => ({name: 'rapier-jxl/format', protocol: WORKER_PROTOCOL, run: (...call) => runtime.run(...call), serveSplit, serveParallel}));
