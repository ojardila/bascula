// SPDX-License-Identifier: MIT
/**
 * The JSON fallback for browsers without `parse*OptionsFromJSON`/`toJSON`:
 * binary members go out as ArrayBuffers and come back as base64url.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { createPasskey, getPasskey, passkeyCancelled, passkeysSupported } from "./passkeys";

const enc = new TextEncoder();
const bytes = (s: string) => enc.encode(s).buffer as ArrayBuffer;
const text = (b: BufferSource) => new TextDecoder().decode(b as ArrayBuffer);

afterEach(() => {
  vi.unstubAllGlobals();
});

function stubBrowser(credentials: Partial<CredentialsContainer>) {
  vi.stubGlobal("PublicKeyCredential", function PublicKeyCredential() {});
  vi.stubGlobal("navigator", { ...navigator, credentials });
}

describe("passkeys in an older browser", () => {
  it("is not offered without WebAuthn", () => {
    vi.stubGlobal("PublicKeyCredential", undefined);
    expect(passkeysSupported()).toBe(false);
  });

  it("decodes the creation options and encodes the attestation", async () => {
    const create = vi.fn(async (o?: CredentialCreationOptions) => {
      const pk = o!.publicKey!;
      expect(text(pk.challenge)).toBe("hola");
      expect(text(pk.user.id)).toBe("usuario");
      expect(text(pk.excludeCredentials![0].id)).toBe("vieja");
      return {
        id: "bnVldmE",
        rawId: bytes("nueva"),
        type: "public-key",
        authenticatorAttachment: "platform",
        getClientExtensionResults: () => ({}),
        response: {
          clientDataJSON: bytes("{}"),
          attestationObject: bytes("att"),
          getTransports: () => ["internal"],
        },
      } as unknown as Credential;
    });
    stubBrowser({ create });

    const out = await createPasskey({
      challenge: "aG9sYQ",
      rp: { name: "Báscula" },
      user: { id: "dXN1YXJpbw", name: "a@b.co", displayName: "A" },
      excludeCredentials: [{ type: "public-key", id: "dmllamE" }],
      pubKeyCredParams: [{ type: "public-key", alg: -7 }],
    });
    expect(out).toMatchObject({
      id: "bnVldmE",
      rawId: "bnVldmE",
      type: "public-key",
      response: { clientDataJSON: "e30", attestationObject: "YXR0", transports: ["internal"] },
    });
  });

  it("encodes an assertion, with the user handle", async () => {
    const get = vi.fn(async () => ({
      id: "aWQ",
      rawId: bytes("id"),
      type: "public-key",
      getClientExtensionResults: () => ({}),
      response: {
        clientDataJSON: bytes("{}"),
        authenticatorData: bytes("ad"),
        signature: bytes("sig"),
        userHandle: bytes("u"),
      },
    }) as unknown as Credential);
    stubBrowser({ get });

    const out = await getPasskey({ challenge: "aG9sYQ", rpId: "localhost" });
    expect(out.response).toEqual({
      clientDataJSON: "e30",
      authenticatorData: "YWQ",
      signature: "c2ln",
      userHandle: "dQ",
    });
  });

  it("treats a closed prompt as a cancel, not an error", async () => {
    stubBrowser({ get: vi.fn(async () => null) });
    const err = await getPasskey({ challenge: "aG9sYQ" }).catch((e: unknown) => e);
    expect(passkeyCancelled(err)).toBe(true);
  });
});
