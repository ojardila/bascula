/**
 * ── UNA SOLA RESPUESTA A «¿CUÁNTO LE DEBO?» ──────────────────────────────
 *
 * Tres pantallas daban tres cifras para la misma persona y el mismo día:
 *
 *   el perfil          $184.500 en el tipo más grande — sólo el libro; lo
 *                      pendiente de liquidar iba en letra chica más abajo
 *   la lista           «—» en cada fila y «Total a favor: $0», porque
 *                      `/v1/workers` nunca ha enviado un `balanceCents`
 *   el tablero         $334.500 — la suma de los libros, sin lo pendiente
 *   la pantalla de pagar   $338.100 — la única correcta, y sólo visible para
 *                      quien ya decidió pagar
 *
 * Para quien no programa, eso no es un bug: es el programa mintiendo. Y
 * después de eso no le cree a ninguna cifra. Así que la respuesta se calcula
 * en un solo sitio —éste— y todas las pantallas la muestran igual, con el
 * desglose debajo en pequeño.
 *
 * ── QUÉ ES «LO QUE SE LE DEBE» ───────────────────────────────────────────
 *
 *   saldo del libro    devengos menos pagos. Lo que ya está escrito.
 *   + pendiente        trabajo hecho que todavía no se ha liquidado. No es un
 *                      devengo todavía, pero la finca lo debe igual: el
 *                      caficultor que pregunta «cuánto le debo a Rosa» está
 *                      preguntando por la plata que va a entregar, no por el
 *                      estado documental de esa plata.
 *
 * Y esa suma es exactamente lo que la pantalla de pagar escribe:
 * `toPayCents = balance.balanceCents + selectedCents`, que es también el
 * `totalCents` que manda `/v1/workers/{id}/payables`. No hay una cuarta
 * definición aquí; hay una sola, con nombre.
 *
 * ── NINGÚN CERO QUE SIGNIFIQUE «NO SÉ» ───────────────────────────────────
 *
 * Es la regla que ya gobierna `harvest/totals.ts`, y por eso este fichero se
 * le parece tanto: `OwedState` no tiene miembro numérico en el caso
 * `unknown`, así que una pantalla no puede imprimir por descuido un cero que
 * significa «no pude preguntar». Un cero es una afirmación —«está a paz y
 * salvo»— y es justo la que no se puede hacer por accidente.
 *
 * El caso `partial` merece su propia explicación: lo pendiente nunca es
 * negativo, así que cuando el libro se leyó y lo pendiente no, el saldo es un
 * PISO válido. Decir «al menos $184.500» informa más que un guion, y no
 * miente.
 */
import type { Uuid } from "../../api/types";

/** Lo que la finca sabe hoy de la cuenta de una persona. */
export interface Owed {
  /**
   * El libro: devengos menos pagos, tal como lo deriva el servidor. Positivo
   * es la finca debiendo; negativo es un anticipo que la persona carga.
   * `null` es «no se pudo leer», nunca cero.
   */
  balanceCents: number | null;
  /**
   * Trabajo hecho que todavía no se ha liquidado. Siempre >= 0. `null` es «no
   * se pudo leer».
   */
  pendingCents: number | null;
  /**
   * Parte de lo pendiente se paga al precio de la semana, que todavía se
   * puede mover. La cifra se muestra igual —esconderla sería peor— pero
   * marcada.
   */
  pendingIsEstimate: boolean;
}

export const NOTHING_KNOWN: Owed = {
  balanceCents: null,
  pendingCents: null,
  pendingIsEstimate: false,
};

/**
 * La cifra, con la procedencia que la finca merece.
 *
 * Deliberadamente sin número en `unknown`: no hay nada que renderizar por
 * error.
 */
export type OwedState =
  | { kind: "unknown"; reason: string }
  | { kind: "partial"; cents: number; reason: string; isEstimate: boolean }
  | { kind: "known"; cents: number; isEstimate: boolean };

export function owedState(o: Owed): OwedState {
  if (o.balanceCents === null) {
    return {
      kind: "unknown",
      reason:
        o.pendingCents === null
          ? "No se pudo consultar ni el saldo ni lo pendiente de liquidar. No es cero."
          : "No se pudo consultar el saldo del libro, así que no se puede decir el total. No es cero.",
    };
  }
  if (o.pendingCents === null) {
    return {
      kind: "partial",
      cents: o.balanceCents,
      reason:
        "No se pudo consultar lo pendiente de liquidar, y eso sólo suma. " +
        "La cifra es un mínimo, no el total.",
      isEstimate: false,
    };
  }
  return {
    kind: "known",
    cents: o.balanceCents + o.pendingCents,
    isEstimate: o.pendingIsEstimate && o.pendingCents !== 0,
  };
}

/** El total cuando se puede afirmar, y `null` cuando no. Para sumar filas. */
export function totalOwedCents(o: Owed): number | null {
  const s = owedState(o);
  return s.kind === "known" ? s.cents : null;
}

/**
 * Sumar personas.
 *
 * Propaga los huecos igual que `foldTotals`: si de una persona no se pudo leer
 * el libro, el total de la finca es desconocido para esa parte, y decirlo es
 * lo único honesto. `unreadable` cuenta a cuántas les pasó, para que la
 * pantalla pueda escribir «de N personas» en vez de un asterisco.
 */
export interface OwedSum {
  /** Lo que sí se pudo afirmar entero. Null si de alguien faltó una mitad. */
  cents: number | null;
  /**
   * El PISO: lo mismo, contando también a quienes sólo se les pudo leer el
   * libro. Sirve para decir «al menos $X» en vez de un guion cuando lo que
   * falló fue lo pendiente, que sólo puede sumar. Null cuando no se pudo leer
   * absolutamente nada.
   */
  floorCents: number | null;
  /** Cuántas personas entraron enteras en `cents`. */
  counted: number;
  /** Cuántas quedaron fuera porque su cuenta no se pudo leer entera. */
  unreadable: number;
  isEstimate: boolean;
}

export function sumOwed(rows: Owed[]): OwedSum {
  let cents: number | null = null;
  let floorCents: number | null = null;
  let counted = 0;
  let unreadable = 0;
  let isEstimate = false;
  for (const r of rows) {
    const s = owedState(r);
    if (s.kind === "unknown") {
      unreadable += 1;
      continue;
    }
    if (s.kind === "partial") {
      unreadable += 1;
      floorCents = (floorCents ?? 0) + s.cents;
      continue;
    }
    cents = (cents ?? 0) + s.cents;
    floorCents = (floorCents ?? 0) + s.cents;
    counted += 1;
    if (s.isEstimate) isEstimate = true;
  }
  // Una sola cuenta a medias vuelve incierto el total de la finca, aunque las
  // demás se hayan leído: el piso sigue siendo útil y el total ya no lo es.
  if (unreadable > 0) cents = null;
  return { cents, floorCents, counted, unreadable, isEstimate };
}

/**
 * Sólo lo que la finca debe hacia afuera.
 *
 * Un anticipo deja a alguien con saldo negativo, y restarlo de lo que la finca
 * les debe a los demás daría una cifra que no es la plata que hay que contar
 * el sábado. Por eso los negativos entran como cero en el total de la finca —
 * y NO se ocultan: la fila de esa persona sigue diciendo lo suyo.
 */
export function sumOwedToFarmWorkers(rows: Owed[]): OwedSum {
  return sumOwed(
    rows.map((r) => {
      const s = owedState(r);
      if (s.kind !== "known" || s.cents >= 0) return r;
      return { balanceCents: 0, pendingCents: 0, pendingIsEstimate: false };
    }),
  );
}

/* ------------------------------------------------------------------ */
/* Armar el mapa de la finca a partir de lo que ya se sabe leer        */
/* ------------------------------------------------------------------ */

/** Lo mínimo que hace falta de una labor para saber si está pendiente. */
export interface PendingRecordLike {
  workerId: Uuid;
  settled: boolean;
  estimatedAmountCents: number;
  amountIsEstimate: boolean;
}

/** Lo mínimo que hace falta de un saldo. */
export interface BalanceLike {
  workerId: Uuid;
  balanceCents: number;
}

/**
 * La cuenta de cada persona, de dos lecturas que las pantallas de lista ya
 * podían hacer: `/v1/balances` (una) y `/v1/work-records` (una).
 *
 * NO es un abanico de `/v1/workers/{id}/payables` por cabeza. Ese abanico es
 * lo correcto en la nómina —donde la cifra se va a FIRMAR y tiene que salir de
 * la misma consulta que corre la liquidación— y sería treinta peticiones cada
 * vez que alguien abre la lista de empleados. Aquí la cifra se lee, no se
 * firma, y `estimatedAmountCents` es el mismo número que `payables` suma: el
 * servidor lo calcula con la misma regla en las dos rutas.
 *
 * `balances` o `records` en `null` significa que esa lectura falló, y entonces
 * la mitad correspondiente de cada cuenta queda en `null` — no en cero.
 */
export function owedByWorker(
  balances: BalanceLike[] | null,
  records: PendingRecordLike[] | null,
): Map<Uuid, Owed> {
  const out = new Map<Uuid, Owed>();

  const get = (id: Uuid): Owed => {
    let o = out.get(id);
    if (!o) {
      o = {
        balanceCents: balances ? 0 : null,
        pendingCents: records ? 0 : null,
        pendingIsEstimate: false,
      };
      out.set(id, o);
    }
    return o;
  };

  for (const b of balances ?? []) {
    get(b.workerId).balanceCents = b.balanceCents;
  }
  for (const r of records ?? []) {
    if (r.settled) continue;
    const o = get(r.workerId);
    o.pendingCents = (o.pendingCents ?? 0) + r.estimatedAmountCents;
    if (r.amountIsEstimate) o.pendingIsEstimate = true;
  }
  return out;
}

/** La cuenta de una persona que no aparece en ninguna de las dos lecturas. */
export function owedOf(
  map: Map<Uuid, Owed>,
  workerId: Uuid,
  balancesRead: boolean,
  recordsRead: boolean,
): Owed {
  return (
    map.get(workerId) ?? {
      // Sin fila en `/v1/balances` y con la lectura buena, el libro de esa
      // persona está en cero de verdad: no tiene un solo movimiento. Lo mismo
      // con las labores. Éste es el único cero que este fichero afirma.
      balanceCents: balancesRead ? 0 : null,
      pendingCents: recordsRead ? 0 : null,
      pendingIsEstimate: false,
    }
  );
}
