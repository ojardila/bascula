// SPDX-License-Identifier: MIT
/**
 * When to offer a passkey after a password sign-in, on a device that can hold
 * one: never twice for the same person, and never when the passkey list
 * cannot be read.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { http, HttpResponse } from "msw";
import { server } from "../mocks/node";
import { markPasskeyOfferSeen, passkeyOfferSeen, shouldOfferPasskey } from "./passkeyOffer";

const KEY = "bascula.passkeyOffer.v1";

function deviceWithPlatformAuthenticator() {
  const PKC = function PublicKeyCredential() {} as unknown as Record<string, unknown>;
  PKC.isUserVerifyingPlatformAuthenticatorAvailable = async () => true;
  vi.stubGlobal("PublicKeyCredential", PKC);
  vi.stubGlobal("navigator", { ...navigator, credentials: {} });
}

beforeEach(() => localStorage.removeItem(KEY));
afterEach(() => {
  vi.unstubAllGlobals();
  localStorage.removeItem(KEY);
});

describe("passkey offer", () => {
  it("treats a stored value that is not a list as nobody seen", () => {
    localStorage.setItem(KEY, JSON.stringify({ "ana@finca.co": true }));
    expect(passkeyOfferSeen("ana@finca.co")).toBe(false);
    markPasskeyOfferSeen("Ana@Finca.co ");
    expect(passkeyOfferSeen("ana@finca.co")).toBe(true);
  });

  it("does not offer when the passkey list cannot be read", async () => {
    deviceWithPlatformAuthenticator();
    server.use(
      http.get("*/v1/me/passkeys", () =>
        HttpResponse.json({ error: { code: "INTERNAL", message: "boom" } }, { status: 500 }),
      ),
    );
    expect(await shouldOfferPasskey("ana@finca.co")).toBe(false);
  });

  it("offers on a capable device to a person with no passkeys yet", async () => {
    deviceWithPlatformAuthenticator();
    server.use(http.get("*/v1/me/passkeys", () => HttpResponse.json({ items: [] })));
    expect(await shouldOfferPasskey("ana@finca.co")).toBe(true);
  });
});
