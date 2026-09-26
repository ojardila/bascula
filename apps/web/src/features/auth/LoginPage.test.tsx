import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { ThemeProvider } from "@mui/material";
import { App } from "../../App";
import { AuthProvider } from "../../auth/AuthContext";
import { setTokens } from "../../api/client";
import { invalidateRefs } from "../../api/refs";
import { theme } from "../../theme";
import { memberships, resetDb, users } from "../../mocks/db";

function renderApp(path = "/entrar") {
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

function stubHostname(hostname: string) {
  vi.stubGlobal("location", {
    hostname,
    host: hostname,
    origin: `https://${hostname}`,
    href: `https://${hostname}/entrar`,
    protocol: "https:",
    pathname: "/entrar",
    search: "",
    hash: "",
    assign: () => {},
    replace: () => {},
    reload: () => {},
  });
}

beforeEach(() => {
  resetDb();
  setTokens(null);
  invalidateRefs();
  localStorage.clear();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("registering a farm is not offered on a farm's address", () => {
  it("has no register button on a farm's login", async () => {
    stubHostname("cafin3.bascula.engp.io");
    renderApp();
    expect(await screen.findByRole("button", { name: "Entrar" })).toBeInTheDocument();
    expect(screen.queryByText(/Registrar|Crear.*finca/i)).toBeNull();
  });

  it("keeps it on the main domain", async () => {
    stubHostname("bascula.engp.io");
    renderApp();
    expect(await screen.findByRole("link", { name: "Registrar mi finca" })).toHaveAttribute("href", "/empezar");
  });

  it("sends /empezar and /registro on a farm back to the farm's front door", async () => {
    stubHostname("cafin3.bascula.engp.io");
    const { unmount } = renderApp("/empezar");
    expect(await screen.findByTestId("farm-entry")).toBeInTheDocument();
    expect(screen.queryByLabelText(/Nombre de la finca/)).toBeNull();
    unmount();
    renderApp("/registro");
    expect(await screen.findByTestId("farm-entry")).toBeInTheDocument();
    expect(screen.queryByText(/Registrar|Crear.*finca/i)).toBeNull();
  });
});

describe("login on a pinned host", () => {
  it("does not ask which farm when the hostname already names one", async () => {
    const oscar = users.find((u) => u.email === "oscar@laesperanza.co");
    if (!oscar) throw new Error("no oscar");
    memberships.push({
      farmId: "0192f3a0-0000-7000-8000-000000000002",
      userId: oscar.id,
      role: "owner",
    });
    stubHostname("la-esperanza.bascula.engp.io");

    const user = userEvent.setup();
    renderApp();
    await user.type(screen.getByLabelText(/^Correo/), "oscar@laesperanza.co");
    await user.type(screen.getByLabelText(/^Contraseña/), "esperanza");
    await user.click(screen.getByRole("button", { name: "Entrar" }));

    expect(await screen.findByRole("heading", { name: "Cosecha" }, { timeout: 5000 }))
      .toBeInTheDocument();
    expect(screen.queryByText("¿A cuál finca entra?")).not.toBeInTheDocument();
  }, 20000);

  it("says so when the account does not belong to the pinned farm", async () => {
    stubHostname("el-mirador.bascula.engp.io");

    const user = userEvent.setup();
    renderApp();
    await user.type(screen.getByLabelText(/^Correo/), "oscar@laesperanza.co");
    await user.type(screen.getByLabelText(/^Contraseña/), "esperanza");
    await user.click(screen.getByRole("button", { name: "Entrar" }));

    expect(await screen.findByText(/no tiene permiso/i)).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Cosecha" })).not.toBeInTheDocument();
  }, 20000);
});
