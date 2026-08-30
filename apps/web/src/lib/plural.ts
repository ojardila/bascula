/**
 * PLURALES DE PERSONA, NO DE MÁQUINA.
 *
 * «1 venta(s) sin anular». «16 Bulto». Un paréntesis con una ese dentro es la
 * forma que tiene un programa de decirle a quien lo lee que no valía la pena
 * escribirle una frase, y de un producto que se toma el trabajo de distinguir
 * «no es cero, es que no sé» chirría especialmente.
 *
 * Dos funciones y nada más, porque el español no necesita una biblioteca para
 * esto: los sustantivos van a mano —son doce en toda la consola— y las
 * unidades siguen una regla que se puede escribir.
 */

/** «1 venta» · «3 ventas». El nombre en plural se da a mano. */
export function count(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

/** Sólo la palabra, sin el número. */
export function plural(n: number, one: string, many: string): string {
  return n === 1 ? one : many;
}

/**
 * SÍMBOLOS QUE NO SE PLURALIZAN.
 *
 * «kg» son kilogramos en singular y en plural: un símbolo de unidad no lleva
 * ese, y «16 kgs» delata a quien lo escribió. Los nombres —bulto, arroba,
 * canasta— sí, porque son sustantivos comunes.
 */
const SYMBOLS = new Set(["kg", "g", "mg", "t", "l", "ml", "cc", "m", "cm", "km", "m2", "ha", "@"]);

/**
 * La unidad como la diría un caficultor: en minúscula y concordando con el
 * número. «16 Bulto» -> «16 bultos»; «1 arroba» se queda; «38,5 kg» también.
 *
 * La regla del plural es la del español y llega hasta donde llega: vocal
 * final, ese; consonante, «es». Cubre las unidades del catálogo —bulto,
 * arroba, canasta, caja, lata, saco, costal— y falla, como falla el español,
 * con las palabras raras. Cuando el catálogo de la finca traiga una de ésas, la
 * unidad es un dato de la finca y no de este fichero.
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
