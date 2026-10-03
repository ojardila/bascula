// SPDX-License-Identifier: MIT
import { describe, expect, it } from "vitest";
import { trimTrailing } from "./trimTrailing";

describe("trimTrailing", () => {
  it("drops every trailing copy of the character", () => {
    expect(trimTrailing("/cosecha//", "/")).toBe("/cosecha");
    expect(trimTrailing("https://x.bascula.co/", "/")).toBe("https://x.bascula.co");
    expect(trimTrailing("YWJj==", "=")).toBe("YWJj");
  });

  it("leaves the rest alone", () => {
    expect(trimTrailing("/cosecha", "/")).toBe("/cosecha");
    expect(trimTrailing("/a/b", "/")).toBe("/a/b");
    expect(trimTrailing("", "/")).toBe("");
    expect(trimTrailing("///", "/")).toBe("");
  });
});
