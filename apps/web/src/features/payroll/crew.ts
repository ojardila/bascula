/**
 * LA NÓMINA DE CUADRILLA, sin la pantalla.
 *
 * El sábado la finca no paga a una persona: paga a treinta, en fila, con la
 * plata contada encima de la mesa. El teléfono sabía hacerlo (`PaymentsPanel`
 * y `Payments.runPayroll`); la consola sólo sabía pagar de uno en uno
 * (`PayWorkerPage`). `docs/simplificacion.md` §2.1 lo dice sin rodeos: la
 * nómina de cuadrilla "se muda a la web — y en la web no existe todavía", y
 * hasta que exista no se le puede quitar al teléfono. Esto es la mitad
 * comprobable de esa mudanza; `CrewPayrollPage.tsx` es la otra.
 *
 * Está separado de la pantalla por un motivo concreto y no por gusto: lo que
 * hay aquí es dinero repartido entre N personas, y quiero poder probarlo sin
 * renderizar nada. Las cuatro decisiones que cuestan plata están todas en este
 * fichero.
 *
 * ── 1. DOS PASOS, NO UNO ─────────────────────────────────────────────────
 *
 * El teléfono liquida y paga en un solo acto porque el pesador está en el lote
 * con el efectivo en la mano y no hay un segundo momento. Quien usa la consola
 * está sentado en un computador, y ahí los dos actos son distintos:
 *
 *   LIQUIDAR   congela el trabajo de la semana al precio de la semana. Es el
 *              paso con carrera —el precio y las pesadas se mueven— y es el
 *              que necesita `expectedGrossCents`.
 *   PAGAR      entrega la plata contra un saldo que ya está escrito en el
 *              libro. Aquí no hay bruto que se mueva: sólo puede moverlo otro
 *              movimiento (un anticipo, una deducción, otro pago).
 *
 * Separarlos compra tres cosas que en un solo acto no se tienen:
 *
 *   a. **La planilla se imprime sobre cifras definitivas.** Después de
 *      liquidar no queda ni una línea `weekly_price` sin fijar, así que el
 *      papel que la gente firma no lleva ninguna cifra provisional. En un solo
 *      acto el papel sale del mismo botón que la escritura y nadie lo lee
 *      antes.
 *   b. **No todo el que cobró trabajó, ni todo el que trabajó aparece.** El
 *      sábado falta gente. Liquidar a los treinta y pagar a los veintiséis que
 *      llegaron es la operación real; en un solo acto habría que registrar el
 *      pago de cuatro personas que no han recibido nada.
 *   c. **El paso caro es reversible por separado.** Anular una liquidación
 *      suelta las labores; reversar un pago devuelve el saldo. Con los dos
 *      pegados, deshacer siempre deshace las dos cosas.
 *
 * Y el costo de separarlos —el estado a medias, "liquidado y sin pagar"— se
 * paga con una propiedad que hace falta de todos modos: **este módulo no
 * guarda ese estado, lo lee**. Un trabajador liquidado y sin pagar es
 * exactamente uno con saldo a favor y sin labores pendientes, y eso se deduce
 * del servidor en cada carga. No hay media nómina invisible; hay una lista que
 * el paso 2 vuelve a mostrar sola, aunque se cierre el navegador.
 *
 * ── 2. LA GUARDA DE LA CARRERA, PARA UN GRUPO ────────────────────────────
 *
 * Para una persona ya existe: `expectedGrossCents` + `payableIds`, y el
 * servidor devuelve 409 GROSS_CHANGED sin escribir nada (`api/grossChange.ts`).
 * Para treinta hay que decidir qué significa "no pagar a nadie".
 *
 * **La aprobación es de todo o nada; la escritura no puede serlo.** No existe
 * una transacción HTTP que abarque treinta liquidaciones, y fingir que sí la
 * hay sería peor que no tenerla. Así que:
 *
 *   ANTES de escribir   `checkSettleRun` vuelve a leer lo pendiente de TODOS
 *                       los aprobados y compara. Si a UNO le cambió el bruto,
 *                       no se escribe nada de nadie y la pantalla dice de
 *                       quién y qué se movió. Esto es la parte de todo o nada,
 *                       y es la que importa, porque es donde está el 99 % de
 *                       las carreras: minutos de alguien mirando la pantalla.
 *   DURANTE la escritura  `runSettlements` va persona a persona y **se detiene
 *                       en el primer rechazo**. El servidor sigue teniendo la
 *                       última palabra —cada llamada lleva su
 *                       `expectedGrossCents`— y si dice que no, el mundo se
 *                       movió en los milisegundos de la corrida: seguir
 *                       firmando cifras sería firmar a ciegas.
 *   DESPUÉS             queda un parte exacto: quién entró, quién no y por
 *                       qué, y un deshacer para lo que sí entró.
 *
 * Lo que NO bloquea, y hay que decirlo porque es la tentación: que a alguien
 * le entre una pesada nueva. La liquidación nombra los `payableIds` que se
 * aprobaron, así que una pesada que llegó después simplemente no está dentro y
 * queda pendiente para la próxima. Bloquear por eso sería gritar «cambió» cada
 * vez que el pesador registra algo un sábado por la tarde, que es justo cuando
 * más registra. Se avisa (`arrivals`) y no se bloquea.
 *
 * ── 3. NINGÚN CERO QUE SIGNIFIQUE «NO SÉ» ────────────────────────────────
 *
 * `CrewMember.payables` y `CrewMember.balance` son `null` cuando no se
 * pudieron leer, y ese null viaja hasta el render. Un empleado cuyo pendiente
 * no se pudo leer no se puede marcar: no se aprueba lo que no se ha visto.
 *
 * ── 4. EL DESHACER ───────────────────────────────────────────────────────
 *
 * `undoRun`, con el orden del teléfono y por su mismo motivo: primero se
 * reversan los pagos y después se anulan las liquidaciones, porque anular
 * escribe su propio reverso del devengo y al revés quedaría un pago en pie
 * contra un devengo que ya no existe.
 */
import { api, grossChangeOf } from "../../api/endpoints";
import { ApiError, messageFor } from "../../api/errors";
import {
  explainGrossChange,
  type GrossChange,
  type ServerGrossDetails,
} from "../../api/grossChange";
import type {
  Balance,
  DayISO,
  PayableLine,
  Payables,
  PayMethod,
  Uuid,
  Worker,
} from "../../api/types";
import type { MintId } from "../../lib/writeOnce";
import type { PayrollRow, PayrollScope } from "../documents/documents";

/* ------------------------------------------------------------------ */
/* La cuadrilla                                                        */
/* ------------------------------------------------------------------ */

/**
 * Un empleado con lo que la finca sabe de él hoy.
 *
 * `payables` y `balance` son nulos cuando la lectura falló, NUNCA cero. Un
 * cero aquí diría "no debe nada", que es una afirmación, y lo que ocurrió fue
 * que no se pudo preguntar.
 */
export interface CrewMember {
  worker: Worker;
  /** "Nombre Apellido", ya compuesto: la tabla y el papel lo piden igual. */
  name: string;
  payables: Payables | null;
  balance: Balance | null;
  /** Por qué no se pudo leer, cuando no se pudo. */
  failure: string | null;
}

const fullName = (w: Worker) => `${w.name} ${w.lastName}`.trim();

/**
 * La cuadrilla entera, en una lectura.
 *
 * Un `GET /v1/balances` para todos y un `GET /v1/workers/{id}/payables` por
 * cabeza. El abanico es deliberado y no hay ruta que lo evite: lo pendiente es
 * por trabajador y tiene que venir de la misma consulta que va a correr la
 * liquidación, o la pantalla y la escritura discreparían — que es exactamente
 * el fallo que `expectedGrossCents` existe para atrapar, y no tiene sentido
 * provocarlo aquí para ahorrar peticiones.
 *
 * Un fallo por trabajador NO tumba la pantalla: esa fila queda ilegible y las
 * demás siguen siendo pagables. Un fallo de `/v1/balances` deja todos los
 * saldos en null, y entonces el paso 2 no se puede aprobar — que es lo
 * correcto: no se entrega plata contra un saldo que no se pudo leer.
 */
export async function loadCrew(): Promise<CrewMember[]> {
  const [workers, balances] = await Promise.all([
    api.listWorkers(),
    api.listBalances().catch(() => null),
  ]);
  const byWorker = balances && new Map(balances.map((b) => [b.workerId, b]));

  const rows = await Promise.all(
    workers.map(async (worker): Promise<CrewMember> => {
      const balance = byWorker?.get(worker.id) ?? null;
      try {
        return {
          worker,
          name: fullName(worker),
          payables: await api.workerPayables(worker.id),
          balance,
          failure: null,
        };
      } catch (e) {
        return {
          worker,
          name: fullName(worker),
          payables: null,
          balance,
          failure: messageFor(e),
        };
      }
    }),
  );
  return rows.sort((a, b) => a.name.localeCompare(b.name, "es"));
}

/**
 * El saldo del libro, de las dos rutas que lo derivan.
 *
 * `/v1/balances` y `/v1/workers/{id}/payables` calculan el mismo `SUM` sobre
 * el mismo libro; tomar la segunda cuando la primera no llegó no es mezclar
 * dos números, es el mismo número por otra puerta. Null cuando no hay ninguna
 * de las dos, y entonces la fila no se puede aprobar.
 */
export function balanceCentsOf(m: CrewMember): number | null {
  if (m.balance) return m.balance.balanceCents;
  if (m.payables) return m.payables.balanceCents;
  return null;
}

/* ------------------------------------------------------------------ */
/* Paso 1 — liquidar                                                   */
/* ------------------------------------------------------------------ */

/** Lo que una persona aporta a la corrida, tal y como se leyó en pantalla. */
export interface SettleApproval {
  workerId: Uuid;
  name: string;
  documentNumber: string | null;
  /**
   * LA CIFRA DEL SERVIDOR (`payables.grossCents`), no una suma nuestra sobre
   * la tabla. Sumar aquí sería una segunda implementación del precio, y el día
   * que cambie una regla de redondeo las dos discreparían — y la que se
   * escribe es la del servidor.
   */
  grossCents: number;
  /** Kilos (o arrobas, o canastillas). Null cuando nada se pagó por peso. */
  quantity: number | null;
  /** La unidad de esos kilos, para el encabezado del papel. */
  unitLabel: string | null;
  payableIds: Uuid[];
  /** Las líneas que hacen esa cifra: sin ellas no se puede decir QUÉ cambió. */
  lines: PayableLine[];
}

/** Null cuando esta persona no tiene nada pendiente que liquidar. */
export function settleApprovalOf(m: CrewMember): SettleApproval | null {
  const lines = m.payables?.workRecords ?? [];
  if (!m.payables || lines.length === 0) return null;
  const weighed = lines.filter((l) => l.unitLabel !== null);
  return {
    workerId: m.worker.id,
    name: m.name,
    documentNumber: m.worker.documentNumber || null,
    grossCents: m.payables.grossCents,
    quantity: weighed.length ? weighed.reduce((a, l) => a + l.quantity, 0) : null,
    unitLabel: weighed[0]?.unitLabel ?? null,
    payableIds: lines.map((l) => l.id),
    lines,
  };
}

/** True cuando alguna línea sigue al precio de la semana: estimada, no firme. */
export const hasProvisional = (a: SettleApproval): boolean =>
  a.lines.some((l) => l.rateSource === "weekly_price");

/** Lo mismo que le pasa a una persona, con nombre encima. */
export interface CrewDrift extends GrossChange {
  workerId: Uuid;
  name: string;
}

/** Trabajo que llegó después de cargar la pantalla. No bloquea; se avisa. */
export interface Arrival {
  workerId: Uuid;
  name: string;
  lines: PayableLine[];
}

/** Alguien de quien no se pudo confirmar la cifra. Bloquea. */
export interface Unreadable {
  workerId: Uuid;
  name: string;
  reason: string;
}

export interface CrewCheck {
  /** Si trae uno solo, no se escribe nada de nadie. */
  drifts: CrewDrift[];
  /** Tampoco se escribe si hay alguno: no se aprueba lo que no se pudo leer. */
  unreadable: Unreadable[];
  /** Informativo. */
  arrivals: Arrival[];
}

export const checkPassed = (c: CrewCheck): boolean =>
  c.drifts.length === 0 && c.unreadable.length === 0;

/**
 * Volver a mirar lo de una persona y decir si se movió.
 *
 * Lo que se compara es LA CIFRA QUE SE VA A FIRMAR: la suma de los
 * `payableIds` aprobados, a como estén valorados ahora. Una pesada nueva no
 * entra en esa suma —la liquidación nombra su conjunto— y por eso no es
 * diferencia. Una pesada aprobada que desapareció sí, y un precio de semana
 * que se movió también.
 *
 * La explicación la arma `explainGrossChange`, el mismo código que traduce el
 * 409 del servidor en la pantalla de una persona. Aquí se le da de comer un
 * `ServerGrossDetails` construido en local, para que la frase que lee el
 * usuario sea literalmente la misma en los dos sitios y no dos redacciones que
 * se parecen.
 */
export function driftOf(a: SettleApproval, fresh: Payables): CrewDrift | null {
  const freshById = new Map(fresh.workRecords.map((l) => [l.id, l] as const));
  const approved = new Set(a.payableIds);
  const survivors = a.payableIds.filter((id) => freshById.has(id));
  const sameSet =
    survivors.length === a.payableIds.length &&
    fresh.workRecords.length === a.payableIds.length;

  // Si el conjunto es idéntico, la cifra que vale es la del servidor, no una
  // suma nuestra. Sólo cuando ya no lo es hay que recomponerla línea a línea.
  const actualCents = sameSet
    ? fresh.grossCents
    : survivors.reduce((s, id) => s + (freshById.get(id)?.amountCents ?? 0), 0);

  if (actualCents === a.grossCents && survivors.length === a.payableIds.length) return null;

  /**
   * El precio de cada semana, AHORA, leído de las líneas frescas. El servidor
   * manda esto en su 409; aquí se deduce de lo pendiente, que es la misma
   * fuente. `explainGrossChange` sólo reporta una semana cuando ese precio
   * difiere del que llevaban las líneas aprobadas — es una comparación, no una
   * lectura, y por eso una pesada tardía no se anuncia como un cambio de
   * precio.
   */
  const priceNow = new Map<DayISO, number>();
  for (const l of fresh.workRecords) {
    if (l.rateSource === "weekly_price") priceNow.set(l.weekStart, l.rateCents);
  }

  const details: ServerGrossDetails = {
    expectedCents: a.grossCents,
    actualCents,
    addedPayableIds: fresh.workRecords.filter((l) => !approved.has(l.id)).map((l) => l.id),
    removedPayableIds: a.payableIds.filter((id) => !freshById.has(id)),
    // Aquí SIEMPRE se sabe qué se aprobó: lo aprobó esta misma pantalla.
    payableIdsProvided: true,
    weeksInSettlement: [...priceNow].map(([weekStart, priceCents]) => ({
      weekStart,
      priceCents,
    })),
  };

  return {
    workerId: a.workerId,
    name: a.name,
    ...explainGrossChange(details, a.lines, fresh.workRecords),
  };
}

/**
 * La comprobación del grupo, justo antes de escribir. No escribe nada.
 *
 * Una lectura por persona, en paralelo. Es lo que cuesta poder decir «no se
 * pagó a nadie» y ser cierto.
 */
export async function checkSettleRun(approvals: SettleApproval[]): Promise<CrewCheck> {
  const out: CrewCheck = { drifts: [], unreadable: [], arrivals: [] };

  const fresh = await Promise.all(
    approvals.map(async (a) => {
      try {
        return { a, payables: await api.workerPayables(a.workerId), reason: null };
      } catch (e) {
        return { a, payables: null, reason: messageFor(e) };
      }
    }),
  );

  for (const { a, payables, reason } of fresh) {
    if (!payables) {
      out.unreadable.push({ workerId: a.workerId, name: a.name, reason: reason ?? "" });
      continue;
    }
    const drift = driftOf(a, payables);
    if (drift) out.drifts.push(drift);

    const approved = new Set(a.payableIds);
    const arrived = payables.workRecords.filter((l) => !approved.has(l.id));
    if (arrived.length > 0) {
      out.arrivals.push({ workerId: a.workerId, name: a.name, lines: arrived });
    }
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* Paso 2 — pagar                                                      */
/* ------------------------------------------------------------------ */

/**
 * Lo que se le entrega a una persona: el saldo que el libro dice que se le
 * debe, leído en pantalla y vuelto a comprobar antes de escribir.
 */
export interface PayApproval {
  workerId: Uuid;
  name: string;
  documentNumber: string | null;
  amountCents: number;
}

/** Null cuando no hay saldo a favor, o cuando no se pudo leer. */
export function payApprovalOf(m: CrewMember): PayApproval | null {
  const cents = balanceCentsOf(m);
  if (cents === null || cents <= 0) return null;
  return {
    workerId: m.worker.id,
    name: m.name,
    documentNumber: m.worker.documentNumber || null,
    amountCents: cents,
  };
}

export interface PayDrift {
  workerId: Uuid;
  name: string;
  beforeCents: number;
  afterCents: number;
  deltaCents: number;
}

export interface PayCheck {
  drifts: PayDrift[];
  unreadable: Unreadable[];
}

export const payCheckPassed = (c: PayCheck): boolean =>
  c.drifts.length === 0 && c.unreadable.length === 0;

/**
 * La misma guarda, aplicada al otro número.
 *
 * Después de liquidar no hay bruto que se mueva: lo que puede haber cambiado
 * es el saldo, y sólo por otro movimiento —un anticipo entregado en el lote,
 * una deducción, un pago hecho desde el teléfono—. Si el saldo de UNO no es el
 * que se aprobó, no se le paga a nadie: entregar $300.000 aprobados sobre un
 * saldo que ya bajó a $120.000 es exactamente el sobrepago que
 * `AMOUNT_EXCEEDS_BALANCE` atrapa de a uno, dicho antes y para todos.
 *
 * Un saldo que SUBIÓ tampoco pasa callando. Pagar de menos no pierde plata,
 * pero manda a la persona a casa con la cuenta abierta y sin que nadie se lo
 * haya dicho — y el que firma la planilla firma un número que ya no es el suyo.
 */
export async function checkPayRun(approvals: PayApproval[]): Promise<PayCheck> {
  const out: PayCheck = { drifts: [], unreadable: [] };
  let balances: Balance[] | null = null;
  try {
    balances = await api.listBalances();
  } catch {
    balances = null;
  }
  const byWorker = balances && new Map(balances.map((b) => [b.workerId, b]));

  for (const a of approvals) {
    const now = byWorker?.get(a.workerId);
    if (!now) {
      out.unreadable.push({
        workerId: a.workerId,
        name: a.name,
        reason: "No se pudo volver a leer su saldo.",
      });
      continue;
    }
    if (now.balanceCents !== a.amountCents) {
      out.drifts.push({
        workerId: a.workerId,
        name: a.name,
        beforeCents: a.amountCents,
        afterCents: now.balanceCents,
        deltaCents: now.balanceCents - a.amountCents,
      });
    }
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* La corrida                                                          */
/* ------------------------------------------------------------------ */

export type RunStatus = "done" | "refused" | "skipped";

/**
 * Una línea del parte. Sirve para los dos pasos porque el papel también es el
 * mismo: quién, cuántos kilos, cuánto, y una firma.
 */
export interface RunRow {
  workerId: Uuid;
  name: string;
  documentNumber: string | null;
  quantity: number | null;
  /** Sólo en el paso de liquidar. */
  grossCents: number | null;
  /** Sólo en el paso de pagar. */
  paidCents: number | null;
  /** Lo que el libro dice después del pago. Null cuando no se llegó a pagar. */
  balanceAfterCents: number | null;
  status: RunStatus;
  settlementId: Uuid | null;
  paymentId: Uuid | null;
  /** Por qué no entró, en castellano. Null cuando entró. */
  reason: string | null;
}

/** Lo que el filtro y las casillas dejaron fuera. Va a la pantalla Y al papel. */
export interface RunScope {
  /** Una frase por filtro activo, ya en castellano. */
  filters: string[];
  /** Cuánta gente había antes de filtrar y destildar. */
  crewSize: number;
  /** Cuánto sumaba esa cuadrilla entera. */
  crewTotalCents: number;
}

export interface PayrollRun {
  step: "settle" | "pay";
  rows: RunRow[];
  scope: RunScope;
  method: PayMethod | null;
  /** ISO. Sólo para ordenar y para el papel. */
  at: string;
  /** False cuando se detuvo a mitad: hay filas `refused` o `skipped`. */
  complete: boolean;
  unitLabel: string | null;
}

/**
 * La corrida se detuvo a mitad.
 *
 * Se lanza DENTRO de `useWriteOnce.run` a propósito. `run` retira los ids
 * cuando la función termina bien —la próxima nómina igual a esta es una nómina
 * nueva y no puede confundirse con un reintento—, pero una corrida a medias
 * necesita justo lo contrario: que los ids sobrevivan, para que «Reintentar»
 * vuelva a mandar los mismos y el servidor conteste con lo que ya escribió
 * (`ON CONFLICT (id) DO NOTHING`) en vez de escribirlo dos veces. Lanzar es la
 * única forma de decirle a `run` que esto no fue un final.
 */
export class RunIncomplete extends Error {
  constructor(readonly rows: RunRow[]) {
    super("La nómina no se completó");
    this.name = "RunIncomplete";
  }
}

const baseRow = (
  a: { workerId: Uuid; name: string; documentNumber: string | null },
  extra: Partial<RunRow>,
): RunRow => ({
  workerId: a.workerId,
  name: a.name,
  documentNumber: a.documentNumber,
  quantity: null,
  grossCents: null,
  paidCents: null,
  balanceAfterCents: null,
  status: "skipped",
  settlementId: null,
  paymentId: null,
  reason: null,
  ...extra,
});

/**
 * Por qué se rechazó, dicho para alguien que está de pie con plata en la mano.
 *
 * Los tres códigos que importan tienen nombre propio; el resto cae en el
 * mensaje general de `errors.ts`, que ya está traducido. Lo que no se hace
 * nunca es inventar una causa: `messageFor` de un fallo de red dice que fue la
 * red, y eso es lo que hay que leer.
 */
export function reasonOf(e: unknown): string {
  const change = grossChangeOf(e);
  if (change) {
    return "El bruto cambió justo al escribir: no se firmó la cifra aprobada.";
  }
  if (e instanceof ApiError) {
    if (e.code === "PAYABLE_ALREADY_CLAIMED") {
      return "Otra liquidación tomó esas labores primero.";
    }
    if (e.code === "NOTHING_TO_SETTLE") {
      return "Ya no quedaba nada pendiente que liquidar.";
    }
    if (e.code === "AMOUNT_EXCEEDS_BALANCE") {
      return "El saldo bajó y el pago aprobado ya no cabe.";
    }
  }
  return messageFor(e);
}

/**
 * Liquidar, persona a persona, deteniéndose en el primer rechazo.
 *
 * Secuencial y no en paralelo, y no es por cortesía con el servidor: en
 * paralelo no existe "el primero que falla", y treinta escrituras que salieron
 * a la vez no se pueden dejar de hacer. En serie hay un punto de parada en
 * cada iteración, y el parte puede decir la verdad: éstas entraron, ésta se
 * rechazó, éstas ni se intentaron.
 *
 * Cada `id` viene de `mint`, que es estable por intención: reintentar la misma
 * corrida reenvía los mismos ids y el servidor contesta con lo que ya escribió.
 */
export async function runSettlements(
  approvals: SettleApproval[],
  mint: MintId,
  note: string,
): Promise<RunRow[]> {
  const rows = approvals.map((a) =>
    baseRow(a, { quantity: a.quantity, grossCents: a.grossCents }),
  );

  for (let i = 0; i < approvals.length; i++) {
    const a = approvals[i];
    try {
      const s = await api.settle(a.workerId, a.payableIds, {
        expectedGrossCents: a.grossCents,
        expectedLines: a.lines,
        note,
        id: mint(`liquidacion:${a.workerId}`),
      });
      rows[i] = { ...rows[i], status: "done", settlementId: s.id, grossCents: s.grossCents };
    } catch (e) {
      rows[i] = { ...rows[i], status: "refused", reason: reasonOf(e) };
      return rows;
    }
  }
  return rows;
}

/**
 * Pagar, con la misma forma.
 *
 * `api.createPayment` sin `payableIds`: aquí no se liquida nada, se entrega
 * contra un saldo que el paso 1 ya escribió. Es lo que hace que este paso no
 * tenga carrera de bruto y que su única guarda sea la del saldo.
 */
export async function runPayments(
  approvals: PayApproval[],
  method: PayMethod,
  mint: MintId,
  note: string,
): Promise<RunRow[]> {
  const rows = approvals.map((a) => baseRow(a, { paidCents: a.amountCents }));

  for (let i = 0; i < approvals.length; i++) {
    const a = approvals[i];
    try {
      const p = await api.createPayment({
        id: mint(`pago:${a.workerId}`),
        workerId: a.workerId,
        amountCents: a.amountCents,
        method,
        note,
      });
      rows[i] = {
        ...rows[i],
        status: "done",
        paymentId: p.id,
        paidCents: p.amountCents,
        balanceAfterCents: p.balanceAfterCents,
      };
    } catch (e) {
      rows[i] = { ...rows[i], status: "refused", reason: reasonOf(e) };
      return rows;
    }
  }
  return rows;
}

export const isComplete = (rows: RunRow[]): boolean => rows.every((r) => r.status === "done");

/* ------------------------------------------------------------------ */
/* Deshacer                                                            */
/* ------------------------------------------------------------------ */

/** Lo que una nómina lanzada dejó escrito, y por tanto lo que se puede quitar. */
export interface UndoHandle {
  payments: Uuid[];
  settlements: Uuid[];
}

export interface UndoResult {
  paymentsReversed: number;
  settlementsVoided: number;
  /** Las que ya estaban deshechas. No son fallos: son un reintento que llegó. */
  alreadyUndone: number;
  failures: string[];
}

export const undoIsEmpty = (h: UndoHandle | null): boolean =>
  !h || (h.payments.length === 0 && h.settlements.length === 0);

/**
 * Deshacer la nómina: primero los pagos, después las liquidaciones.
 *
 * El orden es el del teléfono (`PaymentsPanel.undoLastRun`) y por su mismo
 * motivo: anular una liquidación escribe su propio reverso del devengo, así
 * que hacerlo al revés dejaría un pago en pie contra un devengo que ya no
 * existe — un saldo negativo que nadie sabe explicar.
 *
 * No se detiene en el primer fallo, y ésta es la excepción a la regla de
 * arriba: aquí no se está firmando nada nuevo, se está retirando. Dejar la
 * mitad de los pagos en pie porque el séptimo dio error de red es peor que
 * seguir y decir cuáles quedaron.
 *
 * Lo ya deshecho —409 ALREADY_REVERSED, SETTLEMENT_ALREADY_VOID— se cuenta
 * aparte y no como fallo: es exactamente lo que contesta un segundo intento
 * del mismo deshacer, y llamarlo error mandaría a alguien a arreglar algo que
 * ya está bien.
 */
export async function undoRun(
  handle: UndoHandle,
  reason: string,
  mint: MintId,
): Promise<UndoResult> {
  const out: UndoResult = {
    paymentsReversed: 0,
    settlementsVoided: 0,
    alreadyUndone: 0,
    failures: [],
  };

  for (const id of handle.payments) {
    try {
      await api.reverseLedgerEntry(id, reason);
      out.paymentsReversed++;
    } catch (e) {
      if (e instanceof ApiError && e.code === "ALREADY_REVERSED") out.alreadyUndone++;
      else out.failures.push(messageFor(e));
    }
  }

  for (const id of handle.settlements) {
    try {
      await api.voidSettlement(id, mint(`anulacion:${id}`));
      out.settlementsVoided++;
    } catch (e) {
      if (e instanceof ApiError && e.code === "SETTLEMENT_ALREADY_VOID") out.alreadyUndone++;
      else out.failures.push(messageFor(e));
    }
  }
  return out;
}

/** Lo escrito por una corrida, listo para deshacerse. */
export function undoHandleOf(runs: PayrollRun[]): UndoHandle {
  const payments: Uuid[] = [];
  const settlements: Uuid[] = [];
  for (const run of runs) {
    for (const r of run.rows) {
      if (r.paymentId) payments.push(r.paymentId);
      if (r.settlementId) settlements.push(r.settlementId);
    }
  }
  return { payments, settlements };
}

/* ------------------------------------------------------------------ */
/* El papel                                                            */
/* ------------------------------------------------------------------ */

/**
 * Sólo las filas que ENTRARON llevan renglón en la planilla.
 *
 * Es la hoja que se firma. Un renglón con una firma al lado para alguien a
 * quien no se le entregó nada es una invitación a firmarlo. Quien no entró se
 * nombra arriba y abajo, en el alcance, que es donde se lee y no donde se
 * firma.
 */
export function payrollRowsOf(run: PayrollRun): PayrollRow[] {
  return run.rows
    .filter((r) => r.status === "done")
    .map((r) => ({
      name: r.name,
      documentNumber: r.documentNumber,
      quantity: r.quantity,
      grossCents: r.grossCents ?? r.paidCents ?? 0,
      // Null, no cero: en el paso de liquidar todavía no se ha leído ningún
      // saldo posterior, y un "$0" ahí diría "queda a paz y salvo".
      balanceCents: r.balanceAfterCents,
      paidCents: r.paidCents,
      status: "open" as const,
    }));
}

/**
 * QUÉ TIENE QUE CONFESAR ESTE PAPEL.
 *
 * La planilla de liquidaciones ya nos mordió una vez: con un filtro puesto,
 * salía con el membrete de la finca, la fecha de hoy y una columna de firmas,
 * y en ninguna parte decía que era el resultado de una búsqueda
 * (`documents.ts`, `PayrollScope`). Aquí hay dos formas de acotar y las dos
 * cuentan:
 *
 *   el buscador       lo mismo de siempre;
 *   las casillas      destildar a cuatro personas de treinta produce una
 *                     planilla igual de parcial, y es MÁS fácil de hacer sin
 *                     darse cuenta que escribir en un buscador.
 *
 * Y una tercera, que sólo tiene esta pantalla: quien no entró porque la
 * corrida se detuvo. Se nombra, uno por uno, con su motivo.
 */
export function payrollScopeOf(run: PayrollRun): PayrollScope {
  const filters = [...run.scope.filters];

  const left = run.scope.crewSize - run.rows.length;
  if (left > 0) {
    filters.push(
      left === 1
        ? "se dejó fuera a 1 persona de la cuadrilla"
        : `se dejó fuera a ${left} personas de la cuadrilla`,
    );
  }

  const missed = run.rows.filter((r) => r.status !== "done");
  if (missed.length > 0) {
    filters.push(
      `no entraron ${missed.length}: ` +
        missed
          .map((r) => `${r.name} (${r.reason ?? "no se llegó a intentar"})`)
          .join("; "),
    );
  }

  return {
    filters,
    // Cuántas líneas habría tenido la planilla completa de esta cuadrilla.
    totalRows: run.scope.crewSize,
    totalGrossCents: run.scope.crewTotalCents,
  };
}

/** True cuando el papel tiene que declararse parcial. */
export const runIsPartial = (run: PayrollRun): boolean =>
  payrollScopeOf(run).filters.length > 0;

const STEP_TITLE: Record<PayrollRun["step"], string> = {
  settle: "Planilla de liquidación de cuadrilla",
  pay: "Planilla de nómina",
};

export const payrollTitleOf = (run: PayrollRun): string =>
  runIsPartial(run) ? `${STEP_TITLE[run.step]} (parcial)` : STEP_TITLE[run.step];
