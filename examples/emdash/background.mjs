// SPDX-License-Identifier: MIT
const fail = (code, message) => Object.assign(new Error(message), {code});
const terminal = value => value?.done || value?.canceled;
const finishedRun = value => !value || ['done', 'canceled'].includes(value.state);

// One durable jxl-work task owns the whole scheduled wake. The host may invoke ten task rows in one wake;
// per-image timers would multiply the Worker's allowance. Every advance still publishes its own checkpoint.
export async function runBackground({event, platform, scope, work, runner, library, originals, signal,
  now = () => performance.now(), wakeMs = 25000, stepMs = 5000, cpuLimitMs = null}) {
  if (event?.name !== 'jxl-work' || event?.data?.kind !== 'images' || !['node', 'cloudflare'].includes(platform) ||
      !Number.isFinite(wakeMs) || wakeMs <= 0 || !Number.isFinite(stepMs) || stepMs <= 0 || stepMs > 60000 ||
      cpuLimitMs !== null && (!Number.isFinite(cpuLimitMs) || cpuLimitMs <= 0))
    throw fail('JXL_OPTIONS', 'Expected this site’s scheduled work and its native host allowance.');
  const started = now(), allowance = cpuLimitMs === null ? wakeMs : Math.min(wakeMs, cpuLimitMs * 0.8);
  const deadline = platform === 'cloudflare' || cpuLimitMs !== null ? started + allowance : Infinity;
  const result = {advances: 0, completed: 0, stopped: 'idle'};
  const remaining = () => Math.min(stepMs, deadline - now());
  const exhausted = () => {
    signal?.throwIfAborted();
    if (remaining() > 0) return false;
    result.stopped = 'budget'; return true;
  };
  const seen = new Set();
  for (let cursor; ;) {
    if (exhausted()) return result;
    const page = await work.list(cursor);
    for (const {data} of page.items) {
      if (data.scope !== scope || !['image', 'library', 'originals'].includes(data.kind))
        throw fail('JXL_INPUT', 'Queued image work belongs to another site.');
      let previous;
      for (;;) {
        if (exhausted()) return result;
        let revision;
        if (data.kind === 'image') {
          const service = await runner({ms: remaining()});
          const job = await service.resume(data.command, {signal});
          result.advances++;
          if (terminal(job) && !job.publication?.collect && !job.cleanupPending) {
            await work.remove('image', data.id); result.completed++; break;
          }
          if (job.phase === 'blocked') break;
          revision = job.revision;
        } else if (data.kind === 'originals') {
          if (typeof originals !== 'function') throw fail('JXL_OPTIONS', 'Originals work requires its durable policy runner.');
          const policy = await (await originals({ms: remaining()})).resume(data.id, {signal});
          result.advances++;
          if (policy?.blocked) break;
          if (!policy || policy.phase === 'idle') {
            await work.remove('originals', data.id); result.completed++; break;
          }
          if (!['archiving', 'restoring'].includes(policy.phase))
            throw fail('JXL_INPUT', 'The originals policy returned an invalid active phase.');
          revision = policy.revision;
        } else {
          const run = await (await library({ms: remaining()})).resume(data.id);
          result.advances++;
          if (finishedRun(run) && !run?.cleanupPending) {
            await work.remove('library', data.id); result.completed++; break;
          }
          if (run.state === 'preparing' || run.state === 'paused' && !run.current) break;
          let job;
          if (run.current?.stage === 'waiting') {
            if (exhausted()) return result;
            const service = await runner({ms: remaining()});
            job = await service.advance(run.current.jobId, {signal});
            result.advances++;
            if (job.phase === 'blocked') break;
          }
          revision = JSON.stringify([run.revision, job?.revision]);
        }
        // A paused run, a concurrent winner or an unacknowledged archive must not create a busy loop.
        if (revision === previous) break;
        previous = revision;
      }
    }
    if (!page.hasMore) return result;
    if (!page.cursor || seen.has(page.cursor)) throw fail('JXL_IO', 'The work queue repeated a page.');
    seen.add(page.cursor); cursor = page.cursor;
  }
}
