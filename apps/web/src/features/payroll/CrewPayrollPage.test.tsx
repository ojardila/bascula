/**
 * LA NÓMINA DE CUADRILLA, DE PUNTA A PUNTA.
 *
 * `crew.test.ts` prueba las reglas sobre números planos. Esto prueba lo otro,
 * que es lo que de verdad se firma un sábado: la pantalla, la aprobación, las
 * escrituras contra el servidor simulado y el libro que queda después. Nada
 * está sustituido en la capa del cliente — lo que se ejerce es el camino
 * entero, igual que en `PayWorkerPage.test.tsx`.
 *
 * La finca sembrada tiene tres personas con trabajo pendiente (María $153.600,
 * Luz Dary $49.000, Jhon Fredy $41.840) y una cuarta, Édinson, ya liquidada y
 * sin pagar, con $150.000 de saldo. Esa cuarta persona no es decorado: es el
 * estado a medias que la pantalla tiene que saber leer del servidor sin haberlo
 * guardado en ninguna parte.
 */
import { describe, expect, it, beforeEach } from "vitest";
import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { ThemeProvider } from "@mui/material";
import { CrewPayrollPage } from "./CrewPayrollPage";
import { AuthProvider } from "../../auth/AuthContext";
import { setTokens } from "../../api/client";
import { invalidateRefs } from "../../api/refs";
import { theme } from "../../theme";
import * as db from "../../mocks/db";
import { server } from "../../mocks/node";
import { http, HttpResponse } from "msw";

const OWNER = "0192f3a0-0001-7000-8000-000000000001";

function renderPayroll() {
  return render(
    <ThemeProvider theme={theme}>
      <MemoryRouter initialEntries={["/nomina"]}>
        <AuthProvider>
          <CrewPayrollPage />
        </AuthProvider>
      </MemoryRouter>
    </ThemeProvider>,
  );
}

beforeEach(() => {
  db.resetDb();
  invalidateRefs();
  const now = Date.now();
  setTokens({
    accessToken: `mock-access.${OWNER}.${db.FARM_ID}.${now}.${now + 900_000}`,
    refreshToken: `mock-refresh.${OWNER}`,
  });
});

/** El dueño sube el precio de la semana desde el teléfono, en la otra sala. */
function repriceWeek(monday: string, priceCents: number) {
  const t = db.tenantOf(db.FARM_ID)!;
  const existing = t.weekPrices.find((p) => p.weekStart === monday);
  if (existing) existing.priceCents = priceCents;
  else t.weekPrices.push({ weekStart: monday, priceCents });
}

const tenant = () => db.tenantOf(db.FARM_ID)!;
const liveSettlements = () => tenant().settlements.filter((s) => s.status === "open");
const payments = () => tenant().ledger.filter((e) => e.kind === "pago");
const paidOut = () => payments().reduce((a, e) => a + Math.abs(e.amountCents), 0);

/** Abrir el diálogo de confirmación del paso 1 y quedarse dentro de él. */
async function openSettleConfirm(user: ReturnType<typeof userEvent.setup>) {
  await screen.findByText("1 · Liquidar la semana");
  await waitFor(() =>
    expect(screen.getByRole("button", { name: /Revisar y liquidar/ })).toBeEnabled(),
  );
  await user.click(screen.getByRole("button", { name: /Revisar y liquidar/ }));
  return screen.findByRole("dialog");
}

/* ------------------------------------------------------------------ */

describe("ver antes de firmar", () => {
  it("enseña quién cobra, cuánto, por qué y el total de la finca", async () => {
    const user = userEvent.setup();
    renderPayroll();

    await screen.findByText("1 · Liquidar la semana");
    // El total de la cuadrilla: 153.600 + 49.000 + 41.840.
    expect(await screen.findByText("$244.440")).toBeInTheDocument();
    expect(screen.getByText(/3 personas/)).toBeInTheDocument();

    // Y el POR QUÉ, que es lo que el teléfono nunca enseñó: kilos y precio,
    // línea por línea, sin salir de la pantalla.
    await user.click(screen.getByRole("button", { name: /Ver el detalle de María/ }));
    // Sus dos pesadas van al precio de la semana; la guadañada lleva el suyo.
    expect(await screen.findAllByText("$800 / kg")).toHaveLength(2);
    expect(screen.getByText("38,5 kg")).toBeInTheDocument();
    expect(screen.getByText("$45.000")).toBeInTheDocument();
  }, 30000);

  /**
   * El estado a medias que el diseño de dos pasos crea — y que sólo es
   * aceptable porque no se guarda: se deduce. Édinson está liquidado y sin
   * pagar desde antes de que esta pantalla existiera, y aparece solo.
   */
  it("el paso 2 reconstruye del servidor a quien quedó liquidado y sin pagar", async () => {
    renderPayroll();
    const step2 = (await screen.findByText("2 · Pagar la nómina")).closest(".MuiCard-root")!;
    await waitFor(() =>
      expect(within(step2 as HTMLElement).getByText("Édinson Marín Ríos")).toBeInTheDocument(),
    );
    // $150.000 de Édinson + $184.500 de María.
    expect(within(step2 as HTMLElement).getByText("$334.500")).toBeInTheDocument();
  }, 30000);

  it("el diálogo vuelve a listar a todo el mundo con su importe antes de firmar", async () => {
    const user = userEvent.setup();
    renderPayroll();
    const dialog = await openSettleConfirm(user);

    expect(within(dialog).getByText("Liquidar a 3 personas")).toBeInTheDocument();
    for (const name of ["María Restrepo Ospina", "Jhon Fredy Cardona Loaiza", "Luz Dary Ospina Giraldo"]) {
      expect(within(dialog).getByText(name)).toBeInTheDocument();
    }
    expect(within(dialog).getByText("$153.600")).toBeInTheDocument();
    expect(within(dialog).getByText("$244.440")).toBeInTheDocument();
    // Y dice qué NO hace, que es la mitad del valor de separar los dos pasos.
    expect(within(dialog).getByText(/No entrega plata todavía/)).toBeInTheDocument();
  }, 30000);
});

/* ------------------------------------------------------------------ */

describe("la guarda de la carrera, aplicada a un grupo", () => {
  /**
   * A UNA persona le cambió el bruto. No se liquida a NADIE — ni siquiera a
   * las dos cuyo precio no se movió — y la pantalla dice de quién y qué pasó.
   */
  it("si el bruto de uno cambió, no se escribe nada de nadie y se dice de quién", async () => {
    const user = userEvent.setup();
    renderPayroll();
    const dialog = await openSettleConfirm(user);

    // …y ahora el dueño sube la semana de $800 a $840 el kilo. Sólo María y
    // Jhon Fredy tienen pesadas al precio de la semana.
    repriceWeek("2026-08-24", 84_000);

    const before = liveSettlements().length;
    await user.click(within(dialog).getByRole("button", { name: "Liquidar" }));

    expect(await screen.findByText("Cambió algo mientras revisaba")).toBeInTheDocument();
    expect(
      await screen.findByText(/No se liquidó a nadie, y no se pagó a nadie/),
    ).toBeInTheDocument();

    // DE QUIÉN, y QUÉ cambió — con la misma frase que la pantalla de una sola
    // persona, para que no haya dos redacciones del mismo hecho.
    expect(
      await screen.findByText(
        /Cuando abrió esta pantalla eran \$153\.600; ahora son \$156\.780 porque el precio de la semana del 24 de agosto pasó de \$800 a \$840\./,
      ),
    ).toBeInTheDocument();

    // Y ni una liquidación escrita: ni de María, ni de Luz Dary, a quien no le
    // cambió nada. Eso es lo que significa "no pagar a nadie".
    expect(liveSettlements().length).toBe(before);
  }, 30000);

  it("la única salida es volver a mirar, nunca un reintentar", async () => {
    const user = userEvent.setup();
    renderPayroll();
    const dialog = await openSettleConfirm(user);
    repriceWeek("2026-08-24", 84_000);
    await user.click(within(dialog).getByRole("button", { name: "Liquidar" }));

    const drift = await screen.findByText("Cambió algo mientras revisaba");
    const box = drift.closest('[role="dialog"]') as HTMLElement;
    expect(within(box).getAllByRole("button").map((b) => b.textContent)).toEqual([
      "Volver a revisar",
    ]);

    await user.click(within(box).getByRole("button", { name: "Volver a revisar" }));
    // Y vuelve con la cifra nueva, que es la que la próxima aprobación llevará.
    expect(await screen.findByText("$249.712")).toBeInTheDocument();
  }, 30000);

  /**
   * LA MITAD QUE NO BLOQUEA. Una pesada tardía no cambia la cifra firmada — la
   * liquidación nombra su conjunto — así que la nómina sale, y la pantalla
   * avisa de que ese trabajo queda para la próxima en vez de callárselo.
   */
  it("una pesada que llega tarde no detiene la nómina, pero se avisa", async () => {
    const user = userEvent.setup();
    renderPayroll();
    const dialog = await openSettleConfirm(user);

    const t = tenant();
    const maria = t.workers[0];
    const source = t.workRecords[0];
    t.workRecords.push({
      ...source,
      id: "0192f3a0-0008-7000-8000-0000000000ff",
      workerId: maria.id,
      quantity: 9,
      estimatedAmountCents: 720_000,
      createdAt: "2026-08-28T22:00:00Z",
    });

    await user.click(within(dialog).getByRole("button", { name: "Liquidar" }));

    expect(await screen.findByText("Liquidación de cuadrilla")).toBeInTheDocument();
    expect(liveSettlements().length).toBe(4);
    expect(await screen.findByText(/Llegó trabajo nuevo mientras revisaba/)).toBeInTheDocument();
    expect(screen.getByText(/No entra en esta corrida/)).toBeInTheDocument();
  }, 30000);

  /** La misma idea sobre el otro número: después de liquidar, el saldo. */
  it("si el saldo de uno cambió, no se paga a nadie", async () => {
    const user = userEvent.setup();
    renderPayroll();
    await screen.findByText("2 · Pagar la nómina");
    await waitFor(() =>
      expect(screen.getByRole("button", { name: /Revisar y pagar/ })).toBeEnabled(),
    );
    await user.click(screen.getByRole("button", { name: /Revisar y pagar/ }));
    const dialog = await screen.findByRole("dialog");

    // Alguien le entregó un anticipo a Édinson en el lote mientras tanto.
    tenant().ledger.push({
      id: crypto.randomUUID(),
      workerId: tenant().workers[3].id,
      kind: "anticipo",
      amountCents: -5_000_000,
      date: "2026-08-29T12:00:00Z",
      settlementId: null,
      method: "efectivo",
      note: null,
      reversesId: null,
      createdAt: "2026-08-29T12:00:00Z",
    });

    const before = paidOut();
    await user.click(within(dialog).getByRole("button", { name: /^Pagar \$/ }));

    expect(await screen.findByText("El saldo cambió mientras revisaba")).toBeInTheDocument();
    expect(await screen.findByText(/No se pagó a nadie/)).toBeInTheDocument();
    expect(paidOut()).toBe(before);
  }, 30000);
});

/* ------------------------------------------------------------------ */

/**
 * ── EL DOBLE CLIC, MULTIPLICADO POR TREINTA ─────────────────────────────
 *
 * El hallazgo A1 sobre la pantalla de una persona costó $10.000 de más. El
 * mismo fallo aquí cuesta una nómina entera repetida. Los clics se despachan
 * nativamente, en el mismo macrotask, que es lo único que reproduce lo que
 * hace un ratón de verdad: `userEvent` espera entre acciones y `fireEvent`
 * envuelve cada llamada en `act()`, y las dos le dan a React un re-render
 * entre medias que un doble clic real no le da.
 */
describe("un doble clic no puede lanzar la nómina dos veces", () => {
  it("liquida una sola vez, aunque la comprobación previa vaya por delante", async () => {
    const user = userEvent.setup();
    renderPayroll();
    const dialog = await openSettleConfirm(user);

    const posts: string[] = [];
    server.events.on("request:start", ({ request }) => {
      if (request.method === "POST" && new URL(request.url).pathname === "/v1/settlements") {
        posts.push(request.url);
      }
    });

    const button = within(dialog).getByRole("button", { name: "Liquidar" });
    await act(async () => {
      button.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      button.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    await screen.findByText("Liquidación de cuadrilla");
    // Tres personas, tres liquidaciones. No seis.
    expect(posts).toHaveLength(3);
    expect(liveSettlements().length).toBe(4);
  }, 30000);

  it("y paga una sola vez", async () => {
    const user = userEvent.setup();
    renderPayroll();
    await screen.findByText("2 · Pagar la nómina");
    await waitFor(() =>
      expect(screen.getByRole("button", { name: /Revisar y pagar/ })).toBeEnabled(),
    );
    await user.click(screen.getByRole("button", { name: /Revisar y pagar/ }));
    const dialog = await screen.findByRole("dialog");

    // La finca sembrada ya tiene pagos hechos: lo que se mide es lo que ESTA
    // corrida entrega, no el acumulado de la temporada.
    const before = paidOut();
    const posts: string[] = [];
    server.events.on("request:start", ({ request }) => {
      if (request.method === "POST" && new URL(request.url).pathname === "/v1/payments") {
        posts.push(request.url);
      }
    });

    const button = within(dialog).getByRole("button", { name: /^Pagar \$/ });
    await act(async () => {
      button.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      button.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    await screen.findByText("Nómina pagada");
    expect(posts).toHaveLength(2);
    // $150.000 de Édinson + $184.500 de María, una sola vez.
    expect(paidOut() - before).toBe(33_450_000);
  }, 30000);
});

/* ------------------------------------------------------------------ */

describe("la corrida completa, y su parte", () => {
  it("liquida, después paga, y el parte dice cuánto entregó a cada quien", async () => {
    const user = userEvent.setup();
    const before = paidOut();
    renderPayroll();

    const settle = await openSettleConfirm(user);
    await user.click(within(settle).getByRole("button", { name: "Liquidar" }));
    await screen.findByText("Liquidación de cuadrilla");
    expect(liveSettlements().length).toBe(4);

    // Ahora el paso 2 trae a los cuatro: los tres recién liquidados y Édinson.
    await waitFor(() =>
      expect(screen.getByRole("button", { name: /Revisar y pagar · \$578\.940/ })).toBeEnabled(),
    );
    await user.click(screen.getByRole("button", { name: /Revisar y pagar/ }));
    const pay = await screen.findByRole("dialog");
    await user.click(within(pay).getByRole("button", { name: /^Pagar \$578\.940$/ }));

    const report = await screen.findByText("Nómina pagada");
    const card = report.closest(".MuiCard-root") as HTMLElement;
    expect(within(card).getByText(/4 de 4 personas · \$578\.940/)).toBeInTheDocument();
    expect(paidOut() - before).toBe(57_894_000);
  }, 40000);

  /**
   * Se detiene en el primer rechazo, a propósito, y lo que sí entró queda
   * escrito, contado y deshacible. Un parte que dijera "falló" sin decir
   * quiénes entraron dejaría a alguien contando efectivo contra nada.
   */
  it("se detiene en el primer rechazo y dice quién entró y quién no", async () => {
    const user = userEvent.setup();
    // Sólo la SEGUNDA escritura cae. Devolver `undefined` deja pasar la
    // petición al manejador de siempre, así que la primera se escribe de
    // verdad y la tercera ni se intenta.
    let seen = 0;
    server.use(
      http.post("*/v1/settlements", () => {
        seen++;
        if (seen !== 2) return undefined;
        return HttpResponse.json(
          { error: { code: "INTERNAL", message: "boom" } },
          { status: 503 },
        );
      }),
    );

    renderPayroll();
    const dialog = await openSettleConfirm(user);
    await user.click(within(dialog).getByRole("button", { name: "Liquidar" }));

    expect(await screen.findByText("La corrida se detuvo")).toBeInTheDocument();
    const report = (await screen.findByText("Liquidación de cuadrilla")).closest(
      ".MuiCard-root",
    ) as HTMLElement;
    expect(within(report).getByText(/1 de 3 personas/)).toBeInTheDocument();
    expect(within(report).getByText("entró")).toBeInTheDocument();
    expect(within(report).getByText("no entró")).toBeInTheDocument();
    expect(within(report).getByText("sin intentar")).toBeInTheDocument();
    // Y el papel lo confesará.
    expect(within(report).getByText(/PARCIAL/)).toBeInTheDocument();
  }, 40000);
});

/* ------------------------------------------------------------------ */

describe("deshacer la nómina", () => {
  it("reversa los pagos, anula las liquidaciones y dice qué deshizo", async () => {
    const user = userEvent.setup();
    const before = paidOut();
    const seededPayments = payments().length;
    renderPayroll();

    const settle = await openSettleConfirm(user);
    await user.click(within(settle).getByRole("button", { name: "Liquidar" }));
    await screen.findByText("Liquidación de cuadrilla");

    await waitFor(() =>
      expect(screen.getByRole("button", { name: /Revisar y pagar · \$578\.940/ })).toBeEnabled(),
    );
    await user.click(screen.getByRole("button", { name: /Revisar y pagar/ }));
    const pay = await screen.findByRole("dialog");
    await user.click(within(pay).getByRole("button", { name: /^Pagar \$578\.940$/ }));
    await screen.findByText("Nómina pagada");
    expect(paidOut() - before).toBe(57_894_000);

    // Dice qué va a deshacer ANTES de hacerlo. `findBy` y no `getBy`: mientras
    // el diálogo de pago se está cerrando, MUI deja el resto de la página en
    // `aria-hidden` y las consultas por rol no la ven.
    await user.click(await screen.findByRole("button", { name: "Deshacer" }));
    const askBox = await screen.findByRole("dialog");
    expect(askBox.textContent).toContain(
      "Se van a reversar 4 pagos y a anular 3 liquidaciones",
    );
    await user.click(within(askBox).getByRole("button", { name: "Deshacer" }));

    // Y qué deshizo después.
    expect(await screen.findByText("Nómina deshecha")).toBeInTheDocument();
    // Las tres de esta corrida quedan anuladas. La de Édinson, que ya existía
    // antes y no es de esta nómina, sigue en pie: deshacer deshace LO QUE ESTA
    // PANTALLA ESCRIBIÓ y nada más.
    await waitFor(() => expect(liveSettlements()).toHaveLength(1));

    // El libro: cada pago con su reverso, y ni una fila borrada.
    const ledger = tenant().ledger;
    const ours = ledger.filter((e) => e.kind === "pago").slice(seededPayments);
    expect(ours).toHaveLength(4);
    for (const p of ours) {
      expect(ledger.some((r) => r.reversesId === p.id)).toBe(true);
    }
  }, 60000);
});

/* ------------------------------------------------------------------ */

describe("el papel dice si estaba filtrado", () => {
  it("una corrida sobre un filtro se marca parcial y nombra el filtro", async () => {
    const user = userEvent.setup();
    renderPayroll();
    await screen.findByText("1 · Liquidar la semana");

    await user.type(screen.getByLabelText("Buscar por empleado"), "María");
    expect(await screen.findByText(/no de la finca entera/)).toBeInTheDocument();

    await waitFor(() =>
      expect(screen.getByRole("button", { name: /Revisar y liquidar · \$153\.600/ })).toBeEnabled(),
    );
    await user.click(screen.getByRole("button", { name: /Revisar y liquidar/ }));
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText(/la planilla saldrá marcada como parcial/)).toBeInTheDocument();
    await user.click(within(dialog).getByRole("button", { name: "Liquidar" }));

    const report = (await screen.findByText("Liquidación de cuadrilla")).closest(
      ".MuiCard-root",
    ) as HTMLElement;
    expect(report.textContent).toContain("Planilla (parcial)");
    expect(within(report).getByText(/empleado contiene «María»/)).toBeInTheDocument();
    // Y la otra forma de acotar, la que sólo tiene esta pantalla.
    expect(within(report).getByText(/se dejó fuera a 2 personas/)).toBeInTheDocument();
  }, 40000);

  it("y destildar a alguien también parte la planilla, sin filtro ninguno", async () => {
    const user = userEvent.setup();
    renderPayroll();
    await screen.findByText("1 · Liquidar la semana");
    await user.click(await screen.findByLabelText("Incluir a Luz Dary Ospina Giraldo"));

    await waitFor(() =>
      expect(screen.getByRole("button", { name: /Revisar y liquidar · \$195\.440/ })).toBeEnabled(),
    );
    await user.click(screen.getByRole("button", { name: /Revisar y liquidar/ }));
    await user.click(
      within(await screen.findByRole("dialog")).getByRole("button", { name: "Liquidar" }),
    );

    const report = (await screen.findByText("Liquidación de cuadrilla")).closest(
      ".MuiCard-root",
    ) as HTMLElement;
    expect(within(report).getByText(/se dejó fuera a 1 persona/)).toBeInTheDocument();
  }, 40000);
});
