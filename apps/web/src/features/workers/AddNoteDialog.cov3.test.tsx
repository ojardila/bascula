// SPDX-License-Identifier: MIT
/**
 * AddNoteDialog's own check on the date. `DateField` only ever hands back a
 * real day or "", so the check is a second line: here the field is replaced
 * by one that breaks that promise, and the dialog must refuse to send the
 * note rather than post an impossible date.
 */
import { describe, expect, it, vi } from "vitest";
import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { server } from "../../mocks/node";
import { AddNoteDialog } from "./AddNoteDialog";
import { renderWithAuth, signInOwner } from "../../test/renderWithAuth";

vi.mock("../../components/DateField", () => ({
  DateField: ({ label, onChange }: { label: string; onChange: (v: string) => void }) => (
    <button type="button" onClick={() => onChange("2026-02-30")}>
      {label}: poner una fecha imposible
    </button>
  ),
}));

describe("AddNoteDialog with a broken date field", () => {
  it("says to check the date and sends nothing", async () => {
    signInOwner();
    const posted = vi.fn();
    server.use(
      http.post("*/v1/workers/:id/notes", () => {
        posted();
        return HttpResponse.json({}, { status: 500 });
      }),
    );
    const onSaved = vi.fn();
    renderWithAuth(
      <AddNoteDialog open workerId="w-c3w" onClose={() => {}} onSaved={onSaved} />,
    );
    const user = userEvent.setup();
    await user.type(await screen.findByLabelText("Anotación"), "Pidió permiso");
    await user.click(screen.getByRole("button", { name: /Fecha: poner una fecha imposible/ }));
    await user.click(screen.getByRole("button", { name: "Guardar anotación" }));

    expect(await screen.findByText("Revise la fecha.")).toBeInTheDocument();
    expect(posted).not.toHaveBeenCalled();
    expect(onSaved).not.toHaveBeenCalled();
  });
});
