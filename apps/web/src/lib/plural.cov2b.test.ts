// SPDX-License-Identifier: MIT
import { describe, expect, it } from "vitest";
import { unitLabel } from "./plural";

describe("unitLabel", () => {
  it("turns a final z into -ces", () => {
    expect(unitLabel(3, "Cruz")).toBe("cruces");
  });
});
