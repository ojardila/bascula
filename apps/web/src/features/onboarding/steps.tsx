/**
 * THE GUIDED TOURS, AS DATA.
 *
 * The approved onboarding design (docs: bascula-onboarding.pdf, Sept 2026):
 * a welcome, 11 short steps for the owner — 2 about the price of a kilo, 1
 * about other owners, 4 about administrators and weighers, 4 about the first
 * lote — and a closing screen. The weigher gets 2 steps.
 *
 * Every step is one of three kinds:
 *
 *   spot     React Joyride puts a light on a real element of the page and our
 *            MUI card next to it (see JoyrideTour.tsx, loaded lazily).
 *   callout  the same card, rendered INLINE by the page itself, for steps that
 *            live inside a dialog or a form. Joyride's overlay would sit on
 *            top of MUI's modal (focus trap, z-index) and block the very fields
 *            the person has to fill in, so these steps do not use it.
 *   center   the welcome and the closing screens, plain MUI dialogs.
 */
import type { ReactNode } from "react";

export type TourName = "owner" | "weigher";

export interface TourStepDef {
  /** Position in the tour: owner 0 = welcome, 1..11 = steps, 12 = done. */
  n: number;
  kind: "spot" | "callout" | "center";
  /** Where the step happens. The host navigates there first. */
  route?: string;
  /** CSS selector of the element a `spot` step lights up. */
  target?: string;
  placement?: "top" | "bottom" | "left" | "right" | "auto";
  section: string;
  title: string;
  body: ReactNode;
  primary: string;
  /** A page action (see TourContext.registerAction) run by the primary button. */
  action?: string;
  /** Where the primary button goes when it succeeds. "finish" ends the tour; "stay" leaves it to the action. */
  next?: number | "finish" | "stay";
  /** Replaces «Saltar» at the bottom-left, e.g. «No hay otros dueños». */
  secondary?: { label: string; next: number };
  /** A quiet text link under the body, e.g. «Ahora no». */
  alt?: { label: string; next: number | "finish" };
  /** No «Atrás» on this step. */
  noBack?: boolean;
}

export const TOTALS: Record<TourName, number> = { owner: 11, weigher: 2 };

/** The last numbered step; the owner's done screen is one past it. */
export const OWNER_DONE = 12;

const b = (s: string) => <strong>{s}</strong>;

export const OWNER_STEPS: TourStepDef[] = [
  {
    n: 0, kind: "center", section: "", title: "Bienvenida", body: null, primary: "Empezar",
  },
  {
    n: 1, kind: "spot", route: "/precio-semana", target: '[data-tour="base-price"]',
    section: "Su precio", title: "¿Cuánto paga por kilo?",
    body: (
      <>
        Escriba lo que le paga a su gente por cada kilo recogido y desde qué lunes. Si el
        precio cambia más adelante, lo cambia aquí mismo y cuenta desde el día que usted diga.
      </>
    ),
    primary: "Continuar", action: "save-base-price", noBack: true,
  },
  {
    n: 2, kind: "spot", route: "/precio-semana", target: '[data-tour="price-exceptions"]',
    section: "Su precio", title: "¿Algún lote o persona gana distinto?",
    body: (
      <>
        Si un lote, una persona o una semana de cosecha alta se paga distinto, eso se pone
        aparte. {b("Puede hacerlo después.")}
      </>
    ),
    primary: "Continuar",
  },
  {
    n: 3, kind: "spot", route: "/configuracion/usuarios", target: '[data-tour="owners"]',
    section: "Su gente", title: "¿Tiene socios en la finca?",
    body: (
      <>
        Un {b("dueño")} ve y cambia {b("todo")}: precios, pagos, usuarios, y puede borrar.
        Invite solo a los dueños o socios de verdad. Para el mayordomo o el pesador está el
        siguiente paso.
      </>
    ),
    primary: "Invitar a otro dueño", action: "open-owner-invite", next: "stay",
    secondary: { label: "No hay otros dueños", next: 4 },
  },
  {
    n: 4, kind: "spot", route: "/configuracion/usuarios", target: '[data-tour="invite"]',
    section: "Su gente", title: "Invite a quien le ayuda",
    body: (
      <>
        Administradores y pesadores entran con su propio correo. Toque {b("Invitar a alguien")}{" "}
        para darle entrada a una persona.
      </>
    ),
    primary: "Invitar a alguien", action: "open-invite",
    alt: { label: "Ahora no, seguir con los lotes", next: 8 },
  },
  {
    n: 5, kind: "callout", route: "/configuracion/usuarios",
    section: "Su gente", title: "¿Qué puede hacer esta persona?",
    body: (
      <>
        {b("Administrador:")} lleva el día a día y paga, pero no cambia precios.{" "}
        {b("Pesador:")} solo anota kilos y ve lo suyo. Usted, el {b("Dueño")}, puede todo.
      </>
    ),
    primary: "Continuar", action: "submit-invite",
  },
  {
    n: 6, kind: "callout", route: "/configuracion/usuarios",
    section: "Su gente", title: "Entréguele estos datos",
    body: (
      <>
        Dígale que abra esta misma dirección y entre con este correo y esta contraseña.
        Apúntela ahora: {b("es la única vez que se ve")}.
      </>
    ),
    primary: "Continuar", action: "close-invite", noBack: true,
  },
  {
    n: 7, kind: "spot", route: "/configuracion/usuarios", target: '[data-tour="users-list"]',
    section: "Su gente", title: "Aquí ve a todos",
    body: (
      <>
        Cada persona sale con su rol y si ya entró. Puede cambiarle el rol o quitarle la
        entrada cuando quiera.
      </>
    ),
    primary: "Continuar",
  },
  {
    n: 8, kind: "spot", route: "/lotes", target: '[data-tour="module-create"]',
    section: "Sus lotes", title: "Cree su primer lote",
    body: (
      <>
        Un lote es un pedazo de la finca. Con los lotes sabe de dónde sale cada kilo.
      </>
    ),
    primary: "Nuevo lote", action: "go-new-plot",
    alt: { label: "Ahora no, terminar", next: OWNER_DONE },
  },
  {
    n: 9, kind: "callout", route: "/lotes/nuevo",
    section: "Sus lotes", title: "¿Cómo se llama el lote?",
    body: (
      <>
        Escriba el nombre con que lo conocen en la finca, cuántas hectáreas tiene y dónde
        queda.
      </>
    ),
    primary: "Continuar", action: "plot-next",
  },
  {
    n: 10, kind: "callout", route: "/lotes/nuevo",
    section: "Sus lotes", title: "¿Qué se siembra ahí?",
    body: (
      <>
        Escoja el {b("Tipo de cultivo")}. Si tiene más de uno, toque{" "}
        {b("Agregar otro cultivo")}.
      </>
    ),
    primary: "Continuar",
  },
  {
    n: 11, kind: "callout", route: "/lotes/nuevo",
    section: "Sus lotes", title: "Guarde el lote",
    body: <>Toque {b("Guardar lote")}. Listo: ya puede anotar recolecciones en ese lote.</>,
    primary: "Guardar lote", action: "plot-save", next: OWNER_DONE,
  },
  {
    n: OWNER_DONE, kind: "center", section: "", title: "Listo", body: null, primary: "Terminar",
  },
];

export const WEIGHER_STEPS: TourStepDef[] = [
  {
    n: 1, kind: "spot", route: "/cosecha", target: '[data-tour="record-one"]',
    section: "Bienvenido", title: "Aquí anota cada pesada",
    body: <>Toque este botón, escoja a la persona, el lote y escriba los kilos. Eso es todo.</>,
    primary: "Entendido", noBack: true,
  },
  {
    n: 2, kind: "spot", route: "/cosecha", target: '[data-tour="week-summary"]',
    section: "Bienvenido", title: "Lo que lleva la semana",
    body: (
      <>
        Aquí ve los kilos de la semana. Si quiere ver esta ayuda otra vez, está en el menú,
        en {b("Ayuda y recorrido")}.
      </>
    ),
    primary: "Terminar", next: "finish",
  },
];

export function stepsOf(tour: TourName): TourStepDef[] {
  return tour === "owner" ? OWNER_STEPS : WEIGHER_STEPS;
}

export function stepOf(tour: TourName, n: number): TourStepDef | undefined {
  return stepsOf(tour).find((s) => s.n === n);
}

/**
 * Where a saved tour picks up. Steps that live inside a dialog or on the
 * second page of a form cannot be reopened cold after a reload, so they
 * resume at the step that opens them.
 */
export function resumeIndex(tour: TourName, n: number): number {
  if (tour === "weigher") return Math.min(Math.max(n, 1), 2);
  if (n === 5 || n === 6) return 4;
  if (n === 10 || n === 11) return 9;
  return Math.min(Math.max(n, 0), OWNER_DONE);
}

/** The three parts the welcome promises: precio (1–2), su gente (3–7), lotes (8–11). */
export function ownerPartsDone(n: number): number {
  return (n > 2 ? 1 : 0) + (n > 7 ? 1 : 0) + (n > 11 ? 1 : 0);
}

/**
 * Where a tour starts by itself when the app opens, or null when it does not.
 *
 * The trigger is the person, not the farm: a tour starts until THIS user has
 * finished or closed it, and the row lives on the server so a second device
 * does not ask again. No row: from the start. A tour left open (the page was
 * closed mid-way): where it was. "Saltar" (later) is an explicit "not now", so
 * it waits on the resume card instead of reappearing on every page load.
 */
export function autoStartAt(
  tour: "owner" | "weigher",
  row: { step: number; status: "active" | "later" | "dismissed" | "done" } | undefined,
): number | null {
  if (!row) return tour === "owner" ? 0 : 1;
  if (row.status === "active") return resumeIndex(tour, row.step);
  return null;
}
