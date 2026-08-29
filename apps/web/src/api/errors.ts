/**
 * `{"error":{"code","message","details"}}` -> something a farmer can act on.
 *
 * The contract is explicit that the client branches on `code` and that the
 * translation lives here (arquitectura-api.md §7). The server's `message` is
 * for the log; it is only shown when we have no translation, and then it is
 * shown rather than swallowed, because a wrong-but-visible message is easier
 * to report than a silent screen.
 *
 * Every message says what happened AND what to do next. "Conflicto 409" tells
 * a person nothing; "esta labor ya está en una liquidación viva: anúlela
 * primero" tells them where to click.
 */
import type { ApiErrorBody } from "./types";

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details: Record<string, unknown>;
  /** Field -> reason, for a 400 that names the offending inputs. */
  readonly fieldErrors: Record<string, string>;

  constructor(status: number, body: ApiErrorBody | null, fallback?: string) {
    const code = body?.error?.code ?? "UNKNOWN";
    super(body?.error?.message ?? fallback ?? "Error de red");
    this.name = "ApiError";
    this.status = status;
    this.code = code;
    this.details = (body?.error?.details ?? {}) as Record<string, unknown>;
    this.fieldErrors = extractFieldErrors(this.details);
  }

  /** The sentence to put in front of the user. */
  get spanishMessage(): string {
    return ERROR_MESSAGES[this.code] ?? this.message;
  }

  /** True when the module must be exited, per the casos-de-uso convention. */
  get isPermissionDenied(): boolean {
    return this.status === 403 && this.code !== "FARM_SUSPENDED";
  }
}

function extractFieldErrors(details: Record<string, unknown>): Record<string, string> {
  const raw = details.fields;
  if (!raw || typeof raw !== "object") return {};
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    out[k] = typeof v === "string" ? v : FIELD_REASONS.required;
  }
  return out;
}

export const FIELD_REASONS = {
  required: "Este dato es obligatorio.",
  tooLong: "Es demasiado largo.",
  notANumber: "Escriba un número.",
  notPositive: "Tiene que ser mayor que cero.",
} as const;

/**
 * The business conflicts are part of the contract, not accidents, so they get
 * a sentence each. Anything not in this table falls back to the server text.
 */
export const ERROR_MESSAGES: Record<string, string> = {
  // Auth
  UNAUTHENTICATED: "Correo o contraseña incorrectos.",
  TOKEN_EXPIRED: "Su sesión venció. Vuelva a entrar.",
  EMAIL_NOT_VERIFIED:
    "Falta confirmar el correo. Busque el mensaje de Báscula y abra el enlace.",
  EMAIL_ALREADY_REGISTERED:
    "Ya existe una cuenta con ese correo. Entre con ella o use otro correo.",
  RATE_LIMITED: "Demasiados intentos. Espere un minuto y vuelva a probar.",

  // Tenant
  FARM_SUSPENDED:
    "La finca está suspendida: puede consultar, pero no registrar ni modificar nada. Escríbanos para reactivarla.",
  FORBIDDEN: "Su usuario no tiene permiso para esta parte del sistema.",
  PERMISSION_DENIED: "Su usuario no tiene permiso para esta parte del sistema.",

  // Plots
  INVALID_GEOMETRY: "El polígono se cruza a sí mismo. Vuelva a dibujarlo.",
  PLOT_HAS_ACTIVE_CROPS:
    "La parcela todavía tiene cultivos activos. Dé de baja los cultivos primero.",

  // Work records and settlements
  WORK_RECORD_SETTLED:
    "Esta labor ya está incluida en una liquidación viva. Para cambiarla hay que anular esa liquidación primero.",
  TASK_SETTLED:
    "Esta labor ya está incluida en una liquidación viva. Para cambiarla hay que anular esa liquidación primero.",
  PAYABLE_ALREADY_CLAIMED:
    "Otra persona liquidó estas labores mientras usted trabajaba en esta pantalla. Se recargó el saldo con la liquidación que ganó.",
  SETTLEMENT_ALREADY_VOID: "Esa liquidación ya estaba anulada.",
  ALREADY_REVERSED: "Ese movimiento ya tenía un reverso. No se puede reversar dos veces.",
  NOTHING_TO_SETTLE:
    "No hay nada que liquidar: no hay labores pendientes ni saldo a favor.",
  AMOUNT_EXCEEDS_BALANCE:
    "El valor es mayor que el saldo pendiente. Corrija el valor o registre el excedente como anticipo.",
  WEEKLY_PRICE_NEEDS_SINGLE_DAY:
    "Esta actividad usa precio semanal, así que la labor tiene que ser de un solo día.",
  DUPLICATE_DOCUMENT:
    "Ya hay un empleado con esa identificación en esta finca.",

  // Registry (out of Sprint 1, but the codes exist)
  NO_CONSENT:
    "No hay autorización registrada de esta persona para consultar su historial.",
  REGISTRY_OPT_OUT: "Esta finca no participa en el registro de historial laboral.",

  // Media
  FILE_TOO_LARGE: "La foto pesa más de 5 MB. Use una más liviana.",

  // Transport
  NETWORK: "No se pudo contactar el servidor. Revise la conexión e intente otra vez.",
  UNKNOWN: "Ocurrió un error inesperado. Intente de nuevo.",
};

export function messageFor(err: unknown): string {
  if (err instanceof ApiError) return err.spanishMessage;
  if (err instanceof Error && err.message) return err.message;
  return ERROR_MESSAGES.UNKNOWN;
}
