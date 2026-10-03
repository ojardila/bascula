// SPDX-License-Identifier: MIT
/** Printing where there is no document at all (server rendering, a worker). */
import { afterEach, describe, expect, it, vi } from "vitest";
import { printDocument } from "./print";

afterEach(() => vi.unstubAllGlobals());

describe("printDocument with no DOM", () => {
  it("says it could not hand the document over", () => {
    vi.stubGlobal("document", undefined);
    expect(printDocument("<p>Recibo</p>")).toBe(false);
  });
});
