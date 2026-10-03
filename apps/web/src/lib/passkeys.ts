/**
 * Passkeys in the browser: the two WebAuthn calls, with the JSON the API
 * speaks on both sides.
 *
 * The server sends options in their JSON form (binary members as base64url)
 * and wants the credential back the same way. Recent browsers do that
 * conversion themselves (`parse*OptionsFromJSON`, `toJSON`); older ones get
 * the small fallback below, so a phone a couple of years old still works.
 */

type Json = Record<string, unknown>;

/** Whether this browser can use passkeys at all. */
export function passkeysSupported(): boolean {
  return (
    typeof window !== "undefined" &&
    typeof window.PublicKeyCredential === "function" &&
    typeof navigator !== "undefined" &&
    !!navigator.credentials
  );
}

/** The person closed the prompt or it timed out: not an error worth showing. */
export function passkeyCancelled(e: unknown): boolean {
  return (
    e instanceof DOMException &&
    (e.name === "NotAllowedError" || e.name === "AbortError")
  );
}

/** A passkey this device already holds for the account (excludeCredentials). */
export function passkeyAlreadyHere(e: unknown): boolean {
  return e instanceof DOMException && e.name === "InvalidStateError";
}

function fromB64url(s: string): ArrayBuffer {
  const b64 = s
    .replaceAll("-", "+")
    .replaceAll("_", "/")
    .padEnd(Math.ceil(s.length / 4) * 4, "=");
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.codePointAt(i) ?? 0;
  return out.buffer;
}

function toB64url(buf: ArrayBuffer | null | undefined): string | undefined {
  if (!buf) return undefined;
  const bytes = new Uint8Array(buf);
  let bin = "";
  for (const b of bytes) bin += String.fromCodePoint(b);
  return btoa(bin).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

function descriptors(
  list: unknown,
): PublicKeyCredentialDescriptor[] | undefined {
  if (!Array.isArray(list)) return undefined;
  return list.map(
    (d: Json) =>
      ({
        ...d,
        id: fromB64url(d.id as string),
      }) as PublicKeyCredentialDescriptor,
  );
}

type PKC = typeof PublicKeyCredential & {
  parseCreationOptionsFromJSON?: (
    o: Json,
  ) => PublicKeyCredentialCreationOptions;
  parseRequestOptionsFromJSON?: (o: Json) => PublicKeyCredentialRequestOptions;
};

function creationOptions(json: Json): PublicKeyCredentialCreationOptions {
  const pkc = window.PublicKeyCredential as PKC;
  if (pkc.parseCreationOptionsFromJSON)
    return pkc.parseCreationOptionsFromJSON(json);
  const user = json.user as Json;
  return {
    ...(json as object),
    challenge: fromB64url(json.challenge as string),
    user: { ...(user as object), id: fromB64url(user.id as string) },
    excludeCredentials: descriptors(json.excludeCredentials),
  } as PublicKeyCredentialCreationOptions;
}

function requestOptions(json: Json): PublicKeyCredentialRequestOptions {
  const pkc = window.PublicKeyCredential as PKC;
  if (pkc.parseRequestOptionsFromJSON)
    return pkc.parseRequestOptionsFromJSON(json);
  return {
    ...(json as object),
    challenge: fromB64url(json.challenge as string),
    allowCredentials: descriptors(json.allowCredentials),
  } as PublicKeyCredentialRequestOptions;
}

function credentialJSON(cred: PublicKeyCredential): Json {
  const withJSON = cred as PublicKeyCredential & { toJSON?: () => Json };
  if (typeof withJSON.toJSON === "function") return withJSON.toJSON();
  const r = cred.response as AuthenticatorAttestationResponse &
    AuthenticatorAssertionResponse;
  const response: Json = { clientDataJSON: toB64url(r.clientDataJSON) };
  if ("attestationObject" in r && r.attestationObject) {
    response.attestationObject = toB64url(r.attestationObject);
    if (typeof r.getTransports === "function")
      response.transports = r.getTransports();
  }
  if ("authenticatorData" in r && r.authenticatorData) {
    response.authenticatorData = toB64url(r.authenticatorData);
    response.signature = toB64url(r.signature);
    response.userHandle = toB64url(r.userHandle);
  }
  return {
    id: cred.id,
    rawId: toB64url(cred.rawId),
    type: cred.type,
    response,
    clientExtensionResults: cred.getClientExtensionResults?.() ?? {},
    authenticatorAttachment: cred.authenticatorAttachment ?? undefined,
  };
}

/** navigator.credentials.create, JSON in and JSON out. */
export async function createPasskey(publicKey: Json): Promise<Json> {
  const cred = (await navigator.credentials.create({
    publicKey: creationOptions(publicKey),
  })) as PublicKeyCredential | null;
  if (!cred) throw new DOMException("no credential", "NotAllowedError");
  return credentialJSON(cred);
}

/** navigator.credentials.get, JSON in and JSON out. */
export async function getPasskey(publicKey: Json): Promise<Json> {
  const cred = (await navigator.credentials.get({
    publicKey: requestOptions(publicKey),
  })) as PublicKeyCredential | null;
  if (!cred) throw new DOMException("no credential", "NotAllowedError");
  return credentialJSON(cred);
}
