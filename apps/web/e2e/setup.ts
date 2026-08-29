/**
 * Setup for the live-API suite. Deliberately tiny: the point of this suite is
 * that almost nothing is faked.
 *
 * The one thing provided is `localStorage`, because that is where the app
 * keeps the session and the device id. Node defines a global `localStorage`
 * that throws unless the process was started with `--localstorage-file`, and
 * it shadows anything else; the app survives that (every access is wrapped)
 * but then the session lives only in memory, and "does the session survive a
 * reload" is one of the things this suite checks.
 */
const store = new Map<string, string>();

const shim: Storage = {
  get length() {
    return store.size;
  },
  clear: () => store.clear(),
  getItem: (k) => store.get(k) ?? null,
  key: (i) => [...store.keys()][i] ?? null,
  removeItem: (k) => void store.delete(k),
  setItem: (k, v) => void store.set(k, String(v)),
};

Object.defineProperty(globalThis, "localStorage", {
  value: shim,
  configurable: true,
  writable: true,
});
