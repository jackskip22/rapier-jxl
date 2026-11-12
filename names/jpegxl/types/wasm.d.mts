declare const brand: unique symbol;
/** The package's WebAssembly modules, for `configureWasm`. Its layout is private, and only this copy and version of
 * rapier-jxl accept it. */
export interface WasmBundle { readonly [brand]: true }
declare const wasm: WasmBundle;
export default wasm;
