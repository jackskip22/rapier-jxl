// SPDX-License-Identifier: MIT
let held = false;
export const deviceHeld = () => held;
export const holdDevice = on => { held = on; };
