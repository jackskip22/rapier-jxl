import {BUILD_VERSION} from './build-version.mjs';
import {INTERFACES} from './wasm-interfaces.mjs';
import {interfaceOf} from './wasm-text.mjs';
const supplied = new Map(), used = new Map();
let configured = false;
const error = message => Object.assign(new Error(message), {code: 'JXL_WASM'});

const MODULES = Symbol.for('rapier-jxl/' + BUILD_VERSION + ' wasm ' + Object.entries(INTERFACES).map(([name, word]) => name + ':' + word).join(';'));

export function provideWasm(modules) { globalThis[MODULES] = Object.freeze({...modules, ...globalThis[MODULES]}); }
let taken = null;
const take = () => {
  const given = globalThis[MODULES];
  if (!given || given === taken) return;
  taken = given;
  const fresh = Object.entries(given).filter(([name]) => !supplied.has(name));
  if (fresh.length) configureModules(Object.fromEntries(fresh));
};

export function configureModules(modules) {
  if (!modules || typeof modules !== 'object' || Array.isArray(modules) || !Object.keys(modules).length)
    throw error('modules: {name: WebAssembly.Module}');
  const entries = Object.entries(modules);
  for (const [name, module] of entries) {
    if (!Object.hasOwn(INTERFACES, name)) throw error(`unknown module: ${name}`);
    let imports, exports;
    try { imports = WebAssembly.Module.imports(module); exports = WebAssembly.Module.exports(module); }
    catch { throw error(`${name}: WebAssembly.Module`); }
    const importedMemory = name === 'kernels' || name === 'general';
    if (interfaceOf(exports) !== INTERFACES[name] ||
        (importedMemory ? imports.length !== 1 || imports[0].module !== 'env' || imports[0].name !== 'memory' || imports[0].kind !== 'memory' : imports.length !== 0))
      throw error(`${name}: interface mismatch`);
    if (supplied.has(name) && supplied.get(name) !== module || used.has(name) && used.get(name) !== module)
      throw error(`${name}: already configured`);
  }
  for (const [name, module] of entries) supplied.set(name, module);
  configured = true;
}

export function suppliedWasm() {
  take();
  return configured ? Object.freeze(Object.fromEntries(supplied)) : undefined;
}
export const hasWasmModule = name => (take(), supplied.has(name));
const compiling = new Map(), failures = new Map();
export const wasmFailure = name => name === undefined ? failures.values().next().value : failures.get(name);
export async function compileWasm(name, bytes) {
  take();
  if (used.get(name) || supplied.has(name)) return true;
  if (!compiling.has(name)) {
    if (!used.has(name)) used.set(name, null);
    compiling.set(name, (async () => {
      const module = await WebAssembly.compile(bytes());
      await WebAssembly.instantiate(Uint8Array.of(0, 97, 115, 109, 1, 0, 0, 0));
      if (!used.get(name)) used.set(name, module);
      failures.delete(name);
      return true;
    })().catch(cause => { compiling.delete(name); failures.set(name, cause); return false; }));
  }
  return compiling.get(name);
}
export function wasmModule(name, bytes) {
  take();
  if (used.get(name)) return used.get(name);
  used.set(name, null);
  const module = supplied.get(name);
  if (module) { used.set(name, module); return module; }
  let compiled;
  try { compiled = new WebAssembly.Module(bytes()); } catch (cause) { if (configured) throw error(`${name}: missing`); throw cause; }
  used.set(name, compiled);
  return compiled;
}
