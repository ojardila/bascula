/**
 * ── THE VOCABULARY ───────────────────────────────────────────────────────
 *
 * One term, one place where it is decided.
 *
 * This file exists because "parcela" was hand-written in thirty-seven places
 * and "lote" —the same piece of land— in about as many, including the first
 * field of the form that creates one. The product contradicted itself, and
 * fixing that was a manhunt. Now it is one line.
 *
 * WHAT BELONGS HERE. The words that name a THING of the trade and that show up
 * on more than one screen: the land, the person, the way someone is paid, the
 * state of a figure, the entry kinds of the ledger. Sentences do not belong:
 * a sentence is written where it is read, and `features/harvest/text.ts` is
 * already the place for the harvest sentences.
 *
 * THE RULE THAT OUTRANKS THE REST. **An old receipt and a new one have to read
 * as the same document.** What gets printed —payment receipt, settlement,
 * payroll sheet, in `features/documents/documents.ts`— changes with far more
 * care than what is only seen on screen: the question is not "is this the best
 * word?" but "is it worth it that two receipts from the same year don't look
 * alike?". Every constant here says whether it goes on paper and what was
 * decided.
 *
 * WHAT NOBODY TOUCHES, because someone who knows the trade chose it: liquidar,
 * jornal, cuadrilla, planilla, pesada, anticipo, bruto, bodega, lata, saldo a
 * favor. They are right.
 *
 * And there is a test —`vocab.test.ts`— that reads the source and fails if
 * anyone hand-writes one of the words this file retired.
 */
import type { LedgerKind, PayMode, TimeUnit } from "../api/types";

/* ------------------------------------------------------------------ */
/* 1. THE LAND — "lote", never "parcela"                               */
/* ------------------------------------------------------------------ */

/**
 * The phone says "lote" on every one of its screens and on its printed
 * receipt, and does not know the word "parcela": `grep -i parcela
 * apps/mobile/src` returns nothing. The console said "Parcelas" in the menu
 * and "Nombre del lote" in the first field of the form that creates them.
 *
 * IT DOES NOT GO ON PAPER. None of the three documents names the land in any
 * header, column or signature line, so this change costs the archive nothing:
 * a receipt from 2026 and one from 2027 stay identical. That is why it is
 * first on the list.
 *
 * The identifier in the code is still `plot` —it is the server's word
 * (`/v1/plots`, `plots.read`) and changing it would be another sprint and no
 * improvement at all for whoever uses this.
 */
export const PLOT = {
  one: "lote",
  many: "lotes",
  One: "Lote",
  Many: "Lotes",
  /** The route. `/parcelas` redirects here so saved links keep working. */
  path: "/lotes",
} as const;

/* ------------------------------------------------------------------ */
/* 2. THE PERSON — "empleado" in the console                           */
/* ------------------------------------------------------------------ */

/**
 * THE CONSOLE SAYS "EMPLEADO"; THE PHONE SAYS "RECOLECTOR". Both of them
 * print it: the paper here signs "Firma del empleado" and the phone's signs
 * "Firma del recolector".
 *
 * **empleado** wins, for two reasons and in that order:
 *
 *   1. It is already printed on all three of the console's documents —the
 *      signature line of the receipt and of the settlement, and the "Empleado"
 *      column of the payroll sheet. Changing it makes two receipts from the
 *      same year not look alike, which is exactly what the rule forbids.
 *   2. It is the only one of the two that is true. The console administers
 *      brushcutter operators, day labourers and foremen who do not pick coffee
 *      a single day of the year, and calling a brushcutter operator a
 *      "recolector" on his own receipt is an error of fact. The phone only
 *      ever sees weigh-ins, so there "recolector" is the right word and it
 *      stays.
 *
 * And "recolector" also stays in the console wherever it genuinely means
 * *whoever picked* —the columns and counts of the Harvest module— because
 * there it names a role in that week, not the person's record. See `PICKER`.
 */
export const EMPLOYEE = {
  one: "empleado",
  many: "empleados",
  One: "Empleado",
  Many: "Empleados",
  path: "/empleados",
} as const;

/**
 * Whoever picked. NOT a synonym for employee: it is what they did that week.
 *
 * Used only in Harvest, where a table row is "kilos this person picked" and
 * calling it "empleado" would lose exactly what the table measures.
 */
export const PICKER = {
  one: "recolector",
  many: "recolectores",
  One: "Recolector",
  Many: "Recolectores",
} as const;

/* ------------------------------------------------------------------ */
/* 3. HOW PEOPLE GET PAID                                              */
/* ------------------------------------------------------------------ */

/**
 * The two buttons that decide how a person is paid were called "Unidad de
 * trabajo" and "Unidad de tiempo", which are database column names. Nobody on
 * a farm says "this activity is paid by unit of work": they say **a destajo**,
 * **por kilo**, **al jornal**, **por contrato**.
 *
 * *Destajo* is the word coffee picking is paid by in Colombia, and it did not
 * appear once in the product.
 *
 * IT DOES NOT GO ON PAPER: the documents print the activity's name and its
 * unit ("kg"), never the pay mode. A free change for the archive.
 */
export const PAY_MODE_LABEL: Record<PayMode, string> = {
  work_unit: "A destajo",
  time_unit: "Al jornal",
  contract: "Por contrato",
};

/** The same, with the example attached, for the button that has to land. */
export const PAY_MODE_CHOICE: Record<PayMode, string> = {
  work_unit: "A destajo · por kilo",
  time_unit: "Al jornal · por día",
  contract: "Por contrato",
};

/** A sentence, for where it has to be explained inside running text. */
export const PAY_MODE_SENTENCE: Record<PayMode, string> = {
  work_unit: "se paga a destajo: por lo que la persona haga",
  time_unit: "se paga al jornal: por el tiempo que la persona esté",
  contract: "se paga por contrato: un total acordado de antemano",
};

/** "jornales", "semanas"… what gets counted when the pay is by time. */
export const TIME_UNIT_LABEL: Record<TimeUnit, string> = {
  jornal: "Jornal (día)",
  semanal: "Semanal",
  quincenal: "Quincenal",
  mensual: "Mensual",
  custom: "Otra",
};

/* ------------------------------------------------------------------ */
/* 4. THE FIGURE THAT CAN STILL MOVE — "provisional"                   */
/* ------------------------------------------------------------------ */

/**
 * One single state had three names, one per screen: **provisional** on the
 * paper, **estimado** on the dashboard and in the profiles, and **precio de la
 * semana** in Activities and in a settlement's detail. They are the same
 * thing: the money is not settled yet because that week's price per kilo has
 * not been fixed.
 *
 * "PROVISIONAL" WINS, AND IT WINS BECAUSE IT IS ALREADY ON THE PAPER: the
 * amber block of a receipt says PROVISIONAL in large type and
 * `docs/sincronizacion.md` asks for it that way. Choosing any of the others
 * would have forced a change to all three documents. It is also the word the
 * phone already uses for its unconfirmed balance (`pay.provisional`), so both
 * halves of the product end up saying the same thing without touching a
 * printed line.
 *
 * "El precio de la semana" still exists — but as the name of the PRICE, which
 * is a real thing the owner fixes on Mondays, not as the name of the state of
 * a figure.
 */
export const PROVISIONAL = "provisional";

/** The note that rides along with a figure that can still move. */
export const PROVISIONAL_NOTE = "provisional · al precio de la semana";

/** The same inside a sentence: "… incluye provisional al precio de la semana". */
export const PROVISIONAL_INCLUDES = "incluye provisional, al precio de la semana";

/** Why it can move. Goes in a tooltip or a footnote, never on its own. */
export const PROVISIONAL_WHY =
  "Provisional quiere decir que el precio del kilo de esa semana todavía no está " +
  "fijado. Al fijarlo, la cifra se congela y deja de moverse.";

/* ------------------------------------------------------------------ */
/* 5. THE LEDGER — no accountancy, no programming, on screen           */
/* ------------------------------------------------------------------ */

/**
 * `devengo` and `reverso` are the names of two ledger `kind`s. The first is
 * accountancy, the second is programming, and nobody on a farm says either. On
 * screen they become **ganado** and **corrección** — "what was earned" and
 * "it was corrected", turned into nouns so the "Tipo" column does not mix
 * sentences with nouns.
 *
 * `deduccion` becomes **descuento**, which is how the phone says it and how
 * the farm says it.
 *
 * THE PAPER DOES NOT CHANGE, AND THAT IS A DECISION, NOT AN OVERSIGHT.
 * `devengo` and `reverso` are printed in exactly one place: the red block of a
 * VOIDED settlement, whose entire job is to be reconciled against the ledger
 * three weeks later. There the ledger's words are the right ones, and a voided
 * settlement from 2026 and one from 2027 have to be the same document. What
 * was done instead was to tie the two halves together: the screen that voids
 * says, in the same sentence, that the ledger and the paper call this a
 * "reverso", so whoever is holding the paper can find the word. Not one
 * header, column, total or signature line moved.
 */
export const LEDGER_KIND_LABEL: Record<LedgerKind, string> = {
  devengo: "ganado",
  pago: "pago",
  anticipo: "anticipo",
  deduccion: "descuento",
  ajuste: "ajuste",
  reverso: "corrección",
};

/** The entry that undoes another, said in full and with its paper name beside it. */
export const CORRECTION_GLOSS =
  "una corrección: un asiento contrario que deshace el anterior y deja ver qué " +
  "pasó y cuándo. En el libro y en el papel se llama «reverso».";

/**
 * What was earned and is already written down, against what was earned and is
 * not yet.
 *
 * The sentence that replaces "todavía no es un devengo". It says the same
 * thing without asking the reader to know accountancy.
 */
export const NOT_YET_EARNED =
  "trabajo hecho que todavía no está liquidado, así que aún no aparece en el saldo";

/* ------------------------------------------------------------------ */
/* 6. THE STORE — things in and things out, not a bank statement       */
/* ------------------------------------------------------------------ */

/**
 * "Movimientos" is a bank-statement word. In a store what happens is **things
 * coming in and going out**, and that is how it is said.
 *
 * IT DOES NOT GO ON PAPER: no printed document mentions the store.
 *
 * "Saldo a favor" —which does sound like a bank— stays: it is a farm word,
 * the phone prints it on its receipt, and it means exactly what it says.
 */
export const STOCK_MOVE = {
  one: "entrada o salida",
  many: "entradas y salidas",
  One: "Entrada o salida",
  Many: "Entradas y salidas",
  /** For sentences: "la suma de las entradas y salidas". */
  ofThem: "las entradas y salidas",
} as const;

/* ------------------------------------------------------------------ */
/* 7. WHAT WAS SETTLED — "bruto" stays, "(vigentes)" does not          */
/* ------------------------------------------------------------------ */

/**
 * "Bruto liquidado" is printed on the settlement and on the payroll sheet, and
 * "bruto" is a farm word. It stays exactly as it is.
 *
 * What was nobody's word was the parenthesis: "(vigentes)" is a database row
 * state. What it means is that voided settlements are not counted, and that
 * can simply be said.
 */
export const GROSS_SETTLED = "Bruto liquidado";
export const GROSS_SETTLED_LIVE = "Bruto liquidado (sin las anuladas)";
export const GROSS_SETTLED_LIVE_FILTERED = "Bruto liquidado (sin las anuladas, filtrado)";
