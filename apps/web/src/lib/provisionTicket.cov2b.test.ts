// SPDX-License-Identifier: MIT
/**
 * Private mode: localStorage refuses, and the ticket lives in memory until the
 * page reloads.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { loadProvisionTicket, provisionTicketHeaders, saveProvisionTicket } from "./provisionTicket";

afterEach(() => vi.restoreAllMocks());

describe("provision ticket without storage", () => {
  it("keeps the ticket in memory when storage refuses it", () => {
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("QuotaExceededError");
    });
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("SecurityError");
    });
    saveProvisionTicket("LaPalma", "tk-1");
    expect(loadProvisionTicket("lapalma")).toBe("tk-1");
    expect(provisionTicketHeaders("LAPALMA")).toEqual({ "X-Provision-Ticket": "tk-1" });
    expect(loadProvisionTicket("nadie")).toBeNull();
  });
});
