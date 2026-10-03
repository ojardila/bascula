/**
 * Passkey edges the main suite does not reach: browsers that answer the
 * capability questions badly, browsers that parse the JSON themselves, a
 * prompt that returns nothing, and a credential with no extension results.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  conditionalMediationAvailable,
  createPasskey,
  getPasskey,
  passkeyAlreadyHere,
  passkeyCancelled,
  passkeysSupported,
  platformPasskeyAvailable,
} from "./passkeys";

const bytes = (s: string) => new TextEncoder().encode(s).buffer as ArrayBuffer;

afterEach(() => {
  vi.unstubAllGlobals();
});

function stubPKC(statics: Record<string, unknown> = {}) {
  const PKC = function PublicKeyCredential() {} as unknown as Record<string, unknown>;
  Object.assign(PKC, statics);
  vi.stubGlobal("PublicKeyCredential", PKC);
}

function stubCredentials(credentials: Partial<CredentialsContainer> | undefined) {
  vi.stubGlobal("navigator", { ...navigator, credentials });
}

describe("passkeysSupported", () => {
  it("is false without a credentials container", () => {
    stubPKC();
    stubCredentials(undefined);
    expect(passkeysSupported()).toBe(false);
  });

  it("is false without a navigator", () => {
    stubPKC();
    vi.stubGlobal("navigator", undefined);
    expect(passkeysSupported()).toBe(false);
  });

  it("is true with WebAuthn and a credentials container", () => {
    stubPKC();
    stubCredentials({});
    expect(passkeysSupported()).toBe(true);
  });
});

describe("platformPasskeyAvailable", () => {
  it("is false where passkeys are not supported", async () => {
    vi.stubGlobal("PublicKeyCredential", undefined);
    await expect(platformPasskeyAvailable()).resolves.toBe(false);
  });

  it("is false when the browser cannot be asked", async () => {
    stubPKC();
    stubCredentials({});
    await expect(platformPasskeyAvailable()).resolves.toBe(false);
  });

  it("is false when asking throws", async () => {
    stubPKC({
      isUserVerifyingPlatformAuthenticatorAvailable: () => Promise.reject(new Error("x")),
    });
    stubCredentials({});
    await expect(platformPasskeyAvailable()).resolves.toBe(false);
  });

  it("passes the browser's answer through", async () => {
    stubPKC({ isUserVerifyingPlatformAuthenticatorAvailable: () => Promise.resolve(true) });
    stubCredentials({});
    await expect(platformPasskeyAvailable()).resolves.toBe(true);
  });
});

describe("conditionalMediationAvailable", () => {
  it("is false where passkeys are not supported", async () => {
    vi.stubGlobal("PublicKeyCredential", undefined);
    await expect(conditionalMediationAvailable()).resolves.toBe(false);
  });

  it("is false when the browser cannot be asked", async () => {
    stubPKC();
    stubCredentials({});
    await expect(conditionalMediationAvailable()).resolves.toBe(false);
  });

  it("is false when asking throws", async () => {
    stubPKC({ isConditionalMediationAvailable: () => Promise.reject(new Error("x")) });
    stubCredentials({});
    await expect(conditionalMediationAvailable()).resolves.toBe(false);
  });

  it("passes the browser's answer through", async () => {
    stubPKC({ isConditionalMediationAvailable: () => Promise.resolve(true) });
    stubCredentials({});
    await expect(conditionalMediationAvailable()).resolves.toBe(true);
  });
});

describe("error classification", () => {
  it("tells a cancelled prompt from a passkey already on the device", () => {
    expect(passkeyCancelled(new DOMException("x", "NotAllowedError"))).toBe(true);
    expect(passkeyCancelled(new DOMException("x", "AbortError"))).toBe(true);
    expect(passkeyCancelled(new DOMException("x", "InvalidStateError"))).toBe(false);
    expect(passkeyCancelled(new Error("x"))).toBe(false);
    expect(passkeyAlreadyHere(new DOMException("x", "InvalidStateError"))).toBe(true);
    expect(passkeyAlreadyHere(new DOMException("x", "NotAllowedError"))).toBe(false);
    expect(passkeyAlreadyHere("x")).toBe(false);
  });
});

describe("a browser that speaks the JSON itself", () => {
  it("uses the browser's parsers and the credential's own toJSON", async () => {
    const parsedCreate = { challenge: bytes("c") };
    const parsedGet = { challenge: bytes("g") };
    const parseCreationOptionsFromJSON = vi.fn(() => parsedCreate);
    const parseRequestOptionsFromJSON = vi.fn(() => parsedGet);
    stubPKC({ parseCreationOptionsFromJSON, parseRequestOptionsFromJSON });
    const create = vi.fn(async () => ({ toJSON: () => ({ id: "creada" }) }) as unknown as Credential);
    const get = vi.fn(async () => ({ toJSON: () => ({ id: "usada" }) }) as unknown as Credential);
    stubCredentials({ create, get });

    await expect(createPasskey({ challenge: "Yw" })).resolves.toEqual({ id: "creada" });
    expect(create).toHaveBeenCalledWith({ publicKey: parsedCreate });
    await expect(getPasskey({ challenge: "Zw" })).resolves.toEqual({ id: "usada" });
    expect(get).toHaveBeenCalledWith({ publicKey: parsedGet });
  });
});

describe("prompts that return nothing", () => {
  it("treats no credential from create as a cancel", async () => {
    stubPKC();
    stubCredentials({ create: async () => null });
    const err = await createPasskey({
      challenge: "Yw",
      user: { id: "dQ", name: "a", displayName: "A" },
    }).catch((e: unknown) => e);
    expect(passkeyCancelled(err)).toBe(true);
  });

  it("treats no credential from get as a cancel", async () => {
    stubPKC();
    stubCredentials({ get: async () => null });
    const err = await getPasskey({ challenge: "Yw" }).catch((e: unknown) => e);
    expect(passkeyCancelled(err)).toBe(true);
  });
});

describe("the fallback encoder", () => {
  it("leaves out what the authenticator did not send", async () => {
    stubPKC();
    const get = vi.fn(
      async () =>
        ({
          id: "eA",
          rawId: bytes("x"),
          type: "public-key",
          authenticatorAttachment: null,
          response: {
            clientDataJSON: bytes("{}"),
            authenticatorData: bytes("ad"),
            signature: bytes("sig"),
            userHandle: null,
          },
        }) as unknown as Credential,
    );
    stubCredentials({ get });
    const out = await getPasskey({ challenge: "Yw" }, { mediation: "conditional" });
    expect(out).toEqual({
      id: "eA",
      rawId: "eA",
      type: "public-key",
      response: {
        clientDataJSON: "e30",
        authenticatorData: "YWQ",
        signature: "c2ln",
        userHandle: undefined,
      },
      clientExtensionResults: {},
      authenticatorAttachment: undefined,
    });
    expect(get.mock.calls[0]).toEqual([expect.objectContaining({ mediation: "conditional" })]);
  });

  it("keeps an attestation without transports when the browser cannot list them", async () => {
    stubPKC();
    const create = vi.fn(
      async () =>
        ({
          id: "eA",
          rawId: bytes("x"),
          type: "public-key",
          getClientExtensionResults: () => ({ credProps: { rk: true } }),
          response: { clientDataJSON: bytes("{}"), attestationObject: bytes("att") },
        }) as unknown as Credential,
    );
    stubCredentials({ create });
    const out = await createPasskey({
      challenge: "Yw",
      user: { id: "dQ", name: "a", displayName: "A" },
    });
    expect(out.response).toEqual({ clientDataJSON: "e30", attestationObject: "YXR0" });
    expect(out.clientExtensionResults).toEqual({ credProps: { rk: true } });
  });
});
