// SPDX-License-Identifier: MIT
/**
 * «Labores»: the list of every labor, what it shows to who may and may not
 * read money, what happens when the server refuses, and the «Dar de baja»
 * path — including the 409 of a settled record.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { Route, Routes } from "react-router-dom";
import { WorkRecordsPage } from "./WorkRecordsPage";
import { renderWithAuth, signInOwner } from "../../test/renderWithAuth";
import { server } from "../../mocks/node";
import { api } from "../../api/endpoints";
import { invalidateRefs } from "../../api/refs";
import type { WorkRecord } from "../../api/types";

vi.setConfig({ testTimeout: 30_000 });

const WEIGHER = "0192f3a0-0001-7000-8000-000000000003";

function renderPage() {
  return renderWithAuth(
    <Routes>
      <Route path="/labores" element={<WorkRecordsPage />} />
      <Route path="/labores/nueva" element={<div>formulario de labor</div>} />
      <Route
        path="/cosecha/recoleccion"
        element={<div>formulario de recolección</div>}
      />
    </Routes>,
    { path: "/labores" },
  );
}

function record(over: Partial<WorkRecord>): WorkRecord {
  return {
    id: "wr-1",
    workerId: "w-1",
    workerName: "María Restrepo",
    activityId: "a-1",
    activityName: "Guadañada",
    category: "labor",
    payMode: "day",
    unitLabel: "jornal",
    plotIds: ["p-1"],
    plotNames: ["El Alto"],
    plotCropIds: ["pc-1"],
    plotCropNames: ["El Alto · Café"],
    dateFrom: "2026-09-28",
    dateTo: "2026-09-28",
    quantity: 2,
    rateCents: 6_000_000,
    estimatedAmountCents: 12_000_000,
    amountIsEstimate: false,
    note: null,
    settled: false,
    status: "active",
    ...over,
  } as WorkRecord;
}

beforeEach(() => {
  signInOwner();
  invalidateRefs();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("WorkRecordsPage", () => {
  it("lists contract, unit-less and settled labors with the pending total", async () => {
    vi.spyOn(api, "listWorkRecords").mockResolvedValue([
      record({ id: "wr-1", payMode: "contract", activityName: "Plateo" }),
      record({
        id: "wr-2",
        activityName: "Fumigada",
        unitLabel: null,
        quantity: 3,
      }),
      record({ id: "wr-3", activityName: "Desyerba", settled: true }),
    ]);
    renderPage();

    expect(await screen.findByText("Plateo")).toBeInTheDocument();
    expect(screen.getAllByText("contrato").length).toBeGreaterThan(0);
    expect(screen.getAllByText(/^3\s*$/).length).toBeGreaterThan(0);
    expect(screen.getAllByText("liquidada").length).toBeGreaterThan(0);
    expect(screen.getAllByText("pendiente").length).toBeGreaterThan(0);
    expect(screen.getByText(/2 pendientes de liquidar/)).toBeInTheDocument();
    expect(screen.getByRole("columnheader", { name: "Valor" })).toBeInTheDocument();
  });

  it("opens the harvest form and the single-labor form", async () => {
    const user = userEvent.setup();
    renderPage();
    await user.click(
      await screen.findByRole("button", { name: "Una labor" }),
    );
    expect(await screen.findByText("formulario de labor")).toBeInTheDocument();
  });

  it("opens the harvest form from «Registrar recolección»", async () => {
    const user = userEvent.setup();
    renderPage();
    await user.click(
      await screen.findByRole("button", { name: "Registrar recolección" }),
    );
    expect(
      await screen.findByText("formulario de recolección"),
    ).toBeInTheDocument();
  });

  it("searches and switches to the inactive labors", async () => {
    const spy = vi.spyOn(api, "listWorkRecords");
    const user = userEvent.setup();
    renderPage();
    await screen.findByRole("heading", { name: "Labores" });
    await user.type(
      screen.getByLabelText("Buscar por actividad, empleado o lote"),
      "x",
    );
    await waitFor(() =>
      expect(spy).toHaveBeenLastCalledWith({ status: "active", q: "x" }),
    );
    await user.click(screen.getByRole("button", { name: "Inactivas" }));
    await waitFor(() =>
      expect(spy).toHaveBeenLastCalledWith({ status: "inactive", q: "x" }),
    );
  });

  it("deactivates a labor and reloads the list", async () => {
    const off = vi
      .spyOn(api, "deactivateWorkRecord")
      .mockResolvedValue(record({ id: "wr-9", status: "inactive" }));
    vi.spyOn(api, "listWorkRecords").mockResolvedValue([
      record({ id: "wr-9", activityName: "Plateo" }),
    ]);
    const user = userEvent.setup();
    renderPage();
    await user.click(
      await screen.findByRole("button", {
        name: "Acciones de Plateo de María Restrepo",
      }),
    );
    await user.click(await screen.findByRole("menuitem", { name: "Dar de baja" }));
    const dialog = await screen.findByRole("dialog");
    await user.click(within(dialog).getByRole("button", { name: "Dar de baja" }));
    await waitFor(() => expect(off).toHaveBeenCalledWith("wr-9"));
    await waitFor(() =>
      expect(api.listWorkRecords).toHaveBeenCalledTimes(2),
    );
  });

  it("says why a settled labor cannot be deactivated, and the alert closes", async () => {
    server.use(
      http.patch("*/v1/work-records/:id", () =>
        HttpResponse.json(
          {
            error: {
              code: "WORK_RECORD_SETTLED",
              message: "the work record is part of a live settlement",
            },
          },
          { status: 409 },
        ),
      ),
    );
    vi.spyOn(api, "listWorkRecords").mockResolvedValue([
      record({ id: "wr-9", activityName: "Plateo" }),
    ]);
    const user = userEvent.setup();
    renderPage();
    await user.click(
      await screen.findByRole("button", {
        name: "Acciones de Plateo de María Restrepo",
      }),
    );
    await user.click(await screen.findByRole("menuitem", { name: "Dar de baja" }));
    const dialog = await screen.findByRole("dialog");
    await user.click(within(dialog).getByRole("button", { name: "Dar de baja" }));
    const alert = await screen.findByRole("alert");
    expect(alert).not.toHaveTextContent(/^$/);
    await user.click(within(alert).getByRole("button", { name: /close|cerrar/i }));
    await waitFor(() =>
      expect(screen.queryByRole("alert")).not.toBeInTheDocument(),
    );
  });

  it("shows the server's error when the list fails", async () => {
    server.use(
      http.get("*/v1/work-records", () =>
        HttpResponse.json(
          { error: { code: "INTERNAL", message: "boom" } },
          { status: 500 },
        ),
      ),
    );
    renderPage();
    expect(await screen.findByRole("alert")).toBeInTheDocument();
    expect(screen.queryByText(/pendientes de liquidar/)).not.toBeInTheDocument();
  });

  it("tells a user without permission that they cannot see the labors", async () => {
    server.use(
      http.get("*/v1/work-records", () =>
        HttpResponse.json(
          { error: { code: "FORBIDDEN", message: "no" } },
          { status: 403 },
        ),
      ),
    );
    renderPage();
    expect(await screen.findByText(/ver las labores/)).toBeInTheDocument();
  });

  it("hides money and «Dar de baja» from the weigher", async () => {
    signInOwner(WEIGHER);
    vi.spyOn(api, "listWorkRecords").mockResolvedValue([
      record({ id: "wr-1", activityName: "Plateo", estimatedAmountCents: null }),
    ]);
    const user = userEvent.setup();
    renderPage();
    expect(await screen.findByText("Plateo")).toBeInTheDocument();
    expect(
      screen.queryByRole("columnheader", { name: "Valor" }),
    ).not.toBeInTheDocument();
    expect(screen.queryByText(/pendientes de liquidar/)).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Una labor" })).toBeInTheDocument();
    const actions = screen.queryByRole("button", {
      name: "Acciones de Plateo de María Restrepo",
    });
    if (actions) {
      await user.click(actions);
      expect(
        screen.queryByRole("menuitem", { name: "Dar de baja" }),
      ).not.toBeInTheDocument();
    }
  });

  it("offers no create buttons to a role that cannot write", async () => {
    server.use(
      http.get("*/v1/me", () =>
        HttpResponse.json({
          id: "0192f3a0-0001-7000-8000-000000000001",
          email: "oscar@laesperanza.co",
          name: "Oscar Jaramillo",
          role: "viewer",
          farm: {
            id: "f",
            name: "La Esperanza",
            timezone: "America/Bogota",
            currency: "COP",
            slug: "la-esperanza",
          },
          superadmin: false,
        }),
      ),
    );
    vi.spyOn(api, "listWorkRecords").mockResolvedValue([
      record({ id: "wr-1", activityName: "Plateo" }),
    ]);
    renderPage();
    expect(await screen.findByText("Plateo")).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Una labor" }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Registrar recolección" }),
    ).not.toBeInTheDocument();
  });
});
