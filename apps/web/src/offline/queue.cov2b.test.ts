// SPDX-License-Identifier: MIT
import { describe, expect, it } from "vitest";
import { ApiError } from "../api/errors";
import { isRetryable } from "./queue";

describe("isRetryable", () => {
  it("retries anything that is not an answer from the server", () => {
    expect(isRetryable(new TypeError("Failed to fetch"))).toBe(true);
  });

  it("does not retry a refusal about the data", () => {
    expect(isRetryable(new ApiError(422, null))).toBe(false);
  });
});
