// Persistent key/value state kept in memory and written to a JSON file.
// Listeners receive the changed keys as { key: { newValue } }.

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

const WRITE_DELAY_MS = 200;

export async function createStore(file, defaults) {
  let data = {};
  try {
    data = JSON.parse(await readFile(file, 'utf8'));
  } catch (err) {
    if (err.code !== 'ENOENT') throw new Error(`Could not read ${file}: ${err.message}`);
  }
  data = { ...structuredClone(defaults), ...data };

  const listeners = new Set();
  let timer = null;
  let writing = Promise.resolve();

  function emit(changes) {
    if (!Object.keys(changes).length) return;
    scheduleWrite();
    for (const listener of listeners) listener(changes);
  }

  function scheduleWrite() {
    clearTimeout(timer);
    timer = setTimeout(flush, WRITE_DELAY_MS);
  }

  // Writes to a temporary file first so a crash mid-write never leaves a truncated state file.
  function flush() {
    clearTimeout(timer);
    timer = null;
    const json = JSON.stringify(data);
    writing = writing.then(async () => {
      await mkdir(dirname(file), { recursive: true });
      await writeFile(`${file}.tmp`, json);
      await rename(`${file}.tmp`, file);
    });
    return writing;
  }

  return {
    get(keys) {
      if (keys == null) return structuredClone(data);
      const list = [].concat(keys);
      return structuredClone(Object.fromEntries(list.filter((k) => k in data).map((k) => [k, data[k]])));
    },
    set(values) {
      const changes = {};
      for (const [key, value] of Object.entries(values)) {
        data[key] = structuredClone(value);
        changes[key] = { newValue: structuredClone(value) };
      }
      emit(changes);
    },
    remove(keys) {
      const changes = {};
      for (const key of [].concat(keys)) {
        if (!(key in data)) continue;
        delete data[key];
        changes[key] = { newValue: undefined };
      }
      emit(changes);
    },
    onChanged(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    flush,
  };
}
