/**
 * Crew payroll, the paths the end-to-end file leaves out: a list that cannot
 * be read, one person who cannot, the filter by basket number, a payment run
 * that stops halfway and is retried, an undo that cannot undo everything, and
 * a sheet the browser would not print.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { ThemeProvider } from "@mui/material";
import { http, HttpResponse } from "msw";
import { CrewPayrollPage } from "./CrewPayrollPage";
import { AuthProvider } from "../../auth/AuthContext";
import { setTokens } from "../../api/client";
import { invalidateRefs } from "../../api/refs";
import { theme } from "../../theme";
import * as db from "../../mocks/db";
import { server } from "../../mocks/node";

// jsdom cannot print; here the browser refuses the frame outright.
vi.mock("../documents/print", () => ({ printDocument: vi.fn(() => false) }));

const OWNER = "0192f3a0-0001-7000-8000-000000000001";
const MARIA = "0192f3a0-0006-7000-8000-000000000001";

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

type User = ReturnType<typeof userEvent.setup>;

/** Step 2 seeds Édinson's $150.000 and María's $184.500; wait for the whole figure. */
async function openPayConfirm(
  user: User,
  total = /Revisar y pagar · \$334\.500/,
) {
  await screen.findByText("2 · Pagar la nómina");
  await waitFor(() =>
    expect(screen.getByRole("button", { name: total })).toBeEnabled(),
  );
  // Clicked again until the dialog is up: on a slow runner the crew can still
  // be re-rendering under the first click.
  await waitFor(
    async () => {
      if (!screen.queryByRole("dialog")) {
        await user.click(
          screen.getByRole("button", { name: /Revisar y pagar/ }),
        );
      }
      expect(screen.getByRole("dialog")).toBeInTheDocument();
    },
    { timeout: 15000 },
  );
  return screen.getByRole("dialog");
}

describe("when something cannot be read", () => {
  it("shows the permission screen when the workers are off limits", async () => {
    server.use(
      http.get("*/v1/workers", () =>
        HttpResponse.json(
          { error: { code: "FORBIDDEN", message: "no" } },
          { status: 403 },
        ),
      ),
    );
    renderPayroll();
    expect(await screen.findByText(/correr la nómina/)).toBeInTheDocument();
    expect(
      screen.queryByText("1 · Liquidar la semana"),
    ).not.toBeInTheDocument();
  }, 30000);

  it("shows the error instead of an empty crew", async () => {
    server.use(
      http.get("*/v1/workers", () =>
        HttpResponse.json(
          { error: { code: "BAD_REQUEST", message: "bad" } },
          { status: 400 },
        ),
      ),
    );
    renderPayroll();
    await waitFor(() =>
      expect(document.querySelector(".MuiAlert-colorError")).not.toBeNull(),
    );
    expect(
      screen.queryByText("1 · Liquidar la semana"),
    ).not.toBeInTheDocument();
  }, 30000);

  it("leaves out, by name, a person whose account could not be read", async () => {
    server.use(
      http.get(`*/v1/workers/${MARIA}/payables`, () =>
        HttpResponse.json(
          { error: { code: "BAD_REQUEST", message: "bad" } },
          { status: 400 },
        ),
      ),
    );
    renderPayroll();
    const warning = (await screen.findByText(/No entran en esta/)).closest(
      ".MuiAlert-root",
    ) as HTMLElement;
    expect(warning).toHaveTextContent("María Restrepo Ospina");
  }, 30000);
});

describe("the filter", () => {
  it("finds a person by basket number, says when nobody matches, and clears", async () => {
    const user = userEvent.setup();
    const maria = db.tenantOf(db.FARM_ID)!.workers.find((w) => w.id === MARIA)!;
    renderPayroll();
    await screen.findByText("1 · Liquidar la semana");
    const box = screen.getByLabelText("Buscar por nombre o canasto");
    await user.type(box, maria.tag!);
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: /Revisar y liquidar · \$153\.600/ }),
      ).toBeEnabled(),
    );
    await user.clear(box);
    await user.type(box, "nadie-se-llama-asi");
    expect(
      (await screen.findAllByText("Nadie coincide con el filtro.")).length,
    ).toBeGreaterThan(0);
    await user.click(screen.getByRole("button", { name: "Quitar el filtro" }));
    expect(box).toHaveValue("");
    expect(
      screen.queryByText("Nadie coincide con el filtro."),
    ).not.toBeInTheDocument();
  }, 30000);
});

describe("paying the crew", () => {
  it("a run that stops halfway is reported, and Reintentar finishes it", async () => {
    let seen = 0;
    server.use(
      http.post("*/v1/payments", () => {
        seen++;
        if (seen !== 2) return undefined;
        return HttpResponse.json(
          { error: { code: "AMOUNT_EXCEEDS_BALANCE", message: "no" } },
          { status: 409 },
        );
      }),
    );
    const user = userEvent.setup();
    renderPayroll();
    // Pay by transfer this time.
    await user.click(await screen.findByLabelText("Forma de pago"));
    await user.click(
      await screen.findByRole("option", { name: "Transferencia" }),
    );
    const dialog = await openPayConfirm(user);
    await user.click(within(dialog).getByRole("button", { name: /^Pagar / }));

    expect(await screen.findByText("La corrida se detuvo")).toBeInTheDocument();
    expect(
      (
        await screen.findAllByText(
          /El saldo bajó y el pago aprobado ya no cabe/,
        )
      ).length,
    ).toBeGreaterThan(0);

    await user.click(await screen.findByRole("button", { name: "Reintentar" }));
    expect(
      await screen.findByText("Nómina pagada", {}, { timeout: 15000 }),
    ).toBeInTheDocument();
  }, 60000);

  it("says so when the sheet cannot be printed", async () => {
    const user = userEvent.setup();
    renderPayroll();
    const dialog = await openPayConfirm(user);
    await user.click(within(dialog).getByRole("button", { name: /^Pagar / }));
    await screen.findByText("Nómina pagada", {}, { timeout: 15000 });
    // The payment dialog has to be gone: while it closes the page takes no clicks.
    await waitFor(() =>
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
    );
    await user.click(await screen.findByRole("button", { name: /^Planilla/ }));
    const alert = (
      await screen.findByText(
        "No se pudo abrir la impresión. Revise el navegador.",
      )
    ).closest(".MuiAlert-root") as HTMLElement;
    await user.click(
      within(alert).getByRole("button", { name: /close|cerrar/i }),
    );
    await waitFor(() =>
      expect(
        screen.queryByText(/No se pudo abrir la impresión/),
      ).not.toBeInTheDocument(),
    );
  }, 60000);

  it("leaving somebody out of the payment, and calling the dialog off", async () => {
    const user = userEvent.setup();
    renderPayroll();
    await user.click(
      await screen.findByLabelText("Pagar a María Restrepo Ospina"),
    );
    const dialog = await openPayConfirm(user, /Revisar y pagar · \$150\.000/);
    expect(
      within(dialog).queryByText("María Restrepo Ospina"),
    ).not.toBeInTheDocument();
    await user.click(within(dialog).getByRole("button", { name: "Ahora no" }));
    await waitFor(() =>
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
    );
  }, 60000);
});

describe("undoing a payment run", () => {
  it("can be called off, and says what it could not undo", async () => {
    const user = userEvent.setup();
    renderPayroll();
    const dialog = await openPayConfirm(user);
    await user.click(within(dialog).getByRole("button", { name: /^Pagar / }));
    await screen.findByText("Nómina pagada", {}, { timeout: 15000 });
    // The payment dialog has to be gone: while it closes the page takes no clicks.
    await waitFor(() =>
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
    );

    await user.click(await screen.findByRole("button", { name: "Deshacer" }));
    let ask = await screen.findByRole("dialog");
    await user.click(within(ask).getByRole("button", { name: "Ahora no" }));
    await waitFor(() =>
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
    );

    server.use(
      http.post("*/v1/ledger/:id/reverse", () =>
        HttpResponse.json(
          { error: { code: "BAD_REQUEST", message: "bad" } },
          { status: 400 },
        ),
      ),
    );
    await user.click(await screen.findByRole("button", { name: "Deshacer" }));
    ask = await screen.findByRole("dialog");
    await user.click(within(ask).getByRole("button", { name: "Deshacer" }));
    const done = (await screen.findByText("Nómina deshecha")).closest(
      ".MuiAlert-root",
    ) as HTMLElement;
    expect(done).toHaveTextContent(/no se pudieron deshacer/);
    await user.click(
      within(done).getByRole("button", { name: /close|cerrar/i, hidden: true }),
    );
    await waitFor(() =>
      expect(screen.queryByText("Nómina deshecha")).not.toBeInTheDocument(),
    );
  }, 60000);
});
