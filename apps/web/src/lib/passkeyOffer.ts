/**
 * «¿Quiere entrar más rápido la próxima vez?»: after a password sign-in, a
 * device that can hold a passkey, for a person who has none on this farm
 * address, is offered one. Once per person on this browser, whatever the
 * answer: asking at every sign-in would be nagging.
 *
 * localStorage is per address, so "this browser" here already means "this
 * farm address", which is exactly where a passkey belongs.
 */
import { api } from "../api/endpoints";
import { platformPasskeyAvailable } from "./passkeys";

const KEY = "bascula.passkeyOffer.v1";

function seenList(): string[] {
  try {
    const raw = localStorage.getItem(KEY);
    const list: unknown = raw ? JSON.parse(raw) : [];
    return Array.isArray(list) ? list.filter((x) => typeof x === "string") : [];
  } catch {
    return [];
  }
}

const norm = (email: string) => email.trim().toLowerCase();

export function passkeyOfferSeen(email: string): boolean {
  return seenList().includes(norm(email));
}

export function markPasskeyOfferSeen(email: string): void {
  const list = seenList();
  if (list.includes(norm(email))) return;
  try {
    localStorage.setItem(KEY, JSON.stringify([...list, norm(email)]));
  } catch {
    // Without storage the offer may come back once more; that is all.
  }
}

/**
 * Whether to offer a passkey now. Asked right after the session opened, so
 * the list is the caller's passkeys on this address. Any failure means no.
 */
export async function shouldOfferPasskey(email: string): Promise<boolean> {
  if (passkeyOfferSeen(email)) return false;
  if (!(await platformPasskeyAvailable())) return false;
  try {
    return (await api.listPasskeys()).length === 0;
  } catch {
    return false;
  }
}
