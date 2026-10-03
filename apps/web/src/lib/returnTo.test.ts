// SPDX-License-Identifier: MIT
import { describe, expect, it } from "vitest";
import { safeReturnPath } from "./returnTo";

describe("safeReturnPath", () => {
  it("keeps a page of this app, with its query and hash", () => {
    expect(safeReturnPath("/configuracion")).toBe("/configuracion");
    expect(safeReturnPath("/empleados/123/editar?x=1#a")).toBe("/empleados/123/editar?x=1#a");
  });

  it("refuses anything that could leave the app", () => {
    for (const bad of [
      "https://evil.example/",
      "http://evil.example",
      "//evil.example/path",
      "/\\evil.example",
      "\\\\evil.example",
      "javascript:alert(1)",
      "/\t/evil.example",
      "/\n/evil.example",
      "evil.example",
      "configuracion",
      "",
    ]) {
      expect(safeReturnPath(bad), bad).toBeNull();
    }
  });

  it("refuses what is not a string, the front door and the login page", () => {
    expect(safeReturnPath(undefined)).toBeNull();
    expect(safeReturnPath(null)).toBeNull();
    expect(safeReturnPath({ pathname: "/x" })).toBeNull();
    expect(safeReturnPath("/")).toBeNull();
    expect(safeReturnPath("/entrar")).toBeNull();
  });
});
