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

  it("refuses every control character, wherever it sits", () => {
    for (const bad of [
      "/\u0000//evil.example",
      "/\u001f/evil.example",
      "/\u007f/evil.example",
      "/\r//evil.example",
      "/configuracion\u0000",
      "\u0000//evil.example",
    ]) {
      expect(safeReturnPath(bad), JSON.stringify(bad)).toBeNull();
    }
  });

  it("keeps characters outside the BMP inside the app", () => {
    // A surrogate pair is one code point well above the control range: it is
    // percent-encoded into the path, never read as a way out.
    expect(safeReturnPath("/campo/\u{1F33E}")).toBe("/campo/%F0%9F%8C%BE");
    expect(safeReturnPath("/\u{1F33E}//evil.example")).toBe("/%F0%9F%8C%BE//evil.example");
    for (const bad of ["\u{1F33E}//evil.example", "//\u{1F33E}.example", "/\\\u{1F33E}.example"]) {
      expect(safeReturnPath(bad), JSON.stringify(bad)).toBeNull();
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
