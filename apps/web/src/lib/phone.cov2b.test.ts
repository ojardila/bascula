// SPDX-License-Identifier: MIT
import { describe, expect, it } from "vitest";
import { phoneProblem } from "./phone";

describe("phoneProblem", () => {
  it("has a sentence for every reason", () => {
    expect(phoneProblem("characters")).toMatch(/solo números/);
    expect(phoneProblem("international")).toMatch(/número internacional/);
    expect(phoneProblem("filler")).toMatch(/no parece real/);
  });
});
