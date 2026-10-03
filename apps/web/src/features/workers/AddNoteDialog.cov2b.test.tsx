// SPDX-License-Identifier: MIT
import { describe, expect, it, vi } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { server } from "../../mocks/node";
import { AddNoteDialog } from "./AddNoteDialog";
import { renderWithAuth, signInOwner } from "../../test/renderWithAuth";
import { setTokens } from "../../api/client";
import { FARM_ID, tenants } from "../../mocks/db";
import { todayInFarm } from "../../lib/dates";

const typed = (iso: string) => iso.split("-").reverse().join("/");

function firstWorkerId(): string {
  const worker = tenants.get(FARM_ID)?.workers[0];
  if (!worker) throw new Error("the seed has no workers");
  return worker.id;
}

describe("AddNoteDialog", () => {
  it("titles the dialog without a name, clears the field error on typing, and saves a note with no date", async () => {
    signInOwner();
    const onSaved = vi.fn();
    let sent: Record<string, unknown> | null = null;
    server.use(
      http.post("*/v1/workers/:id/notes", async ({ request }) => {
        sent = (await request.json()) as Record<string, unknown>;
        return HttpResponse.json(
          { id: sent.id, workerId: "w", text: sent.text, date: "2026-08-28T00:00:00Z", createdBy: null, createdAt: "2026-08-28T10:00:00Z" },
          { status: 201 },
        );
      }),
    );
    renderWithAuth(
      <AddNoteDialog open workerId={firstWorkerId()} onClose={() => {}} onSaved={onSaved} />,
    );
    const user = userEvent.setup();
    expect(await screen.findByRole("heading", { name: "Agregar anotación" })).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Guardar anotación" }));
    expect(await screen.findByText("Escriba la anotación.")).toBeInTheDocument();
    await user.type(screen.getByLabelText("Anotación"), "Llegó tarde");
    expect(screen.queryByText("Escriba la anotación.")).not.toBeInTheDocument();

    await user.clear(screen.getByLabelText("Fecha"));
    await user.click(screen.getByRole("button", { name: "Guardar anotación" }));
    await waitFor(() => expect(onSaved).toHaveBeenCalled());
    expect(sent).not.toBeNull();
    expect(sent!.text).toBe("Llegó tarde");
    expect(sent!.date).toBeUndefined();
  });

  it("starts on today in Bogotá when nobody is signed in", async () => {
    setTokens(null);
    renderWithAuth(
      <AddNoteDialog open workerId="w1" workerName="María" onClose={() => {}} onSaved={() => {}} />,
    );
    expect(await screen.findByRole("heading", { name: "Agregar anotación · María" })).toBeInTheDocument();
    expect(screen.getByLabelText("Fecha")).toHaveValue(typed(todayInFarm("America/Bogota")));
  });
});
