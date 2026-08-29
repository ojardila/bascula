/**
 * RSP-015, as rules rather than as `if`s scattered through a form.
 *
 * The shape of the form changes with the activity's `payMode` and
 * `rateSource`, and the combinations are where a wrong peso figure comes from:
 *
 *   work_unit + weekly_price -> quantity in kg/arroba/canasta, NO price field,
 *                               and the record is forced to a single day.
 *   work_unit + fixed        -> quantity, price editable by the owner.
 *   time_unit                -> quantity is a number of day-wages; date range
 *                               may be open, price frozen on write.
 *   contract                 -> no quantity at all (the contract is the whole
 *                               job); the price IS the total.
 *
 * The single-day rule is not a UI preference. `arquitectura-api.md` §1 makes
 * it a CHECK constraint: a jornal from Tuesday to Tuesday has no single Monday,
 * so deriving a weekly price over a range is the ambiguity that ends in a
 * mis-paid week. The web collapses the range to a day and says so, rather than
 * letting the server reject the form after the fact.
 *
 * Kept free of React so the suite can walk every combination directly.
 */
import { amountCents } from "../../lib/money";
import type { Activity, WorkRecordInput } from "../../api/types";

export interface WorkRecordDraft {
  workerId: string;
  activityId: string;
  plotIds: string[];
  plotCropIds: string[];
  dateFrom: string;
  dateTo: string;
  /** Raw text as typed, so "38,5" survives a failed submit untouched. */
  quantity: string;
  /** Raw text as typed. Empty when the activity derives its own price. */
  rateCents: number | null;
  note: string;
}

/** field name -> why it is wrong, in Spanish, ready to render under the input. */
export type FieldErrors = Partial<Record<keyof WorkRecordDraft, string>>;

export interface ParsedDraft {
  errors: FieldErrors;
  valid: boolean;
  /** Present only when valid. Quantity already parsed and dates collapsed. */
  input?: WorkRecordInput & { id: string };
}

/** Does this activity take a quantity from the user at all? */
export function needsQuantity(activity: Activity): boolean {
  return activity.payMode !== "contract";
}

/** Does the user get to see and edit a price on this form? */
export function needsRateField(activity: Activity): boolean {
  return activity.rateSource !== "weekly_price";
}

/** Is the date range collapsed to a single day? */
export function forcesSingleDay(activity: Activity): boolean {
  return activity.rateSource === "weekly_price";
}

/** The label next to the quantity box: "kg", "Jornales", ... */
export function quantityLabel(activity: Activity): string {
  if (activity.payMode === "work_unit") return activity.workUnit ?? "unidades";
  if (activity.payMode === "time_unit") {
    switch (activity.timeUnit) {
      case "jornal": return "jornales";
      case "semanal": return "semanas";
      case "quincenal": return "quincenas";
      case "mensual": return "meses";
      default: return "períodos";
    }
  }
  return "";
}

export function parseQuantity(raw: string): number | null {
  const cleaned = raw.trim().replace(/\./g, "").replace(",", ".");
  if (cleaned === "") return null;
  if (!/^\d*(\.\d+)?$/.test(cleaned)) return null;
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : null;
}

/**
 * What the record is worth right now.
 *
 * For `weekly_price` this is an ESTIMATE and the screen says so: the real
 * figure is frozen at settlement with the Monday price, exactly as the mobile
 * app does it today. Returns null when there is nothing to multiply yet.
 */
export function estimateCents(
  activity: Activity,
  quantity: number | null,
  rateCents: number | null,
): number | null {
  if (rateCents === null || rateCents === undefined) return null;
  if (activity.payMode === "contract") return rateCents;
  if (quantity === null) return null;
  return amountCents(quantity, rateCents);
}

/**
 * Validates the draft and, if it passes, hands back the request body.
 *
 * Every message names the field and says why, which is the convention of
 * `casos-de-uso.md`: "indica cuáles y por qué, y deja volver al formulario".
 */
export function validateWorkRecord(
  draft: WorkRecordDraft,
  activity: Activity | null,
  id: string,
): ParsedDraft {
  const errors: FieldErrors = {};

  if (!activity) {
    return { errors: { activityId: "Elija una actividad." }, valid: false };
  }

  if (!draft.workerId) errors.workerId = "Elija el empleado que hizo la labor.";
  if (draft.plotIds.length === 0) errors.plotIds = "Elija al menos un lote.";
  if (draft.plotCropIds.length === 0) {
    errors.plotCropIds = "Elija al menos un cultivo de los lotes seleccionados.";
  }

  if (!draft.dateFrom) errors.dateFrom = "Indique la fecha de la labor.";

  let dateTo = draft.dateTo || draft.dateFrom;
  if (forcesSingleDay(activity)) {
    // Collapse, do not reject: web.md §3 is explicit that this is the way out
    // of the clash between RSP-015's date range and the weekly price model.
    dateTo = draft.dateFrom;
  } else if (draft.dateFrom && dateTo && dateTo < draft.dateFrom) {
    errors.dateTo = "La fecha final no puede ser anterior a la inicial.";
  }

  let quantity = 1;
  if (needsQuantity(activity)) {
    const parsed = parseQuantity(draft.quantity);
    if (parsed === null) {
      errors.quantity = `Escriba la cantidad en ${quantityLabel(activity)}.`;
    } else if (parsed <= 0) {
      errors.quantity = "La cantidad tiene que ser mayor que cero.";
    } else {
      quantity = parsed;
    }
  }

  let rate = draft.rateCents;
  if (needsRateField(activity)) {
    if (rate === null || rate === undefined) {
      rate = activity.defaultRateCents ?? null;
    }
    if (rate === null) {
      errors.rateCents =
        activity.payMode === "contract"
          ? "Indique el valor total del contrato."
          : "Indique el precio. La actividad no tiene uno vigente para esta fecha.";
    } else if (rate <= 0) {
      errors.rateCents = "El precio tiene que ser mayor que cero.";
    }
  } else {
    // weekly_price: the rate is not the client's to send. Sending the activity
    // default here would freeze a stale price into the record.
    rate = null;
  }

  const valid = Object.keys(errors).length === 0;
  if (!valid) return { errors, valid };

  return {
    errors,
    valid: true,
    input: {
      id,
      workerId: draft.workerId,
      activityId: draft.activityId,
      plotIds: draft.plotIds,
      plotCropIds: draft.plotCropIds,
      dateFrom: draft.dateFrom,
      dateTo,
      quantity,
      rateCents: rate,
      note: draft.note || undefined,
    },
  };
}

export function emptyDraft(today: string): WorkRecordDraft {
  return {
    workerId: "",
    activityId: "",
    plotIds: [],
    plotCropIds: [],
    dateFrom: today,
    dateTo: today,
    quantity: "",
    rateCents: null,
    note: "",
  };
}
