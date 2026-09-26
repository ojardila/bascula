import { beforeEach, describe, expect, it } from "vitest";
import { loadProvisionTicket, provisionTicketHeaders, saveProvisionTicket } from "./provisionTicket";

describe("provision ticket", () => {
  beforeEach(() => localStorage.clear());

  it("is kept per slug and sent as a header", () => {
    saveProvisionTicket("La-Palma", "abc.123.sig");
    expect(loadProvisionTicket("la-palma")).toBe("abc.123.sig");
    expect(provisionTicketHeaders("la-palma")).toEqual({ "X-Provision-Ticket": "abc.123.sig" });
  });

  it("sends nothing for a farm this browser did not create", () => {
    saveProvisionTicket("la-palma", "abc.123.sig");
    expect(provisionTicketHeaders("otra-finca")).toBeUndefined();
  });

  it("ignores an empty ticket", () => {
    saveProvisionTicket("la-palma", undefined);
    expect(loadProvisionTicket("la-palma")).toBeNull();
  });
});
