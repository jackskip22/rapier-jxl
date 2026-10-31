import * as module from './upload.mjs';
import {moduleRuntime} from './module-runtime.mjs';
import {serveHelper} from '../helper-runtime.mjs';
import {WORKER_PROTOCOL} from './protocol.mjs';
import {serveSplit} from '../photo-split.mjs';
const runtime = moduleRuntime(module, {name: 'rapier-jxl/upload'});
serveHelper(() => ({name: 'rapier-jxl/upload', protocol: WORKER_PROTOCOL, run: (...call) => runtime.run(...call), serveSplit}));
