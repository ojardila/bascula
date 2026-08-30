/**
 * PLURALS WRITTEN BY A PERSON, NOT BY A MACHINE.
 *
 * "1 venta(s) sin anular". "16 Bulto". A parenthesis with an s inside it is
 * how a program tells whoever is reading that writing them a sentence was not
 * worth the trouble, and coming from a product that goes out of its way to
 * distinguish "this is not zero, this is I don't know", it grates especially.
 *
 * Two functions and nothing more, because Spanish does not need a library for
 * this: the nouns are done by hand —there are twelve in the whole console—
 * and the units follow a rule you can write down.
 */

/** "1 venta" · "3 ventas". The plural noun is supplied by hand. */
export function count(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

/** Just the word, without the number. */
export function plural(n: number, one: string, many: string): string {
  return n === 1 ? one : many;
}

/**
 * SYMBOLS THAT DO NOT TAKE A PLURAL.
 *
 * "kg" is kilograms in the singular and in the plural: a unit symbol takes no
 * s, and "16 kgs" gives away whoever wrote it. The names —bulto, arroba,
 * canasta— do take one, because they are ordinary nouns.
 */
const SYMBOLS = new Set(["kg", "g", "mg", "t", "l", "ml", "cc", "m", "cm", "km", "m2", "ha", "@"]);

/**
 * The unit as a coffee farmer would say it: lower case and agreeing with the
 * number. "16 Bulto" -> "16 bultos"; "1 arroba" stays; so does "38,5 kg".
 *
 * The plural rule is the Spanish one and it reaches as far as it reaches:
 * final vowel, add s; consonant, add "es". It covers the catalogue's units
 * —bulto, arroba, canasta, caja, lata, saco, costal— and it fails, the way
 * Spanish itself fails, on the odd words. When the farm's catalogue brings one
 * of those, the unit is the farm's data and not this file's.
 */
export function unitLabel(n: number, unit: string | null | undefined): string {
  if (!unit) return "";
  const u = unit.trim();
  if (u === "") return "";
  const lower = u.toLocaleLowerCase("es");
  if (SYMBOLS.has(lower)) return lower;
  if (n === 1 || n === -1) return lower;
  if (/[aeiouáéíóú]$/.test(lower)) return `${lower}s`;
  if (/z$/.test(lower)) return `${lower.slice(0, -1)}ces`;
  return `${lower}es`;
}
