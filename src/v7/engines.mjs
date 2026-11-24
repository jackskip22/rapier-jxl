// SPDX-License-Identifier: MIT
import {belowFloor, FLOOR} from './node-floor.mjs';

const host = globalThis.process, versions = host?.versions;
if (versions?.node && !globalThis.Deno && !versions.bun && (typeof host.getBuiltinModule !== 'function' ||
    belowFloor(String(versions.node))))
  throw Object.assign(new Error(`Node ${versions.node} is too old. ${FLOOR}`), {code: 'JXL_PLATFORM'});
