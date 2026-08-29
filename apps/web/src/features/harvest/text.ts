/**
 * What the harvest module says out loud.
 *
 * The server sends `rule: "digit"` and `reference: 9.4`. What a farm reads is
 * written here, because the wording is a product decision and not a query —
 * and because a rule name on screen is a code the reader has to look up.
 *
 * Kept as pure functions rather than JSX so the sentences can be pinned by a
 * test. A sentence that names a worker and calls their weighing suspect is
 * worth a test.
 *
 * THE RULE FOR EVERY STRING HERE: say the reason, with the number, in one
 * sentence a person can check. And leave room for the innocent explanation —
 * four of the five findings have one that is likelier than the guilty one (a
 * scale read twice, a key pressed twice, a phone with the wrong date, a crew's
 * sack booked to one person), so the wording says "revise" and "puede ser",
 * never "es". This screen is read by the person who decides what somebody gets
 * paid.
 */
import { formatQuantity } from "../../lib/money";
import { formatDate } from "../../lib/dates";
import type { WireAnomaly, WirePerformanceReason } from "../../api/wire";

const kg = (n: number) => `${formatQuantity(n)} kg`;

/** A short label for a chip. Never shown without the sentence beside it. */
export function anomalyHeadline(a: WireAnomaly): string {
  switch (a.rule) {
    case "impossible":
      return a.quantity <= 0 ? "Peso en cero" : "Peso imposible";
    case "duplicate":
      return "Posible doble registro";
    case "digit":
      return "¿Un cero de más?";
    case "outlier":
      return "Muy por encima del lote";
    case "future":
      return "Fecha futura";
  }
}

/**
 * The whole reason, in one sentence, with the numbers in it.
 *
 * `reference` is nullable and is null for `future`, where there is nothing to
 * compare against — the contract is explicit that a 0 there would read as
 * "compared against nothing". So every branch that uses it checks it, and none
 * of them prints a bare 0.
 */
export function anomalyReason(a: WireAnomaly): string {
  const who = a.worker;
  const where = a.crop ?? "el lote";
  const amount = kg(a.quantity);
  const ref = a.reference;

  switch (a.rule) {
    case "impossible":
      if (a.quantity <= 0) {
        return `La pesada quedó registrada en ${amount}. Una recolección sin peso no se puede liquidar; revise si falta el dato o si sobra el registro.`;
      }
      return ref === null
        ? `${amount} en un día es más de lo que una persona alcanza a recoger. Puede ser una pesada de la cuadrilla anotada a nombre de ${who}.`
        : `${amount} en un día es más de lo que una persona alcanza a recoger — el tope que usamos son ${kg(ref)}. Puede ser una pesada de la cuadrilla anotada a nombre de ${who}.`;

    case "duplicate":
      return `${who} tiene dos pesadas idénticas de ${amount} en ${where}, guardadas con menos de tres minutos de diferencia. Suele ser el mismo peso guardado dos veces.`;

    case "digit":
      return ref === null
        ? `${amount} es muy superior a lo que ${who} pesa normalmente. Revise si se coló un cero de más.`
        : `${amount} es más de cuatro veces lo que ${who} pesa normalmente (unos ${kg(ref)}). Revise si se coló un cero de más.`;

    case "outlier":
      return ref === null
        ? `${amount} está muy por encima de lo que hizo el resto de la cuadrilla en ${where} ese día. Puede ser un error de la báscula o una pesada de varios anotada a una sola persona.`
        : `${amount} está muy por encima de lo que hizo el resto de la cuadrilla en ${where} ese día (unos ${kg(ref)} cada uno). Puede ser un error de la báscula o una pesada de varios anotada a una sola persona.`;

    case "future":
      return `Esta pesada está fechada el ${formatDate(a.date)}, que todavía no ha llegado. Casi siempre es la fecha del teléfono o un error al escribirla.`;
  }
}

/** Why somebody has no index, said as a limit of the data, not of them. */
export function noIndexReason(reason: WirePerformanceReason | undefined, minDays: number): string {
  if (reason === "no_records_in_kilos") {
    return (
      "Sus pesadas están en una unidad que no convierte a kilos, así que no hay " +
      "una cantidad común con la que compararlas. No es que hayan rendido poco."
    );
  }
  return (
    `Hacen falta al menos ${minDays} días en los que esta persona coincidiera con ` +
    `otras en el mismo lote. Sin eso no hay con quién comparar — no es que hayan ` +
    `rendido poco.`
  );
}

export const NO_INDEX_SECTION_BODY =
  "El índice necesita que varias personas hayan trabajado el mismo lote el mismo " +
  "día. Quien no coincidió lo suficiente no aparece arriba, y eso no dice nada " +
  "sobre su trabajo.";

/**
 * What the index means, in the farm's words.
 *
 * Not a tooltip, on purpose. The number it explains is the one that decides
 * who gets called back next season.
 */
export const INDEX_EXPLAINER =
  "El índice compara a cada persona contra quienes recogieron en el mismo lote " +
  "el mismo día, y a esa persona nunca se la cuenta dentro de su propia " +
  "referencia. Así, quien recoge en un lote más cargado no sale mejor por eso. " +
  "1,00 es rendir igual que sus compañeros ese día.";

/** And what it does not mean. Kept beside it, always. */
export const INDEX_CAVEAT =
  "No mide esfuerzo ni horas: mide cuánto salió de los mismos árboles el mismo " +
  "día. Un café más maduro, una mata mejor cargada o media jornada por lluvia " +
  "mueven el número sin que la persona haya cambiado en nada.";

/** When the season is too young to read. */
export const NOT_ENOUGH_SEASON =
  "Todavía no hay semanas terminadas suficientes para decir si la cosecha va " +
  "subiendo o bajando. Hará falta al menos una semana cerrada más.";

/**
 * The unattributed column, explained where it appears.
 *
 * The contract is explicit that hiding it would break the grid's arithmetic —
 * and a table that does not cross-foot reads as OUR bug, not as a property of
 * the data. So it is always shown, and always with its cause.
 */
export function unattributedReason(noCropLink: number, shared: number): string {
  const parts: string[] = [];
  if (noCropLink > 0) {
    parts.push(
      `${noCropLink} ${noCropLink === 1 ? "pesada no dice" : "pesadas no dicen"} en qué cultivo se recogió`,
    );
  }
  if (shared > 0) {
    parts.push(
      `${shared} ${shared === 1 ? "nombra" : "nombran"} más de uno, y repartirlas sería adivinar`,
    );
  }
  return (
    `${parts.join("; ")}. Van en su propia columna para que los totales cuadren ` +
    `exactos: partirlas o contarlas dos veces sería peor que dejarlas aparte.`
  );
}
