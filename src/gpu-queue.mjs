// SPDX-License-Identifier: MIT
export function gpuQueue(run) {
  let queue = Promise.resolve();
  return request => {
    const answer = queue.then(() => run(request));
    queue = answer.then(() => {}, () => {});
    return answer;
  };
}
