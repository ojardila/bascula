import { describe, expect, it } from "vitest";
import { looksLikeEmail } from "./email";

describe("looksLikeEmail", () => {
  it.each([
    ["nombre@correo.com", true],
    ["a@b.c", true],
    ["a@b.c.d", true],
    ["a@b..c", true],
    ["", false],
    ["@correo.com", false],
    ["nombre@", false],
    ["nombre@correo", false],
    ["nombre@.com", false],
    ["nombre@correo.", false],
    ["a@b@c.com", false],
    ["nom bre@correo.com", false],
    ["nombre@correo.com\n", false],
  ])("%j -> %s", (raw, expected) => {
    expect(looksLikeEmail(raw)).toBe(expected);
  });
});
