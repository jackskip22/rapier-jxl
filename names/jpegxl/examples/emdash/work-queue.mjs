// SPDX-License-Identifier: MIT
export const WORK_STORAGE = {jxlWork: {indexes: ['scope']}};

const ID = /^[a-f0-9]{32}$/;
const fail = (code, message) => Object.assign(new Error(message), {code});
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
function json(value) {
  try {
    return JSON.stringify(value, (_, item) => {
      if (['undefined', 'function', 'symbol', 'bigint'].includes(typeof item) || typeof item === 'number' && !Number.isFinite(item))
        throw new TypeError();
      return record(item) ? Object.fromEntries(Object.keys(item).sort().map(key => [key, item[key]])) : item;
    });
  } catch { throw fail('JXL_INPUT', 'Expected an immutable JSON work command.'); }
}

// One recurring task per site, backed by immutable work rows. An idle task is retained: canceling it after an
// empty read can race an enqueue and strand accepted work. The host owns the wake and its dispatch lock.
export function createWorkQueue(ctx, {scope, call = action => action()} = {}) {
  const table = ctx?.storage?.jxlWork;
  if (typeof scope !== 'string' || typeof call !== 'function' || typeof ctx?.cron?.schedule !== 'function' || typeof ctx?.cron?.list !== 'function' ||
      ['get', 'compareAndSet', 'delete', 'query'].some(name => typeof table?.[name] !== 'function'))
    throw fail('JXL_OPTIONS', 'Expected native work storage and EmDash scheduling.');
  function keyOf(kind, id) {
    if (!['image', 'library', 'originals'].includes(kind) || typeof id !== 'string' || !ID.test(id))
      throw fail('JXL_INPUT', 'Expected an image, library or originals work ID.');
    return `${scope}:${kind}:${id}`;
  }
  function rowOf(kind, id, command) {
    keyOf(kind, id);
    if (kind === 'image' && (!record(command) || command.id !== id || command.scope !== scope) ||
        kind !== 'image' && command !== undefined)
      throw fail('JXL_INPUT', 'The work command belongs to another ID, kind or storage scope.');
    return {scope, kind, id, ...(command === undefined ? {} : {command})};
  }
  return {
    async schedule(kind, id, command) {
      const key = keyOf(kind, id), encoded = json(rowOf(kind, id, command)), value = JSON.parse(encoded);
      // Scheduling an existing EmDash task resets its next wake. Keep the persistent task so busy uploads do not
      // continually postpone it. Establish it before the registry row; concurrent first admissions may both upsert.
      const tasks = await call(() => ctx.cron.list());
      if (!Array.isArray(tasks)) throw fail('JXL_IO', 'EmDash returned an invalid scheduled-task list.');
      if (!tasks.some(task => task?.name === 'jxl-work'))
        await call(() => ctx.cron.schedule('jxl-work', {schedule: '* * * * * *', data: {kind: 'images'}}));
      const saved = await call(() => table.compareAndSet(key, null, value));
      if (saved?.applied === true) return;
      if (saved?.applied !== false) throw fail('JXL_IO', 'The work registry write was not acknowledged.');
      const current = await call(() => table.get(key));
      if (current === null) throw fail('JXL_IO', 'The work registry changed during admission.');
      if (json(current) !== encoded) throw fail('JXL_INPUT', 'This work ID belongs to another command or storage scope.');
    },
    remove(kind, id) {
      const key = keyOf(kind, id);
      return call(() => table.delete(key));
    },
    async list(cursor) {
      if (cursor !== undefined && typeof cursor !== 'string') throw fail('JXL_INPUT', 'Expected the saved work cursor.');
      // EmDash's default query order is created_at ASC, id ASC and its cursor survives a removed anchor row.
      const page = await call(() => table.query({where: {scope}, limit: 16, ...(cursor === undefined ? {} : {cursor})}));
      if (!record(page) || !Array.isArray(page.items) || page.items.length > 16 || typeof page.hasMore !== 'boolean' ||
          page.cursor !== undefined && typeof page.cursor !== 'string' || page.hasMore && !page.cursor)
        throw fail('JXL_IO', 'The work registry returned an invalid page.');
      for (const row of page.items) {
        if (!record(row?.data) || row.data.scope !== scope || row.id !== keyOf(row.data.kind, row.data.id) ||
            json(row.data) !== json(rowOf(row.data.kind, row.data.id, row.data.command)))
          throw fail('JXL_INPUT', 'The work registry row belongs to another command or storage scope.');
      }
      return page;
    },
  };
}
