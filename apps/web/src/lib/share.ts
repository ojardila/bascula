/**
 * Sending a receipt to the worker's WhatsApp.
 *
 * On a phone the Web Share API opens the system share sheet, where WhatsApp
 * is one tap away and the person picks the chat. Where there is no share
 * sheet (most computers) it falls back to wa.me, which opens WhatsApp Web or
 * the desktop app with the text already written.
 */

/**
 * `wa.me` wants the number in international form, digits only. A Colombian
 * mobile typed as ten digits starting with 3 gets its 57; anything else is
 * used as typed, and anything too short is dropped so WhatsApp asks for the
 * chat instead of opening a wrong one.
 */
export function whatsappNumber(phone: string | null | undefined): string | null {
  const digits = (phone ?? "").replace(/\D/g, "");
  if (digits.length === 10 && digits.startsWith("3")) return `57${digits}`;
  if (digits.length >= 11) return digits;
  return null;
}

export function whatsappUrl(text: string, phone?: string | null): string {
  const n = whatsappNumber(phone);
  return `https://wa.me/${n ?? ""}?text=${encodeURIComponent(text)}`;
}

export type ShareOutcome = "shared" | "opened" | "cancelled" | "failed";

export async function shareByWhatsApp(text: string, phone?: string | null): Promise<ShareOutcome> {
  const nav = navigator as Navigator & { share?: (d: { text: string }) => Promise<void> };
  const isTouch = typeof window !== "undefined" && window.matchMedia?.("(pointer: coarse)").matches;
  if (typeof nav.share === "function" && isTouch) {
    try {
      await nav.share({ text });
      return "shared";
    } catch (e) {
      if (e instanceof DOMException && e.name === "AbortError") return "cancelled";
      // Fall through to wa.me: a share sheet that failed is not a reason to give up.
    }
  }
  const w = window.open(whatsappUrl(text, phone), "_blank", "noopener");
  return w === null ? "failed" : "opened";
}
