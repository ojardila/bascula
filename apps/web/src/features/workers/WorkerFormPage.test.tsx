/**
 * The one conflict with no automatic repair.
 *
 * `ux_employees_doc` is partial on `deleted_at IS NULL`, so registering
 * somebody whose document already belongs to a DEACTIVATED worker succeeds at
 * the database level and creates a second file for one person. From then on
 * the handset writes to one and the web to the other, the balance is split in
 * two, and nothing says so — `docs/sincronizacion.md` lists it as the one
 * conflict that cannot be repaired automatically.
 *
 * So `POST /v1/workers` answers 409 EMPLOYEE_EXISTS_DELETED with
 * `details.employeeId`, and what this file asserts is that the screen turns
 * that into a way FORWARD. A red box with no button is how the duplicate gets
 * created anyway, five seconds later, under a document number with a dot
 * moved.
 */
import { describe, expect, it, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { ThemeProvider } from "@mui/material";
import { WorkerFormPage } from "./WorkerFormPage";
import { AuthProvider } from "../../auth/AuthContext";
import { setTokens } from "../../api/client";
import { invalidateRefs } from "../../api/refs";
import { theme } from "../../theme";
import * as db from "../../mocks/db";

const OWNER = "0192f3a0-0001-7000-8000-000000000001";

function renderForm() {
  return render(
    <ThemeProvider theme={theme}>
      <MemoryRouter initialEntries={["/empleados/nuevo"]}>
        <AuthProvider>
          <Routes>
            <Route path="/empleados/nuevo" element={<WorkerFormPage />} />
            <Route path="/empleados/:id" element={<div>ficha del empleado</div>} />
          </Routes>
        </AuthProvider>
      </MemoryRouter>
    </ThemeProvider>,
  );
}

/** Takes a seeded worker off the payroll and hands back their document. */
function deactivateSomeone(): { id: string; docId: string; name: string } {
  const t = db.tenantOf(db.FARM_ID)!;
  const w = t.workers.find((x) => x.docId)!;
  w.deletedAt = new Date().toISOString();
  return { id: w.id, docId: w.docId!, name: `${w.name} ${w.lastName ?? ""}`.trim() };
}

async function fillAndSubmit(user: ReturnType<typeof userEvent.setup>, docId: string) {
  await user.type(screen.getByLabelText(/^Nombres/), "Otra");
  await user.type(screen.getByLabelText(/^Apellidos/), "Persona");
  await user.type(screen.getByLabelText(/^Número de identificación/), docId);
  // The form insists on a contact number before it will submit anything.
  await user.type(screen.getByLabelText(/^Teléfono/), "3001234567");
  await user.click(screen.getByRole("button", { name: /Guardar|Registrar/ }));
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

describe("una cédula que ya existe en alguien inactivo", () => {
  it("no deja al usuario atascado: ofrece reactivar, y dice por qué", async () => {
    const gone = deactivateSomeone();
    const user = userEvent.setup();
    renderForm();
    await fillAndSubmit(user, gone.docId);

    expect(
      await screen.findByText("Esa identificación ya existe en la finca"),
    ).toBeInTheDocument();
    // It names WHO, so the person can recognise them before deciding.
    expect(screen.getByText(new RegExp(gone.name))).toBeInTheDocument();
    // And it says what creating a second one would cost, which is the part
    // nobody would guess: the balance splits and nothing warns about it.
    expect(screen.getByText(/el saldo se parte en dos/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Reactivar" })).toBeInTheDocument();
  }, 20000);

  it("y reactivar lleva a la ficha de esa persona, sin crear una segunda", async () => {
    const gone = deactivateSomeone();
    const user = userEvent.setup();
    renderForm();
    await fillAndSubmit(user, gone.docId);
    await user.click(await screen.findByRole("button", { name: "Reactivar" }));

    expect(await screen.findByText("ficha del empleado")).toBeInTheDocument();

    // One file, back on the payroll — not two.
    const t = db.tenantOf(db.FARM_ID)!;
    const withThatDoc = t.workers.filter((w) => w.docId === gone.docId);
    expect(withThatDoc).toHaveLength(1);
    expect(withThatDoc[0].deletedAt).toBeNull();
  }, 20000);
});
