/**
 * The matrix is a table; this checks the app actually obeys it.
 *
 * A unit test on `can()` proves the rule. It does not prove that a screen
 * calls it, that the sidebar filters on it, or that walking straight to a URL
 * is stopped. Those are the three ways a permission leaks in a React app, so
 * they get rendered, not asserted about.
 *
 * It runs against the same MSW handlers the browser uses, which enforce the
 * matrix server-side too — so a test can only pass if both halves agree.
 */
import { describe, expect, it, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { ThemeProvider } from "@mui/material";
import { App } from "../App";
import { AuthProvider } from "../auth/AuthContext";
import { setTokens } from "../api/client";
import { theme } from "../theme";
import { users } from "../mocks/db";

function signInAs(email: string) {
  const user = users.find((u) => u.email === email);
  if (!user) throw new Error(`no seeded user ${email}`);
  setTokens({
    accessToken: `mock-access.${user.id}.test`,
    refreshToken: `mock-refresh.${user.id}`,
  });
}

function renderApp(path: string) {
  return render(
    <ThemeProvider theme={theme}>
      <MemoryRouter initialEntries={[path]}>
        <AuthProvider>
          <App />
        </AuthProvider>
      </MemoryRouter>
    </ThemeProvider>,
  );
}

/**
 * The sidebar is a <nav>. Its entries are links when they are reachable and
 * plain divs when a later sprint owns them, so this reads the rendered text
 * rather than a role — what is being asserted is what a person can see.
 */
async function sidebarText(): Promise<string> {
  const nav = await screen.findByRole("navigation");
  return nav.textContent ?? "";
}

beforeEach(() => {
  setTokens(null);
  localStorage.clear();
});

describe("the sidebar shows only what the role can open", () => {
  it("gives the owner the full sprint-1 set", async () => {
    signInAs("oscar@laesperanza.co");
    renderApp("/tablero");
    const text = await sidebarText();
    for (const m of ["Tablero", "Parcelas", "Empleados", "Actividades", "Labores", "Configuración"]) {
      expect(text).toContain(m);
    }
  });

  it("hides the tablero, the money and the settings from the weigher", async () => {
    signInAs("pesador@laesperanza.co");
    renderApp("/labores");
    const text = await sidebarText();
    expect(text).toContain("Labores");
    expect(text).not.toContain("Tablero");
    expect(text).not.toContain("Configuración");
    expect(text).not.toContain("Liquidación");
    expect(text).not.toContain("Ventas");
    expect(text).not.toContain("Gastos");
  });
});

describe("typing the URL by hand does not get you in", () => {
  it("stops a weigher at an employee's profile and says why", async () => {
    // Hiding the sidebar entry is cosmetic; this is the part that matters.
    signInAs("pesador@laesperanza.co");
    renderApp("/empleados/0192f3a0-0006-7000-8000-000000000001");
    expect(await screen.findByText(/No tiene permiso/i)).toBeInTheDocument();
    expect(screen.getByText(/pídaselo al dueño/i)).toBeInTheDocument();
  });

  it("lets a weigher see the list of names but not the money column", async () => {
    // The weigher does get a list of people — they have to pick one to
    // register a pickup against. What they do not get is the payroll.
    signInAs("pesador@laesperanza.co");
    renderApp("/empleados");
    expect(await screen.findByRole("heading", { name: "Empleados" })).toBeInTheDocument();
    await screen.findByText(/María/);
    expect(screen.queryByText("SALDO")).not.toBeInTheDocument();
    expect(screen.queryByRole("columnheader", { name: /saldo/i })).not.toBeInTheDocument();
    expect(screen.queryByText(/1045882331/)).not.toBeInTheDocument();
  });

  it("stops a weigher at a worker's payment screen", async () => {
    signInAs("pesador@laesperanza.co");
    renderApp("/empleados/0192f3a0-0006-7000-8000-000000000001/pagar");
    expect(await screen.findByText(/No tiene permiso/i)).toBeInTheDocument();
  });

  it("keeps an administrator out of the super-admin console", async () => {
    signInAs("admin@laesperanza.co");
    renderApp("/admin/fincas");
    await waitFor(() => {
      expect(screen.queryByText(/Consola de soporte/i)).not.toBeInTheDocument();
    });
  });

  /**
   * ── LA PLATA SE LE ESCAPABA POR UNA SOLA PUERTA ────────────────────────
   *
   * `parcelas/:id` was the one route of thirty-five with no `RequirePermission`
   * around it, and `PlotDetailPage` printed the amount of every labor on the
   * lot without the `money.read` guard that `WorkRecordsPage` puts on the same
   * column. So `/labores` showed the weigher no money and `/parcelas/<id>`
   * showed him "Recoleccion · Ana Ramírez · $32.000".
   *
   * That is not one number leaking. The row also carries the kilos, and
   * $32.000 over 40 kg is $800 a kilo — which is precisely the figure the
   * server strips out of `/v1/farm` and `/v1/activities` for this role. The
   * server's projection was right and one division on this side undid it.
   */
  it("no le enseña al pesador la plata en el detalle de una parcela", async () => {
    signInAs("pesador@laesperanza.co");
    renderApp("/parcelas/0192f3a0-0004-7000-8000-000000000001");

    // He does get in — a weigher may look at the lot he is standing in — and
    // he does see his own labores, which is the point of the screen for him.
    await screen.findByRole("heading", { name: "El Alto" });
    await screen.findByText("Últimas labores");
    await screen.findAllByText(/Recolección/);

    // What he must not see is a peso. `$` covers every money control on the
    // screen at once, which is what makes this assertion worth having: a new
    // figure added to this page later cannot slip past it.
    const money = screen.queryAllByText(/\$\s?\d/);
    expect(money.map((n) => n.textContent)).toEqual([]);
  });

  /** …and the same screen still shows the money to somebody entitled to it,
   *  so the guard cannot be "passing" by hiding the column from everybody. */
  it("y al dueño sí, en la misma pantalla", async () => {
    signInAs("oscar@laesperanza.co");
    renderApp("/parcelas/0192f3a0-0004-7000-8000-000000000001");
    await screen.findByText("Últimas labores");
    await waitFor(() => {
      expect(screen.queryAllByText(/\$\s?\d/).length).toBeGreaterThan(0);
    });
  });

  it("lets a weigher into the one screen they are for", async () => {
    signInAs("pesador@laesperanza.co");
    renderApp("/labores");
    expect(await screen.findByRole("heading", { name: "Labores" })).toBeInTheDocument();
  });
});

describe("anonymous", () => {
  it("is sent to the login instead of the shell", async () => {
    renderApp("/empleados");
    expect(await screen.findByRole("heading", { name: "Entrar" })).toBeInTheDocument();
  });
});

describe("the server enforces it too, not just the UI", () => {
  it("does not send the weigher a worker's document or balance", async () => {
    // The weigher's projection is a different response, not the same one with
    // fields hidden in CSS: `arquitectura-api.md` §6.
    signInAs("pesador@laesperanza.co");
    renderApp("/labores");
    await screen.findByRole("heading", { name: "Labores" });

    const res = await fetch("/v1/workers", {
      headers: {
        Authorization: `Bearer mock-access.${users.find((u) => u.role === "weigher")!.id}.test`,
      },
    });
    // Every list route answers `{items: [...]}`. There is no bare array and no
    // `total` anywhere in routes.go.
    const body = (await res.json()) as { items: Array<Record<string, unknown>> };
    expect(body.items.length).toBeGreaterThan(0);
    for (const row of body.items) {
      // `docId` is the server's name for the document number, and the
      // weigher's projection is exactly {id, name, lastName, tag} — a
      // different response, not the same one with fields hidden in CSS.
      expect(row.docId).toBeUndefined();
      expect(row.documentType).toBeUndefined();
      expect(row.phone).toBeUndefined();
      expect(row.photoId).toBeUndefined();
    }
  });

  it("answers 403 when a weigher asks for a profile", async () => {
    const res = await fetch("/v1/workers/0192f3a0-0006-7000-8000-000000000001/profile", {
      headers: {
        Authorization: `Bearer mock-access.${users.find((u) => u.role === "weigher")!.id}.test`,
      },
    });
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: { code: string } };
    // FORBIDDEN, from internal/domain/errors.go. Sprint 1 asserted
    // PERMISSION_DENIED, which the server has never sent — the mock invented
    // it, and the assertion confirmed the invention.
    expect(body.error.code).toBe("FORBIDDEN");
  });
});
