// SPDX-License-Identifier: MIT
/**
 * «Corregir pesadas» on its own: what it says about a box that is not a
 * number, writing changes and removals, the server refusing, and a pesada
 * that arrives after the dialog opened.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ThemeProvider } from "@mui/material";
import { http, HttpResponse } from "msw";
import { setTokens } from "../../api/client";
import type { WorkRecord } from "../../api/types";
import { theme } from "../../theme";
import { server } from "../../mocks/node";
import * as db from "../../mocks/db";
import { CorregirPesadasDialog } from "./CorregirPesadasDialog";

const OWNER = "0192f3a0-0001-7000-8000-000000000001";

function record(id: string, quantity: number, plotNames: string[] = ["El Alto"]): WorkRecord {
  return {
    id,
    quantity,
    plotNames,
    settled: false,
    status: "active",
  } as unknown as WorkRecord;
}

function dialog(records: WorkRecord[], onClose = vi.fn(), onSaved = vi.fn()) {
  return (
    <ThemeProvider theme={theme}>
      <CorregirPesadasDialog
        open
        name="María Restrepo Ospina"
        dayLabel="lunes 28"
        records={records}
        onClose={onClose}
        onSaved={onSaved}
      />
    </ThemeProvider>
  );
}

beforeEach(() => {
  db.resetDb();
  const now = Date.now();
  setTokens({
    accessToken: `mock-access.${OWNER}.${db.FARM_ID}.${now}.${now + 900_000}`,
    refreshToken: `mock-refresh.${OWNER}`,
  });
});

describe("Corregir pesadas", () => {
  it("does not save while a box is not a number, even with a removal marked", async () => {
    const patched: string[] = [];
    server.use(
      http.patch("*/v1/work-records/:id", ({ params }) => {
        patched.push(String(params.id));
        return HttpResponse.json({});
      }),
    );
    const onSaved = vi.fn();
    const user = userEvent.setup();
    render(dialog([record("r1", 10), record("r2", 20, [])], vi.fn(), onSaved));
    // A pesada without a lote shows just its number.
    expect(screen.getByText("Pesada 2")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Quitar la pesada 1" }));
    expect(screen.getByText("Se quita · era 10 kg")).toBeInTheDocument();
    const box = screen.getByLabelText("Pesada 2, kilos");
    await user.clear(box);
    await user.type(box, "abc");
    await user.click(screen.getByRole("button", { name: "Guardar cambios" }));
    expect(
      await screen.findByText("Revise la pesada 2: «abc» no es un número."),
    ).toBeInTheDocument();
    expect(patched).toHaveLength(0);
    expect(onSaved).not.toHaveBeenCalled();

    // Typing clears the message.
    await user.clear(box);
    expect(screen.queryByText(/no es un número/)).not.toBeInTheDocument();
  });

  it("writes the change and the removal and says how many", async () => {
    const bodies: Record<string, unknown>[] = [];
    server.use(
      http.patch("*/v1/work-records/:id", async ({ request }) => {
        bodies.push((await request.json()) as Record<string, unknown>);
        return HttpResponse.json({});
      }),
    );
    const onSaved = vi.fn();
    const user = userEvent.setup();
    render(dialog([record("r1", 10), record("r2", 20)], vi.fn(), onSaved));
    await user.click(screen.getByRole("button", { name: "Quitar la pesada 1" }));
    // «Dejar» undoes it, and «Quitar» again marks it.
    await user.click(screen.getByRole("button", { name: "Dejar la pesada 1" }));
    expect(screen.getByLabelText("Pesada 1, kilos")).toHaveValue("10");
    await user.click(screen.getByRole("button", { name: "Quitar la pesada 1" }));
    const box = screen.getByLabelText("Pesada 2, kilos");
    await user.clear(box);
    await user.type(box, "25");
    await user.click(screen.getByRole("button", { name: "Guardar cambios" }));
    await waitFor(() => expect(onSaved).toHaveBeenCalledWith(2));
    expect(bodies).toHaveLength(2);
  });

  it("shows the server's refusal and lets the person try again", async () => {
    server.use(
      http.patch("*/v1/work-records/:id", () =>
        HttpResponse.json(
          { error: { code: "CONFLICT", message: "La semana ya está liquidada", details: {} } },
          { status: 409 },
        ),
      ),
    );
    const onSaved = vi.fn();
    const user = userEvent.setup();
    render(dialog([record("r1", 10)], vi.fn(), onSaved));
    await user.click(screen.getByRole("button", { name: "Quitar la pesada 1" }));
    await user.click(screen.getByRole("button", { name: "Guardar cambios" }));
    expect(await screen.findByRole("alert")).toBeInTheDocument();
    expect(onSaved).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Guardar cambios" })).toBeEnabled();
  });

  it("shows an empty box for a pesada that arrived after it opened", async () => {
    const onClose = vi.fn();
    const user = userEvent.setup();
    const view = render(dialog([record("r1", 10)], onClose));
    view.rerender(dialog([record("r1", 10), record("r9", 7)], onClose));
    expect(screen.getByLabelText("Pesada 2, kilos")).toHaveValue("");
    await user.click(screen.getByRole("button", { name: "Cancelar" }));
    expect(onClose).toHaveBeenCalled();
  });
});
