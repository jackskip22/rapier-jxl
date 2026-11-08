// SPDX-License-Identifier: MIT
export function gpuQueue(run) {
  let queue = Promise.resolve(), refused = false;
  return request => {
    if (request?.kind === 'refuse') refused = true;
    if (refused) return Promise.resolve(null);
    const answer = queue.then(() => run(request));
    queue = answer.then(() => {}, () => {});
    return answer;
  };
}
