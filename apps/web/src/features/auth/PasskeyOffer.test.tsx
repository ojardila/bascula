// SPDX-License-Identifier: MIT
import { describe, expect, it } from "vitest";
import { offeredPasskeyName } from "./PasskeyOffer";
import { markPasskeyOfferSeen, passkeyOfferSeen } from "../../lib/passkeyOffer";

describe("offeredPasskeyName", () => {
  it("names the passkey after the device, or the default", () => {
    expect(
      offeredPasskeyName(
        "Mozilla/5.0 (iPhone; CPU iPhone OS 18_7 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.1 Mobile/15E148 Safari/604.1",
      ),
    ).toBe("Safari en iPhone");
    expect(offeredPasskeyName("okhttp/4")).toBe("Llave de acceso");
  });
});

describe("passkey offer memory", () => {
  it("remembers per address, case-insensitively, and survives bad storage", () => {
    localStorage.clear();
    expect(passkeyOfferSeen("Oscar@LaEsperanza.co")).toBe(false);
    markPasskeyOfferSeen("Oscar@LaEsperanza.co ");
    markPasskeyOfferSeen("oscar@laesperanza.co");
    expect(passkeyOfferSeen("oscar@laesperanza.co")).toBe(true);
    expect(
      JSON.parse(localStorage.getItem("bascula.passkeyOffer.v1")!),
    ).toHaveLength(1);
    localStorage.setItem("bascula.passkeyOffer.v1", "{not json");
    expect(passkeyOfferSeen("oscar@laesperanza.co")).toBe(false);
  });
});
