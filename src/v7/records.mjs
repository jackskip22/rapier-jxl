const nativeObject = Function.prototype.toString.call(Object);
export function plain(proto) {
  if (proto === null || proto === Object.prototype) return true;
  if (Object.getPrototypeOf(proto) !== null) return false;
  const constructor = Object.getOwnPropertyDescriptor(proto, 'constructor');
  return !!constructor && 'value' in constructor && typeof constructor.value === 'function' && Function.prototype.toString.call(constructor.value) === nativeObject;
}
export function isPlainRecord(value) { return !!value && typeof value === 'object' && plain(Object.getPrototypeOf(value)); }
