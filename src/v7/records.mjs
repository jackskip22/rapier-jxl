const NATIVE_OBJECT = /^function Object\(\) \{\s*\[native code\]\s*\}$/;
export function plain(proto) {
  if (proto === null || proto === Object.prototype) return true;
  if (Object.getPrototypeOf(proto) !== null) return false;
  const constructor = Object.getOwnPropertyDescriptor(proto, 'constructor');
  return !!constructor && 'value' in constructor && typeof constructor.value === 'function' &&
    NATIVE_OBJECT.test(Function.prototype.toString.call(constructor.value));
}
export function isPlainRecord(value) { return !!value && typeof value === 'object' && plain(Object.getPrototypeOf(value)); }
