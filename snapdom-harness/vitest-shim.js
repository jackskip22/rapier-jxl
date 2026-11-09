// The part of vitest's API the jxl plugin tests use, run in a plain page.
const root = { name: '', tests: [], suites: [], before: [], after: [] }
let current = root
export function describe(name, fn) {
  const s = { name, tests: [], suites: [], before: [], after: [], parent: current }
  current.suites.push(s)
  const prev = current; current = s
  try { fn() } finally { current = prev }
}
export function it(name, fn) { current.tests.push({ name, fn }) }
it.skip = () => {}
it.skipIf = (cond) => (cond ? ((name, fn) => {}) : it)
// vitest: it.skipIf(cond)(name, fn)
it.skipIf = (cond) => (cond ? ((name, fn) => {}) : it)
export const test = it
export function beforeEach(fn) { current.before.push(fn) }
export function afterEach(fn) { current.after.push(fn) }
const spies = []
const mockFn = (impl = () => {}, restore = () => {}) => {
  let cur = impl
  const f = function (...a) { f.mock.calls.push(a); return cur.apply(this, a) }
  f.mock = { calls: [] }
  f.mockImplementation = (i) => { cur = i; return f }
  f.mockReturnValue = (v) => { cur = () => v; return f }
  f.mockResolvedValue = (v) => { cur = () => Promise.resolve(v); return f }
  f.mockRestore = restore
  return f
}
export const vi = {
  // vitest hoists this call; in our page runner it just runs immediately.
  hoisted: (fn) => fn(),
  fn: (impl) => mockFn(impl),
  spyOn(obj, key) {
    const orig = obj[key], own = Object.getOwnPropertyDescriptor(obj, key)
    const f = mockFn(function (...a) { return orig.apply(this, a) }, () => { if (own) Object.defineProperty(obj, key, own); else delete obj[key] })
    Object.defineProperty(obj, key, { value: f, configurable: true, writable: true })
    spies.push(f); return f
  },
  restoreAllMocks() { while (spies.length) spies.pop().mockRestore() },
  mocked: (f) => f,
}

const fmt = (v) => { try { return typeof v === 'string' ? JSON.stringify(v) : v instanceof Error ? `Error(${v.message})` : JSON.stringify(v)?.slice(0, 300) ?? String(v) } catch { return String(v) } }
const eq = (a, b) => {
  if (Object.is(a, b)) return true
  if (typeof a !== 'object' || typeof b !== 'object' || !a || !b) return false
  if (Array.isArray(a) !== Array.isArray(b)) return false
  const ka = Object.keys(a), kb = Object.keys(b)
  return ka.length === kb.length && ka.every((k) => eq(a[k], b[k]))
}
function matchers(actual, msg, negate) {
  const ok = (pass, what) => { if (pass === negate) throw new Error(`${msg ? msg + ': ' : ''}expected ${fmt(actual)} ${negate ? 'not ' : ''}${what}`) }
  return {
    toBe: (e) => ok(Object.is(actual, e), `to be ${fmt(e)}`),
    toEqual: (e) => ok(eq(actual, e), `to equal ${fmt(e)}`),
    toStrictEqual: (e) => ok(eq(actual, e), `to equal ${fmt(e)}`),
    toBeGreaterThan: (e) => ok(actual > e, `> ${e}`),
    toBeGreaterThanOrEqual: (e) => ok(actual >= e, `>= ${e}`),
    toBeLessThan: (e) => ok(actual < e, `< ${e}`),
    toBeLessThanOrEqual: (e) => ok(actual <= e, `<= ${e}`),
    toBeCloseTo: (e, d = 2) => ok(Math.abs(actual - e) < 10 ** -d / 2, `close to ${e}`),
    toBeInstanceOf: (c) => ok(actual instanceof c, `instance of ${c.name}`),
    toHaveLength: (n) => ok(actual?.length === n, `to have length ${n}`),
    toBeUndefined: () => ok(actual === undefined, 'undefined'),
    toBeDefined: () => ok(actual !== undefined, 'defined'),
    toBeNull: () => ok(actual === null, 'null'),
    toBeTruthy: () => ok(!!actual, 'truthy'),
    toBeFalsy: () => ok(!actual, 'falsy'),
    toContain: (e) => ok(actual?.includes?.(e), `to contain ${fmt(e)}`),
    toMatch: (r) => ok(typeof r === 'string' ? String(actual).includes(r) : r.test(String(actual)), `to match ${r}`),
    toHaveBeenCalledTimes: (n) => ok(actual.mock.calls.length === n, `called ${n} times`),
    toHaveBeenCalled: () => ok(actual.mock.calls.length > 0, 'called'),
    toHaveBeenCalledWith: (...e) => ok(actual.mock.calls.some((c) => eq(c, e)), `called with ${fmt(e)}`),
    toMatchObject: (e) => { const pass = e && typeof e === "object" && Object.keys(e).every((k) => eq(actual?.[k], e[k])); ok(!!pass, `to match object ${fmt(e)}`) },
    toThrow: (r) => { let t = null; try { actual() } catch (e) { t = e } ok(!!t && (!r || (typeof r === 'string' ? t.message.includes(r) : r.test(t.message))), `to throw ${r ?? ''}`) },
  }
}
export function expect(actual, msg) {
  const m = matchers(actual, msg, false)
  m.not = matchers(actual, msg, true)
  const settle = (rejects) => new Proxy({}, {
    get: (_, k) => async (...a) => {
      let v, threw = false
      try { v = await actual } catch (e) { v = e; threw = true }
      if (threw !== rejects) throw new Error(`${msg ? msg + ': ' : ''}expected the promise to ${rejects ? 'reject' : 'resolve'}, it ${threw ? 'rejected with ' + fmt(v) : 'resolved ' + fmt(v)}`)
      if (k === 'toThrow') return matchers(() => { throw v }, msg, false).toThrow(...a)
      return matchers(v, msg, false)[k](...a)
    },
  })
  m.rejects = settle(true)
  m.resolves = settle(false)
  return m
}

export async function run(filter) {
  const results = []
  const walk = async (s, path, befores, afters) => {
    const b = [...befores, ...s.before], a = [...s.after, ...afters]
    for (const t of s.tests) {
      const name = [...path, t.name].filter(Boolean).join(' > ')
      if (filter && !name.includes(filter)) continue
      const start = performance.now()
      let error = null
      try { for (const f of b) await f(); await t.fn() } catch (e) { error = e }
      try { for (const f of a) await f() } catch (e) { error ??= e }
      results.push({ name, ms: Math.round(performance.now() - start), error: error && (String(error?.message ?? error) + (error?.code ? ` [${error.code}]` : '')) })
    }
    for (const c of s.suites) await walk(c, [...path, c.name], b, a)
  }
  await walk(root, [], [], [])
  return results
}
