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

  /**
   * True when the module must be exited, per the casos-de-uso convention.
   *
   * Not every 403 qualifies, and getting this wrong is user-visible. The
   * server answers 403 for three quite different situations:
   *
   *   FORBIDDEN           your role may not do this      -> leave the module
   *   FARM_SUSPENDED      the farm is frozen, read-only  -> banner, stay
   *   EMAIL_NOT_VERIFIED  you have not confirmed yet     -> login screen, stay
   *
   * Treating the last two as "you may not be here" would throw somebody out of
   * the login screen for the crime of not having opened their mail yet.
   */
  get isPermissionDenied(): boolean {
    if (this.status !== 403) return false;
    return this.code !== "FARM_SUSPENDED" && this.code !== "EMAIL_NOT_VERIFIED";
  }

  /** A local refusal that never left the browser: a route we know is absent. */
  get isUnsupported(): boolean {
    return this.status === 0 && this.code.startsWith("NOT_IMPLEMENTED");
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
  /* -- auth ---------------------------------------------------------- */
  // The server's code is INVALID_CREDENTIALS. Sprint 1 wrote UNAUTHENTICATED,
  // which nothing has ever sent, so a wrong password fell through to the
  // English server text — the first thing the integration got wrong and the
  // reason this table is now checked against domain/errors.go.
  INVALID_CREDENTIALS: "Correo o contraseña incorrectos.",
  UNAUTHORIZED: "Su sesión no es válida. Vuelva a entrar.",
  TOKEN_EXPIRED: "Su sesión venció. Vuelva a entrar.",
  // Presenting a refresh token twice means a replay or a stolen copy, and the
  // server kills the whole device family rather than just failing. Saying so
  // matters: the person was not logged out at random.
  TOKEN_REUSED:
    "Se cerró la sesión por seguridad: ese acceso se usó dos veces. Vuelva a entrar.",
  EMAIL_NOT_VERIFIED:
    "Falta confirmar el correo. Busque el mensaje de Báscula y abra el enlace.",
  EMAIL_TAKEN: "Ya existe una cuenta con ese correo. Entre con ella o use otro correo.",
  FARM_LIMIT_REACHED: "Ese correo ya tiene el máximo de fincas permitidas.",
  RATE_LIMITED: "Demasiados intentos. Espere un rato y vuelva a probar.",

  /* -- tenant -------------------------------------------------------- */
  FARM_SUSPENDED:
    "La finca está suspendida: puede consultar, pero no registrar ni modificar nada. Escríbanos para reactivarla.",
  FORBIDDEN: "Su usuario no tiene permiso para esta parte del sistema.",
  // Somebody was taken off this farm while their session was still open. It is
  // not a password problem and saying so would send them to change one.
  // Somebody's role changed while their session was open. The client refreshes
  // and retries once, so this is normally invisible; the sentence is for when
  // the refresh does not fix it, and it must not read like a password problem.
  ROLE_CHANGED:
    "Su permiso en esta finca cambió mientras trabajaba. Vuelva a entrar para seguir con los permisos nuevos.",
  MEMBERSHIP_REVOKED:
    "Su acceso a esta finca fue retirado. Si cree que es un error, hable con el dueño de la finca; no es problema de su contraseña.",
  // The platform flag was taken off the account while the session was open.
  // Same shape as ROLE_CHANGED: the client refreshes and retries once, so this
  // is normally invisible, and the console simply stops being in the menu.
  PLATFORM_ROLE_CHANGED:
    "Su permiso de administrador de la plataforma cambió mientras trabajaba. Vuelva a entrar para seguir con los permisos nuevos.",
  // The server's loud failure when the tenant was never established. It is a
  // 500 and it is a bug on our side of the wire, not something the user did.
  TENANT_NOT_SET:
    "Hubo un problema con la sesión y no se pudo identificar la finca. Vuelva a entrar; si sigue pasando, avísenos.",

  /* -- shape --------------------------------------------------------- */
  BAD_REQUEST: "Faltan datos o hay un dato mal escrito. Revise el formulario.",
  NOT_FOUND: "No encontramos ese registro. Puede que alguien lo haya dado de baja.",
  CONFLICT: "Ese cambio choca con algo que ya existe.",
  INTERNAL: "El servidor tuvo un problema. Intente de nuevo en un momento.",

  /* -- plots --------------------------------------------------------- */
  INVALID_GEOMETRY: "El polígono se cruza a sí mismo. Vuelva a dibujarlo.",
  PLOT_HAS_ACTIVE_CROPS:
    "El lote todavía tiene cultivos activos. Dé de baja los cultivos primero.",

  /* -- work records and settlements ---------------------------------- */
  WORK_RECORD_SETTLED:
    "Esta labor ya está incluida en una liquidación viva. Para cambiarla hay que anular esa liquidación primero.",
  PAYABLE_ALREADY_CLAIMED:
    "Otra persona liquidó estas labores mientras usted trabajaba en esta pantalla. Se recargó el saldo con la liquidación que ganó.",
  SETTLEMENT_ALREADY_VOID: "Esa liquidación ya estaba anulada.",
  ALREADY_REVERSED: "Ese movimiento ya tenía un reverso. No se puede reversar dos veces.",
  NOTHING_TO_SETTLE:
    "No hay nada que liquidar: no hay labores pendientes en ese periodo.",
  AMOUNT_EXCEEDS_BALANCE:
    "El valor es mayor que el saldo pendiente. Corrija el valor o registre el excedente como anticipo.",
  // Raised when an activity has no price in force on the day of the work.
  NO_RATE_IN_FORCE:
    "Esa actividad no tenía precio definido en esa fecha. Fije un precio con esa fecha de inicio y vuelva a intentar.",
  // A record whose price comes from a date has to be a single day: a wage from
  // Tuesday to Tuesday has no single validity period and no single week.
  RANGE_NEEDS_FROZEN_RATE:
    "Para varios días hay que fijar el valor de la labor. Escriba el valor o registre un día a la vez.",
  DUPLICATE_DOCUMENT: "Ya hay un empleado con esa identificación en esta finca.",
  // The screen catches this one before the message is ever shown, because the
  // useful thing is the button, not the sentence: `details.employeeId` names
  // the person who is already here, and WorkerFormPage offers to reactivate
  // them. The text is here so the code is never displayed bare — a 409 on a
  // form somebody is trying to submit, with no way forward, is how a
  // duplicate file gets created under a slightly different document number.
  EMPLOYEE_EXISTS_DELETED:
    "Esa identificación ya existe en la finca, en un empleado que está inactivo. " +
    "Reactívelo en vez de crear uno nuevo: si crea otro, la misma persona queda " +
    "con dos cuentas y el saldo se parte en dos.",
  DUPLICATE_NAME: "Ya existe un registro con ese nombre en esta finca.",
  // Voiding a settlement is not the same as releasing it: releasing repairs
  // one that is ALREADY void and stayed holding on to the work items.
  SETTLEMENT_NOT_VOID:
    "Esa liquidación está vigente, y sus líneas son justo lo que impide que una pesada se pague dos veces. Anúlela primero.",
  NOTHING_TO_RELEASE:
    "Esa liquidación no tiene ninguna labor agarrada ni ningún reverso pendiente: no hay nada que soltar. Puede que sea otro documento el que está buscando.",
  // What an owner sees when they take themselves off the farm. Untranslated
  // it reached the screen in English, and it is one of the worst ones to be
  // left in the dark on: the farm ends up with nobody who can set prices or
  // invite users.
  LAST_OWNER:
    "La finca se quedaría sin dueño. Nombre primero a otro dueño y después quítese usted.",
  // The payment screen and the payroll catch this one earlier and show what
  // moved; this is here so the code is never displayed bare if it arrives
  // through some other door.
  GROSS_CHANGED:
    "El total cambió mientras usted revisaba. No se registró nada. Vuelva a mirar el detalle y apruebe la cifra nueva.",

  /* -- syncing with the phone ---------------------------------------- */
  // The four sync ones. The phone raises them, but anybody can land here
  // through a shared screen, and an English code in the middle of a Spanish
  // screen is exactly what makes somebody think they broke something.
  CURSOR_TOO_OLD:
    "El teléfono lleva demasiado tiempo sin sincronizar y ya no se puede saber qué se perdió. Tiene que sincronizar desde el principio.",
  SCHEMA_TOO_OLD:
    "La aplicación del teléfono está desactualizada y el servidor no entiende sus datos. Actualícela antes de sincronizar.",
  REPLAY_REQUIRED:
    "Esa sincronización venía de otro usuario o de otra sesión y no se puede continuar. Hay que sincronizar desde el principio.",
  IMPORT_MISMATCH:
    "Los saldos que envió el teléfono no coinciden con los que salen del libro. No se registró nada: hay que revisar las diferencias antes de importar.",

  /* -- inventory, sales and expenses --------------------------------- */
  // The warehouse said no. `details.available` and `details.requested` carry
  // the two numbers, and the sales screen puts them in the sentence rather
  // than making somebody go and look them up.
  INSUFFICIENT_STOCK:
    "No hay suficiente producto en esa bodega para esa venta. Registre primero la entrada que falta, o marque «registrar de todos modos» si la bodega está desactualizada.",
  SALE_ALREADY_VOID: "Esa venta ya estaba anulada.",
  // ONE code, not the two this table first guessed at.
  //
  // `expense_target` covers three refusals — charged to nothing, charged to
  // both, and a crop named without its lot — and `domain/errors.go` gives all
  // three the same name, because they are the same constraint failing. Two
  // Spanish sentences keyed to codes the server has never sent would both fall
  // through to the server's English, which is how a translation table quietly
  // stops translating. Checked against `AllCodes()`.
  EXPENSE_TARGET_INVALID:
    "Un gasto se carga a una actividad O a un lote, nunca a las dos cosas ni a ninguna. Elija una, y si eligió un cultivo, diga también en qué lote está.",
  UPLOAD_TOO_LARGE: "El archivo pesa demasiado. Use uno más liviano.",
  UPLOAD_NOT_READY:
    "El comprobante todavía se está subiendo. Espere a que termine y vuelva a guardar.",
  UNSUPPORTED_MEDIA_TYPE: "Ese tipo de archivo no se puede adjuntar.",
  IDEMPOTENCY_KEY_REUSED:
    "Ese registro ya se usó para otra cosa. Recargue la pantalla antes de volver a guardar.",

  /* -- routes this build knows the server does not have --------------- */
  // Local refusals (status 0). They never reach the network: saying "todavía
  // no" is better than a 404 the user reads as a bug.
  NOT_IMPLEMENTED_ADMIN:
    "La consola de administración todavía no está disponible en el servidor.",
  NOT_IMPLEMENTED_NOTES: "Las notas de empleado todavía no están disponibles.",
  NOT_IMPLEMENTED_UNDELETE: "Reactivar todavía no está disponible en el servidor.",
  // Raised locally by `routeMayBeMissing` when a collection route answers 404,
  // which can only mean the route is absent. The message carries the module's
  // name, so it is the ApiError's own text that is shown and not this one —
  // this entry exists so that the code is never displayed bare.
  NOT_IMPLEMENTED_MODULE:
    "Ese módulo todavía no está disponible en el servidor. Puede verlo con datos simulados.",

  /* -- media --------------------------------------------------------- */
  FILE_TOO_LARGE: "La foto pesa más de 5 MB. Use una más liviana.",

  /* -- registry (later sprints, but the codes exist) ------------------ */
  NO_CONSENT:
    "No hay autorización registrada de esta persona para consultar su historial.",
  REGISTRY_OPT_OUT: "Esta finca no participa en el registro de historial laboral.",

  /* -- transport ----------------------------------------------------- */
  NETWORK: "No se pudo contactar el servidor. Revise la conexión e intente otra vez.",
  UNKNOWN: "Ocurrió un error inesperado. Intente de nuevo.",
};

export function messageFor(err: unknown): string {
  if (err instanceof ApiError) return err.spanishMessage;
  if (err instanceof Error && err.message) return err.message;
  return ERROR_MESSAGES.UNKNOWN;
}
