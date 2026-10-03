// SPDX-License-Identifier: MIT
import { describe, expect, it } from "vitest";
import {
  ApiError,
  duplicateTagField,
  duplicateTagHolder,
  ERROR_MESSAGES,
  FIELD_REASONS,
  messageFor,
} from "./errors";

describe("ApiError", () => {
  it("falls back to the given text, then to a network sentence", () => {
    expect(new ApiError(500, null, "fallo").message).toBe("fallo");
    const bare = new ApiError(0, null);
    expect(bare.message).toBe("Error de red");
    expect(bare.code).toBe("UNKNOWN");
    expect(bare.details).toEqual({});
    expect(bare.fieldErrors).toEqual({});
  });

  it("names who holds a duplicate basket number", () => {
    const err = new ApiError(409, {
      error: {
        code: "DUPLICATE_TAG",
        message: "dup",
        details: { name: "Yorman", lastName: "Pérez" },
      },
    });
    expect(duplicateTagHolder(err)).toBe("Yorman Pérez");
    expect(err.spanishMessage).toBe(
      "Ese número de canasto ya lo tiene Yorman Pérez. Escriba otro número.",
    );
    expect(duplicateTagField(err)).toBe("Ese número ya lo tiene Yorman Pérez.");
  });

  it("falls back to the server text when the holder is unknown", () => {
    const err = new ApiError(409, {
      error: {
        code: "DUPLICATE_TAG",
        message: "dup tag",
        details: { name: 3 },
      },
    });
    expect(duplicateTagHolder(err)).toBeNull();
    expect(duplicateTagField(err)).toBe(
      "Ese número ya lo tiene otro trabajador.",
    );
    expect(err.spanishMessage).toBe(ERROR_MESSAGES.DUPLICATE_TAG ?? "dup tag");
  });

  it("has no holder for other codes", () => {
    const err = new ApiError(409, {
      error: { code: "OTHER", message: "x", details: { name: "A" } },
    });
    expect(duplicateTagHolder(err)).toBeNull();
  });

  it("maps field errors and replaces non-text reasons", () => {
    const err = new ApiError(400, {
      error: {
        code: "VALIDATION",
        message: "bad",
        details: { fields: { name: "Es demasiado largo.", age: 7 } },
      },
    });
    expect(err.fieldErrors).toEqual({
      name: "Es demasiado largo.",
      age: FIELD_REASONS.required,
    });
  });

  it("ignores a fields entry that is not an object", () => {
    const err = new ApiError(400, {
      error: { code: "X", message: "m", details: { fields: "nope" } },
    });
    expect(err.fieldErrors).toEqual({});
  });

  it("knows a local NOT_IMPLEMENTED refusal", () => {
    expect(
      new ApiError(0, {
        error: { code: "NOT_IMPLEMENTED_X", message: "m", details: {} },
      }).isUnsupported,
    ).toBe(true);
    expect(
      new ApiError(501, {
        error: { code: "NOT_IMPLEMENTED_X", message: "m", details: {} },
      }).isUnsupported,
    ).toBe(false);
    expect(
      new ApiError(0, { error: { code: "NETWORK", message: "m", details: {} } })
        .isUnsupported,
    ).toBe(false);
  });
});

describe("messageFor", () => {
  it("uses an Error's message, else the unknown sentence", () => {
    expect(messageFor(new Error("se cayó"))).toBe("se cayó");
    expect(messageFor(new Error(""))).toBe(ERROR_MESSAGES.UNKNOWN);
    expect(messageFor("texto")).toBe(ERROR_MESSAGES.UNKNOWN);
    expect(messageFor(null)).toBe(ERROR_MESSAGES.UNKNOWN);
  });
});
