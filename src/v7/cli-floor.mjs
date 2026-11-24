// SPDX-License-Identifier: MIT
import {oldNode, FLOOR} from './node-floor.mjs';
import {COMMAND} from './package-name.mjs';

const old = oldNode();
if (old && /(^|[\\/])(cli\.mjs|jpegxl|rapier-jxl)$/.test(globalThis.process.argv[1] ?? '')) {
  process.stderr.write(`${COMMAND}: JXL_PLATFORM: Node ${old} is too old. ${FLOOR}\n`);
  process.exit(1);
}
