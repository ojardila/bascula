// SPDX-License-Identifier: MIT
import { afterEach, describe, expect, it, vi } from "vitest";
import { printDocument } from "./print";

function frame(): HTMLIFrameElement {
  const f = document.querySelector<HTMLIFrameElement>(
    "iframe[title='Documento para imprimir']",
  );
  if (!f) throw new Error("no print frame");
  return f;
}

/** Gives the frame a window whose print() does what the test says. */
function fakeWindow(print: () => void) {
  const listeners: Record<string, () => void> = {};
  const win = {
    focus: vi.fn(),
    print: vi.fn(print),
    addEventListener: (name: string, fn: () => void) => {
      listeners[name] = fn;
    },
  };
  Object.defineProperty(frame(), "contentWindow", {
    configurable: true,
    value: win,
  });
  return { win, listeners };
}

describe("printDocument", () => {
  afterEach(() => {
    document.querySelectorAll("iframe").forEach((f) => f.remove());
    vi.useRealTimers();
  });

  it("prints from an off-screen frame and removes it once the dialog closes", () => {
    expect(printDocument("<p>Recibo</p>")).toBe(true);
    expect(frame().srcdoc).toBe("<p>Recibo</p>");
    expect(frame().getAttribute("aria-hidden")).toBe("true");

    const { win, listeners } = fakeWindow(() => undefined);
    frame().onload!(new Event("load"));
    expect(win.focus).toHaveBeenCalled();
    expect(win.print).toHaveBeenCalled();
    // Still there while the dialog is open: removing it would cancel the job.
    expect(document.querySelector("iframe")).not.toBeNull();

    listeners.afterprint();
    expect(document.querySelector("iframe")).toBeNull();
    listeners.afterprint(); // a second signal is harmless
  });

  it("falls back to a timer where afterprint never fires", () => {
    vi.useFakeTimers();
    printDocument("<p>x</p>");
    fakeWindow(() => undefined);
    frame().onload!(new Event("load"));
    vi.advanceTimersByTime(59_999);
    expect(document.querySelector("iframe")).not.toBeNull();
    vi.advanceTimersByTime(1);
    expect(document.querySelector("iframe")).toBeNull();
  });

  it("cleans up when the frame refuses to print", () => {
    printDocument("<p>x</p>");
    fakeWindow(() => {
      throw new Error("blocked");
    });
    frame().onload!(new Event("load"));
    expect(document.querySelector("iframe")).toBeNull();
  });

  it("cleans up when the frame has no window", () => {
    printDocument("<p>x</p>");
    Object.defineProperty(frame(), "contentWindow", {
      configurable: true,
      value: null,
    });
    frame().onload!(new Event("load"));
    expect(document.querySelector("iframe")).toBeNull();
  });
});
