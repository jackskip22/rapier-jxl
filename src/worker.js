// The rapier-jxl test page and its anonymous results. The page posts one record when a run is complete; GET reads them
// back. Origin check, JSON only, size cap, schema validation, D1, rate limit. No IP address, name or account is stored.
const MAX = 200000, LIMIT = 12;
const headers = {'content-type':'application/json; charset=utf-8','cache-control':'no-store','x-content-type-options':'nosniff',
  'referrer-policy':'no-referrer'};
const answer = (body,status=200) => new Response(JSON.stringify(body),{status,headers});
const short = (value,length) => typeof value === 'string' && value.length > 0 && value.length <= length && !/[\u0000-\u001f]/.test(value) ? value : null;
const statuses = new Set(['pass','fail','unqualified','unavailable','timed-out','canceled']);
// The raw user agent is never kept: browser, OS and device class are the page's own words.
const strip = value => {
  if (Array.isArray(value)) return value.map(strip);
  if (value && typeof value === 'object') {
    const out = {};
    for (const key of Object.keys(value)) if (key !== 'userAgent' && key !== 'userAgentData') out[key] = strip(value[key]);
    return out;
  }
  return value;
};

// The tables are made on first use, so a new deployment needs no migration step.
const SCHEMA = [
  'CREATE TABLE IF NOT EXISTS jxl_results (id TEXT NOT NULL PRIMARY KEY, received_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, build TEXT NOT NULL, version TEXT NOT NULL, status TEXT NOT NULL, browser TEXT NOT NULL, os TEXT NOT NULL, device TEXT NOT NULL, gpu TEXT NOT NULL, body TEXT NOT NULL)',
  'CREATE INDEX IF NOT EXISTS jxl_results_build ON jxl_results(build, received_at)',
  'CREATE TABLE IF NOT EXISTS jxl_results_rate (bucket INTEGER NOT NULL, identity TEXT NOT NULL, count INTEGER NOT NULL CHECK(count >= 1), PRIMARY KEY (bucket, identity))'
];
let ready;
const schema = env => ready ??= env.DB.batch(SCHEMA.map(sql => env.DB.prepare(sql))).catch(error => { ready = undefined; throw error; });

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (url.pathname === '/api/jxl-results') {
      if (!env.DB) return answer({error:'results unavailable'},503);
      try { await schema(env); } catch (_) { return answer({error:'results unavailable'},503); }
      return receiveJxlResults(request, env, ctx);
    }
    return env.ASSETS.fetch(request);
  }
};

async function receiveJxlResults(request,env,ctx) {
  if (request.method === 'GET') return readJxlResults(request,env);
  if (request.method !== 'POST') return answer({error:'method not allowed'},405);
  if (request.headers.get('origin') !== new URL(request.url).origin) return answer({error:'origin denied'},403);
  if (!/^application\/json(?:\s*;|$)/i.test(request.headers.get('content-type') || '')) return answer({error:'expected JSON'},415);
  if (Number(request.headers.get('content-length') || 0) > MAX) return answer({error:'results too large'},413);
  if (!env.DB) return answer({error:'results unavailable'},503);
  let data;
  try {
    const reader = request.body?.getReader();
    if (!reader) throw Error('missing body');
    const chunks = []; let length = 0;
    for (;;) {
      const {value,done} = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > MAX) { await reader.cancel(); return answer({error:'results too large'},413); }
      chunks.push(value);
    }
    const bytes = new Uint8Array(length); let at = 0;
    for (const chunk of chunks) { bytes.set(chunk,at); at += chunk.byteLength; }
    data = JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));
  } catch (_) { return answer({error:'invalid results'},400); }
  if (!data || typeof data !== 'object' || Array.isArray(data)) return answer({error:'invalid results'},400);
  const id = short(data.id,36), version = short(data.version,40), build = short(data.build,40),
    browser = short(data.browser,80), os = short(data.os,80), device = short(data.device,120), gpu = short(data.gpu,160) ?? 'none';
  if (!id || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id)) return answer({error:'invalid results id'},400);
  if (!version || !/^[0-9a-zA-Z.\-]+$/.test(version) || !build || !(build === 'release' || /^[0-9a-f]{7,40}$/.test(build)) ||
      !browser || !os || !device || !statuses.has(data.status) ||
      !data.results || typeof data.results !== 'object' || Array.isArray(data.results) ||
      (data.trace !== undefined && (!data.trace || typeof data.trace !== 'object')))
    return answer({error:'invalid results'},400);
  const body = JSON.stringify(strip({results:data.results,...(data.trace !== undefined && {trace:data.trace})}));
  if (new TextEncoder().encode(body).byteLength > MAX) return answer({error:'results too large'},413);
  const same = row => row?.id === id && row.build === build && row.version === version && row.status === data.status &&
    row.browser === browser && row.os === os && row.device === device && row.gpu === gpu && row.body === body;
  try {
    const lookupSql = 'SELECT id,build,version,status,browser,os,device,gpu,body FROM jxl_results WHERE id = ?';
    const existing = await env.DB.prepare(lookupSql).bind(id).first();
    if (existing) return same(existing) ? answer({received:true,id}) : answer({error:'results id already used'},409);
    const bucket = Math.floor(Date.now() / 600000);
    const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
    const digest = await crypto.subtle.digest('SHA-256',new TextEncoder().encode(bucket+'|'+ip));
    const identity = Array.from(new Uint8Array(digest),v=>v.toString(16).padStart(2,'0')).join('');
    // Admission, storage and over-quota refund are one batch, as in feedback-server.js.
    const [admission, write, refund, lookup] = await env.DB.batch([
      env.DB.prepare(`INSERT INTO jxl_results_rate(bucket,identity,count)
        SELECT ?,?,1 WHERE NOT EXISTS (SELECT 1 FROM jxl_results WHERE id = ?)
        ON CONFLICT(bucket,identity) DO UPDATE SET count=count+1`).bind(bucket,identity,id),
      env.DB.prepare(`INSERT INTO jxl_results(id,build,version,status,browser,os,device,gpu,body)
        SELECT ?,?,?,?,?,?,?,?,? WHERE EXISTS (
          SELECT 1 FROM jxl_results_rate WHERE bucket=? AND identity=? AND count BETWEEN 1 AND ${LIMIT})
        AND NOT EXISTS (SELECT 1 FROM jxl_results WHERE id=?)
        ON CONFLICT(id) DO NOTHING`).bind(id,build,version,data.status,browser,os,device,gpu,body,bucket,identity,id),
      env.DB.prepare(`UPDATE jxl_results_rate SET count=count-1 WHERE bucket=? AND identity=? AND count>${LIMIT}
        AND NOT EXISTS (SELECT 1 FROM jxl_results WHERE id=?)`).bind(bucket,identity,id),
      env.DB.prepare(lookupSql).bind(id)
    ]);
    if (!admission?.success || !write?.success || !refund?.success || !lookup?.success) throw Error('batch not confirmed');
    const stored = lookup.results?.[0];
    if (!stored) return answer({error:'rate limited'},429);
    if (!same(stored)) return answer({error:'results id already used'},409);
    try {
      ctx?.waitUntil?.(Promise.resolve()
        .then(() => env.DB.prepare('DELETE FROM jxl_results_rate WHERE bucket < ?').bind(bucket - 6).run())
        .catch(() => {}));
    } catch (_) { /* pruning never decides a receipt */ }
    return answer({received:true,id});
  } catch (_) { return answer({error:'results unavailable'},503); }
}

// GET /api/jxl-results[?build=<commit|release>][&limit=<1-200>] lists the newest records; ?id=<uuid> returns one in full.
async function readJxlResults(request,env) {
  if (!env.DB) return answer({error:'results unavailable'},503);
  const url = new URL(request.url), id = url.searchParams.get('id'), build = url.searchParams.get('build');
  const limit = Math.min(200,Math.max(1,Number(url.searchParams.get('limit')) || 50));
  if (build !== null && !(build === 'release' || /^[0-9a-f]{7,40}$/.test(build))) return answer({error:'invalid build'},400);
  try {
    if (id !== null) {
      const row = await env.DB.prepare('SELECT * FROM jxl_results WHERE id = ?').bind(id).first();
      return row ? answer({...row,body:JSON.parse(row.body)}) : answer({error:'not found'},404);
    }
    const sql = 'SELECT id,received_at,build,version,status,browser,os,device,gpu FROM jxl_results' +
      (build !== null ? ' WHERE build = ?' : '') + ' ORDER BY received_at DESC, id LIMIT ?';
    const statement = env.DB.prepare(sql);
    const out = await (build !== null ? statement.bind(build,limit) : statement.bind(limit)).all();
    return answer({results:out.results ?? []});
  } catch (_) { return answer({error:'results unavailable'},503); }
}
