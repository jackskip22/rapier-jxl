import {BUILD_VERSION} from './build-version.mjs';
import {INTERFACES} from './wasm-interfaces.mjs';
import {interfaceOf} from './wasm-text.mjs';
const supplied = new Map(), used = new Map(), BUNDLE = Symbol.for('rapier-jxl.wasm');
let configured = false, sealed = false;
const error = message => Object.assign(new Error(message), {code: 'JXL_WASM'});

const MODULES = Symbol.for('rapier-jxl/' + BUILD_VERSION + ' wasm ' + Object.entries(INTERFACES).map(([name, word]) => name + ':' + word).join(';'));

export function wasmBundle(modules) {
  return Object.freeze(Object.defineProperty({[BUNDLE]: true}, MODULES, {value: modules ? Object.freeze({...modules}) : null}));
}

export const configureWasm = /* @__PURE__ */ Object.assign(function configureWasm(bundle) {
  const object = bundle !== null && typeof bundle === 'object', field = object ? Object.getOwnPropertyDescriptor(bundle, MODULES) : undefined;
  const modules = field && 'value' in field ? field.value : undefined;
  if (modules !== null && (modules === undefined || typeof modules !== 'object')) throw error(object && Object.hasOwn(bundle, BUNDLE)
    ? 'This WebAssembly is from another rapier-jxl version; import rapier-jxl/wasm from this package.'
    : 'configureWasm takes the bundle exported by rapier-jxl/wasm.');
  if (modules) configureModules(modules);
}, {[Symbol.for('rapier-jxl.wasm-supplied')]: seal => suppliedWasm(seal)});

export function configureModules(modules) {
  if (!modules || typeof modules !== 'object' || Array.isArray(modules) || !Object.keys(modules).length)
    throw error('Supply named precompiled WebAssembly.Module objects.');
  const entries = Object.entries(modules);
  for (const [name, module] of entries) {
    if (!Object.hasOwn(INTERFACES, name)) throw error(`Unknown WebAssembly module: ${name}.`);
    let imports, exports;
    try { imports = WebAssembly.Module.imports(module); exports = WebAssembly.Module.exports(module); }
    catch { throw error(`${name} must be a compiled WebAssembly.Module.`); }
    const importedMemory = name === 'kernels';
    if (interfaceOf(exports) !== INTERFACES[name] ||
        (importedMemory ? imports.length !== 1 || imports[0].module !== 'env' || imports[0].name !== 'memory' || imports[0].kind !== 'memory' : imports.length !== 0))
      throw error(`The ${name} module does not match; use this package's.`);
    if (sealed && supplied.get(name) !== module || supplied.has(name) && supplied.get(name) !== module || used.has(name) && used.get(name) !== module)
      throw error(`The ${name} module is already set; configure modules before any work.`);
  }
  for (const [name, module] of entries) supplied.set(name, module);
  configured = true;
}

export function suppliedWasm(seal = false) {
  if (seal) sealed = true;
  return configured ? Object.freeze(Object.fromEntries(supplied)) : undefined;
}
export const hasWasmModule = name => supplied.has(name);
const compiling = new Map();
export async function compileWasm(name, bytes) {
  if (used.get(name) || supplied.has(name)) return true;
  if (configured) throw error(`The ${name} module is missing; supply this package's.`);
  if (!compiling.has(name)) {
    if (!used.has(name)) used.set(name, null);
    compiling.set(name, (async () => {
      const module = await WebAssembly.compile(bytes());
      await WebAssembly.instantiate(Uint8Array.of(0, 97, 115, 109, 1, 0, 0, 0));
      if (!used.get(name)) used.set(name, module);
      return true;
    })().catch(() => { compiling.delete(name); return false; }));
  }
  return compiling.get(name);
}
export function wasmModule(name, bytes) {
  if (used.get(name)) return used.get(name);
  used.set(name, null);
  const module = supplied.get(name);
  if (module) { used.set(name, module); return module; }
  if (configured) throw error(`The ${name} module is missing; supply this package's.`);
  const compiled = new WebAssembly.Module(bytes());
  used.set(name, compiled);
  return compiled;
}
