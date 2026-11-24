// SPDX-License-Identifier: MIT
const stores = new WeakMap();

export function remember(data) {
  if (stores.has(data)) return () => {};
  stores.set(data, new Map());
  return () => stores.delete(data);
}

export function* recall(data, key, steps) {
  const store = stores.get(data);
  if (!store || key === null) return yield* steps();
  if (store.has(key)) return store.get(key);
  const value = yield* steps();
  store.set(key, value);
  return value;
}

export const spaceKey = colorSpace => colorSpace === undefined || typeof colorSpace === 'string' ? String(colorSpace) : null;

export function* capture(request) {
  const {data, width, height, colorSpace, effort, ...rest} = request, space = spaceKey(colorSpace);
  const key = space !== null && !Object.keys(rest).length ? `capture:${width}x${height}:${space}:${effort ?? ''}` : null;
  return yield* recall(data, key, function* () { return yield {capture: request}; });
}
