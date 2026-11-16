// SPDX-License-Identifier: MIT
let calls = 0, pictures = 0;
const rewinds = new Set(), ends = new Set();
export async function withinCall(run) {
  calls++;
  try { return await run(); }
  finally { if (--calls === 0) for (const end of ends) end(); }
}
export async function withinPicture(run) {
  pictures++;
  try { return await run(); }
  finally { if (--pictures === 0) for (const rewind of rewinds) rewind(); }
}
export const inCall = () => calls > 0;
export const onCallEnd = (rewind, end) => { rewinds.add(rewind); ends.add(end); };
