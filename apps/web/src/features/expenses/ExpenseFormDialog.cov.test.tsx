// SPDX-License-Identifier: MIT
/**
 * The expense form on its own: every validation message, both kinds of
 * target travelling to the server, the crop inside a lot, and a refusal from
 * the server shown inside the dialog instead of closing it.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { ThemeProvider } from "@mui/material";
import { http, HttpResponse } from "msw";
import { ExpenseFormDialog } from "./ExpenseFormDialog";
import { AuthProvider } from "../../auth/AuthContext";
import { setTokens } from "../../api/client";
import { theme } from "../../theme";
import { server } from "../../mocks/node";
import { signInOwner } from "../../test/renderWithAuth";
import { todayInFarm } from "../../lib/dates";
import type { Activity, Expense, Plot } from "../../api/types";

const activities = [
  { id: "a1", name: "Fumigación", category: "Sanidad" },
  { id: "a2", name: "Varios", category: "" },
] as unknown as Activity[];

const plots = [
  {
    id: "p1",
    name: "La Loma",
    crops: [
      { id: "c1", cropTypeId: "t1", cropTypeName: "Café", varietyId: null, varietyName: null, areaHa: null, plantedAt: null },
      { id: "c2", cropTypeId: "t2", cropTypeName: "Plátano", varietyId: "v", varietyName: "Hartón", areaHa: null, plantedAt: null },
    ],
  },
  { id: "p2", name: "El Bajo", crops: [] },
] as unknown as Plot[];

function wire(body: Record<string, unknown>) {
  return {
    id: body.id,
    concept: body.concept,
    amountCents: body.amountCents,
    localDay: body.date ?? "2026-09-01",
    target: body.activityId ? "activity" : "plot",
    activityId: body.activityId ?? null,
    activity: null,
    plotId: body.plotId ?? null,
    plot: null,
    plotCropId: body.plotCropId ?? null,
    crop: null,
    note: body.note ?? null,
    deletedAt: null,
  };
}

function renderDialog(expense: Expense | null = null) {
  const onSaved = vi.fn();
  const onClose = vi.fn();
  render(
    <ThemeProvider theme={theme}>
      <MemoryRouter>
        <AuthProvider>
          <ExpenseFormDialog
            open
            expense={expense}
            activities={activities}
            plots={plots}
            onClose={onClose}
            onSaved={onSaved}
          />
        </AuthProvider>
      </MemoryRouter>
    </ThemeProvider>,
  );
  return { onSaved, onClose };
}

async function pick(user: ReturnType<typeof userEvent.setup>, label: string, option: string) {
  await user.click(screen.getByRole("combobox", { name: new RegExp(label) }));
  await user.click(await screen.findByRole("option", { name: option }));
}

beforeEach(() => {
  signInOwner();
});

describe("ExpenseFormDialog", () => {
  it("asks for every missing field, then for a real number, then for more than zero", async () => {
    const user = userEvent.setup();
    renderDialog();
    const save = screen.getByRole("button", { name: "Guardar gasto" });
    await user.click(save);
    expect(screen.getByText("Escriba en qué se gastó.")).toBeInTheDocument();
    expect(screen.getByText("Escriba el valor.")).toBeInTheDocument();
    expect(screen.getByText("Elija a qué actividad se carga este gasto.")).toBeInTheDocument();

    await user.type(screen.getByLabelText(/Valor/), "abc");
    await user.click(save);
    expect(screen.getByText("Escriba un número, por ejemplo 250.000.")).toBeInTheDocument();

    await user.clear(screen.getByLabelText(/Valor/));
    await user.type(screen.getByLabelText(/Valor/), "0");
    await user.click(save);
    expect(screen.getByText("Tiene que ser mayor que cero.")).toBeInTheDocument();

    await user.click(screen.getByRole("radio", { name: "Lote / cultivo" }));
    await user.click(save);
    expect(screen.getByText("Elija a qué lote se carga este gasto.")).toBeInTheDocument();
  }, 20000);

  it("charges a new expense to an activity, with its note", async () => {
    const user = userEvent.setup();
    let sent: Record<string, unknown> | null = null;
    server.use(
      http.post("*/v1/expenses", async ({ request }) => {
        sent = (await request.json()) as Record<string, unknown>;
        return HttpResponse.json(wire(sent));
      }),
    );
    const { onSaved } = renderDialog();
    await user.type(screen.getByLabelText(/En qué se gastó/), "  Fungicida ");
    await user.type(screen.getByLabelText(/Valor/), "250.000");
    // An activity with no category reads as just its name.
    await user.click(screen.getByRole("combobox", { name: /Actividad/ }));
    expect(await screen.findByRole("option", { name: "Varios" })).toBeInTheDocument();
    await user.click(screen.getByRole("option", { name: "Fumigación · Sanidad" }));
    await user.type(screen.getByLabelText("Nota (opcional)"), " para la roya ");
    await user.click(screen.getByRole("button", { name: "Guardar gasto" }));
    await waitFor(() => expect(onSaved).toHaveBeenCalled());
    expect(sent).toMatchObject({
      concept: "Fungicida",
      amountCents: 25_000_000,
      activityId: "a1",
      note: "para la roya",
    });
    expect(sent).toMatchObject({ plotId: null });
  }, 20000);

  it("charges an edited expense to a crop inside a lot", async () => {
    const user = userEvent.setup();
    let sent: Record<string, unknown> | null = null;
    server.use(
      http.patch("*/v1/expenses/:id", async ({ request }) => {
        sent = (await request.json()) as Record<string, unknown>;
        return HttpResponse.json(wire({ ...sent, id: "e1" }));
      }),
    );
    const expense = {
      id: "e1",
      concept: "Cerca",
      amountCents: 12_550,
      date: "2026-09-01",
      target: "plot",
      activityId: null,
      activityName: null,
      plotId: "p2",
      plotName: "El Bajo",
      plotCropId: null,
      cropName: null,
      note: null,
      status: "active",
    } as unknown as Expense;
    const { onSaved } = renderDialog(expense);
    expect(screen.getByText("Modificar gasto")).toBeInTheDocument();
    await pick(user, "Lote", "La Loma");
    await user.click(screen.getByRole("combobox", { name: /Cultivo/ }));
    expect(await screen.findByRole("option", { name: "Café" })).toBeInTheDocument();
    await user.click(screen.getByRole("option", { name: "Plátano · Hartón" }));
    await user.click(screen.getByRole("button", { name: "Guardar gasto" }));
    await waitFor(() => expect(onSaved).toHaveBeenCalled());
    expect(sent).toMatchObject({ plotId: "p1", plotCropId: "c2", note: null });
  }, 20000);

  it("shows the server's refusal and stays open", async () => {
    const user = userEvent.setup();
    server.use(
      http.post("*/v1/expenses", () =>
        HttpResponse.json(
          { error: { code: "VALIDATION", message: "El valor es demasiado alto." } },
          { status: 422 },
        ),
      ),
    );
    const { onSaved } = renderDialog();
    await user.type(screen.getByLabelText(/En qué se gastó/), "Transporte");
    await user.type(screen.getByLabelText(/Valor/), "1000");
    await pick(user, "Actividad", "Fumigación · Sanidad");
    await user.click(screen.getByRole("button", { name: "Guardar gasto" }));
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("El valor es demasiado alto.");
    expect(onSaved).not.toHaveBeenCalled();
    expect(screen.getByRole("dialog")).toBeInTheDocument();
  }, 20000);

  it("dates a new expense today in Bogotá when nobody is signed in", () => {
    setTokens(null);
    renderDialog();
    const [y, m, d] = todayInFarm("America/Bogota").split("-");
    const field = screen.getByLabelText(/Fecha/) as HTMLInputElement;
    expect(field.value).toMatch(new RegExp(`${d}|${y}-${m}-${d}`));
  });
});
