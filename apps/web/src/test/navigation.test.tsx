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
    const rows = (await res.json()) as Array<Record<string, unknown>>;
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      expect(row.documentNumber).toBeUndefined();
      expect(row.phone).toBeUndefined();
      expect(row.balanceCents).toBeUndefined();
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
    expect(body.error.code).toBe("PERMISSION_DENIED");
  });
});
