import "@testing-library/jest-dom/vitest";
import { afterAll, afterEach, beforeAll } from "vitest";
import { cleanup } from "@testing-library/react";
import { server } from "../mocks/node";

// The same handlers the browser uses, so a test cannot pass against a mock the
// app never sees.
beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterEach(() => {
  cleanup();
  server.resetHandlers();
});
afterAll(() => server.close());

/**
 * Node 26 defines a global `localStorage` that is undefined unless the process
 * was started with --localstorage-file, and it shadows the one jsdom would
 * otherwise install. The app already survives this (every access is wrapped),
 * but the tests need a working one to sign anybody in.
 */
if (!globalThis.localStorage) {
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
  Object.defineProperty(globalThis, "localStorage", { value: shim, configurable: true });
  Object.defineProperty(window, "localStorage", { value: shim, configurable: true });
}

// jsdom has no matchMedia at all; MUI asks for it on mount.
if (!window.matchMedia) {
  window.matchMedia = ((query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia;
}

/**
 * jsdom implements no ResizeObserver, and the harvest charts measure their
 * container so the SVG is drawn at real pixels rather than being scaled.
 *
 * The shim reports a fixed width and calls back once, which is what a browser
 * does on observe. Without it the charts throw on mount and every screen that
 * carries one renders as a blank — a failure that says "ResizeObserver is not
 * defined" and looks nothing like the assertion that actually failed.
 */
if (!globalThis.ResizeObserver) {
  class TestResizeObserver implements ResizeObserver {
    constructor(private readonly cb: ResizeObserverCallback) {}
    observe(target: Element) {
      this.cb(
        [{ contentRect: { width: 640, height: 200 } } as ResizeObserverEntry],
        this as unknown as ResizeObserver,
      );
      void target;
    }
    unobserve() {}
    disconnect() {}
  }
  globalThis.ResizeObserver = TestResizeObserver as unknown as typeof ResizeObserver;
}
