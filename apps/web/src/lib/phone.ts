/**
 * A contact phone number, checked the way a person reading it would.
 *
 * The demo form used to accept anything with seven digits in it: "1234567",
 * "abc 0000000", a cédula. Somebody then tries to call it. The numbers the
 * farms actually give are Colombian, so those are checked against the real
 * numbering plan, and anything else has to be written as an international
 * number with its "+" and country code.
 *
 * Colombia (Resolución CRC 5826 de 2019, in force since September 2021):
 *
 *   - mobile: 10 digits starting with 3, operator block 30x–35x
 *     (310 482 7391)
 *   - landline: 10 digits starting with 60 and the region digit 1–8
 *     (601 742 3856 in Bogotá, 604 in Medellín, 602 in Cali…)
 *
 * Either may come with +57, 0057 or 57 in front. The old seven-digit landline
 * stopped working when the 60X prefix became mandatory, so it is refused with
 * a message that says how to write it now.
 *
 * Filler is refused too: the seven subscriber digits all the same
 * (300 000 0000) or a straight run (300 123 4567, 310 765 4321). Those are
 * what people type to get past a form, and nobody answers them.
 */

export type PhoneCheck =
  | { ok: true; e164: string; display: string }
  | { ok: false; reason: "empty" | "characters" | "colombia" | "international" | "filler" };

const ALLOWED = /^[0-9+\-().\s]*$/;

/** All the same digit, or seven consecutive ascending or descending digits. */
function isFiller(digits: string): boolean {
  if (/^(\d)\1+$/.test(digits)) return true;
  const up = "01234567890123456789";
  const down = "98765432109876543210";
  for (let i = 0; i + 7 <= digits.length; i++) {
    const run = digits.slice(i, i + 7);
    if (up.includes(run) || down.includes(run)) return true;
  }
  return false;
}

function colombian(national: string): PhoneCheck {
  const mobile = /^3[0-5]\d{8}$/.test(national);
  const landline = /^60[1-8]\d{7}$/.test(national);
  if (!mobile && !landline) return { ok: false, reason: "colombia" };
  // The operator or region prefix is legitimately repetitive (300, 333);
  // filler is judged on the seven subscriber digits.
  if (isFiller(national.slice(3))) return { ok: false, reason: "filler" };
  return {
    ok: true,
    e164: `+57${national}`,
    display: `+57 ${national.slice(0, 3)} ${national.slice(3, 6)} ${national.slice(6)}`,
  };
}

export function checkContactPhone(raw: string): PhoneCheck {
  const text = raw.trim();
  if (!text) return { ok: false, reason: "empty" };
  if (!ALLOWED.test(text)) return { ok: false, reason: "characters" };
  // A "+" anywhere but the front is a typo, not a format.
  if (text.indexOf("+") > 0 || (text.match(/\+/g) ?? []).length > 1) {
    return { ok: false, reason: "characters" };
  }
  const digits = text.replace(/\D/g, "");
  const plus = text.startsWith("+");

  if (plus || digits.startsWith("00")) {
    const intl = plus ? digits : digits.slice(2);
    if (intl.startsWith("57")) return colombian(intl.slice(2));
    // E.164: country code plus subscriber, 8 to 15 digits in all, no leading 0.
    if (!/^[1-9]\d{7,14}$/.test(intl)) return { ok: false, reason: "international" };
    if (isFiller(intl.slice(-7))) return { ok: false, reason: "filler" };
    return { ok: true, e164: `+${intl}`, display: `+${intl}` };
  }
  if (digits.length === 12 && digits.startsWith("57")) return colombian(digits.slice(2));
  return colombian(digits);
}

/** The sentence under the field, in the form's own voice. */
export function phoneProblem(reason: Exclude<PhoneCheck, { ok: true }>["reason"]): string {
  switch (reason) {
    case "empty":
      return "Escriba un número de teléfono donde podamos contactarlo.";
    case "characters":
      return "Escriba solo números. Puede usar espacios y el + del indicativo.";
    case "colombia":
      return "Revise el número: un celular tiene 10 dígitos y empieza por 3 (ejemplo: 310 482 7391); un fijo empieza por 60 y el indicativo de la ciudad (ejemplo: 601 742 3856).";
    case "international":
      return "Revise el número internacional: escriba + y el indicativo del país (ejemplo: +1 305 482 7391).";
    case "filler":
      return "Ese número no parece real. Escriba un teléfono donde podamos contactarlo.";
  }
}
