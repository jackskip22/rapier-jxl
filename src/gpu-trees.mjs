// SPDX-License-Identifier: MIT
import {createMAHistogramBatch} from './gpu-ma-counts.mjs';
import {createMAPricer} from './gpu-ma-price.mjs';
import {createMASparseProposalBatch} from './gpu-ma-sparse.mjs';

let DENSE_FROM = 8192;
export const denseFrom = members => { DENSE_FROM = members; };
const SESSIONS = 6;
const open = new WeakMap(), refused = new WeakSet(), flights = new WeakMap();
const sessionsOf = device => { let s = open.get(device); if (!s) open.set(device, s = new Map()); return s; };
const close = (sessions, samples) => {
  const session = sessions.get(samples);
  sessions.delete(samples);
  if (session) for (const engine of [session.dense, session.sparse]) engine?.then(e => e?.destroy(), () => {});
};
const engine = (sessions, samples, session, kind, make) => {
  const made = session[kind] ??= make();
  made.catch(() => { if (sessions.get(samples) === session) close(sessions, samples); });
  return made;
};
const dense = (device, samples, signal) => (async () => {
  const counts = await createMAHistogramBatch(device, samples, {signal});
  try {
    const pricer = await createMAPricer(device, counts.layout, {table: samples.table, rawPrice: samples.rawPrice}, {signal});
    return {proposals: (nodes, run) => counts.proposals(nodes, pricer, run), destroy() { counts.destroy(); pricer.destroy(); }};
  } catch (error) { counts.destroy(); throw error; }
})();
function sessionFor(device, samples) {
  const sessions = sessionsOf(device);
  let session = sessions.get(samples);
  if (session) { sessions.delete(samples); sessions.set(samples, session); return session; }
  for (const [held, open] of sessions) { if (sessions.size < SESSIONS) break; if (!open.running) close(sessions, held); }
  sessions.set(samples, session = {});
  return session;
}
export async function gpuTrees(device, request) {
  const {samples, nodes} = request;
  if (request.failed) { refuse(device); return {heard: true, refused: true}; }
  if (request.end) { await Promise.allSettled(flights.get(device) ?? []); close(sessionsOf(device), samples); return {heard: true, refused: refused.has(device)}; }
  const {signal} = request;
  if (signal?.aborted || refused.has(device) || !samples || !Array.isArray(nodes) || !nodes.length) return null;
  const sessions = sessionsOf(device), session = sessionFor(device, samples), records = new Array(nodes.length);
  session.running = (session.running ?? 0) + 1;
  const many = [], few = [];
  nodes.forEach((members, i) => (members.length >= DENSE_FROM ? many : few).push({id: String(i), members}));
  const flight = Promise.allSettled([[many, 'dense', () => dense(device, samples, signal)],
    [few, 'sparse', () => createMASparseProposalBatch(device, samples, {table: samples.table, rawPrice: samples.rawPrice}, {signal})]]
    .map(async ([asked, kind, make]) => {
      if (!asked.length || signal?.aborted) return;
      const made = await engine(sessions, samples, session, kind, make);
      if (signal?.aborted) return;
      const {results} = await made.proposals(asked, {signal});
      for (const result of results) records[+result.id] = result.record;
    }));
  const flying = flights.get(device) ?? new Set();
  flights.set(device, flying.add(flight));
  const failure = (await flight).find(part => part.status === 'rejected');
  flying.delete(flight);
  if (signal?.aborted) { if (!--session.running && refused.has(device)) close(sessions, samples); return null; }
  if (failure && !/^MA_/.test(failure.reason?.code ?? '')) refuse(device);
  if (!--session.running && refused.has(device)) close(sessions, samples);
  if (failure) throw failure.reason;
  return records;
}
function refuse(device) {
  refused.add(device);
  for (const [s, open] of [...sessionsOf(device)]) if (!open.running) close(sessionsOf(device), s);
}
