/**
 * The login page, the paths `LoginPage.test.tsx` leaves out: choosing a farm
 * after a password and going back, a passkey that does not open this farm,
 * showing the password, and the
 * test accounts offered when the console runs on mocks.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { ThemeProvider } from "@mui/material";
import { http, HttpResponse } from "msw";
import { App } from "../../App";
import { AuthProvider } from "../../auth/AuthContext";
import { setTokens } from "../../api/client";
import { invalidateRefs } from "../../api/refs";
import { theme } from "../../theme";
import { server } from "../../mocks/node";
import { memberships, passkeys, resetDb, users } from "../../mocks/db";

function renderApp(entry = "/entrar") {
  return render(
    <ThemeProvider theme={theme}>
      <MemoryRouter initialEntries={[entry]}>
        <AuthProvider>
          <App />
        </AuthProvider>
      </MemoryRouter>
    </ThemeProvider>,
  );
}

async function typeCredentials(user: ReturnType<typeof userEvent.setup>) {
  await user.type(
    await screen.findByLabelText(/^Correo/),
    "oscar@laesperanza.co",
  );
  await user.type(screen.getByLabelText(/^Contraseña/), "esperanza");
}

function secondFarmForOscar() {
  const oscar = users.find((u) => u.email === "oscar@laesperanza.co")!;
  memberships.push({
    farmId: "0192f3a0-0000-7000-8000-000000000002",
    userId: oscar.id,
    role: "owner",
  });
  return oscar;
}

beforeEach(() => {
  resetDb();
  setTokens(null);
  invalidateRefs();
  localStorage.clear();
  // No passkeys here unless a test says so, so nothing is offered after login.
  vi.stubGlobal("PublicKeyCredential", undefined);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("choosing a farm after the password", () => {
  it("lists the farms and can go back to the form", async () => {
    secondFarmForOscar();
    const user = userEvent.setup();
    renderApp();
    await typeCredentials(user);
    await user.click(screen.getByRole("button", { name: "Entrar" }));
    expect(await screen.findByText("¿A cuál finca entra?")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Volver" }));
    expect(
      await screen.findByRole("button", { name: "Entrar" }),
    ).toBeInTheDocument();
  }, 20000);

  it("enters the farm that was picked", async () => {
    secondFarmForOscar();
    const user = userEvent.setup();
    renderApp();
    await typeCredentials(user);
    await user.click(screen.getByRole("button", { name: "Entrar" }));
    await screen.findByText("¿A cuál finca entra?");
    await user.click(screen.getAllByRole("button", { name: /Dueño/ })[0]);
    expect(
      await screen.findByRole(
        "heading",
        { name: "Cosecha" },
        { timeout: 5000 },
      ),
    ).toBeInTheDocument();
  }, 20000);
});

describe("after signing in", () => {
  it("says so when the password is wrong", async () => {
    const user = userEvent.setup();
    renderApp();
    await user.type(
      await screen.findByLabelText(/^Correo/),
      "oscar@laesperanza.co",
    );
    await user.type(screen.getByLabelText(/^Contraseña/), "otra-cosa");
    await user.click(screen.getByRole("button", { name: "Entrar" }));
    expect(await screen.findByRole("alert")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Entrar" })).toBeInTheDocument();
  }, 20000);
});

describe("the password field", () => {
  it("can show and hide what was typed", async () => {
    const user = userEvent.setup();
    renderApp();
    const field = await screen.findByLabelText(/^Contraseña/);
    expect(field).toHaveAttribute("type", "password");
    await user.click(screen.getByRole("button", { name: "Ver contraseña" }));
    expect(field).toHaveAttribute("type", "text");
    await user.click(
      screen.getByRole("button", { name: "Ocultar contraseña" }),
    );
    expect(field).toHaveAttribute("type", "password");
  });
});

describe("a passkey that does not open this farm", () => {
  it("points back to the password", async () => {
    const oscar = users.find((u) => u.email === "oscar@laesperanza.co")!;
    passkeys.push({
      id: crypto.randomUUID(),
      userId: oscar.id,
      credentialId: "cred-oscar",
      name: "Mi celular",
      createdAt: new Date().toISOString(),
      lastUsedAt: null,
    });
    vi.stubGlobal("PublicKeyCredential", function PublicKeyCredential() {});
    vi.stubGlobal("navigator", {
      ...navigator,
      credentials: {
        get: vi.fn(async () => ({
          toJSON: () => ({
            id: "cred-oscar",
            type: "public-key",
            response: {},
          }),
        })),
        create: vi.fn(),
      },
    });
    server.use(
      http.post("*/v1/auth/passkeys/login", () =>
        HttpResponse.json(
          { error: { code: "FORBIDDEN", message: "no" } },
          { status: 403 },
        ),
      ),
    );
    const user = userEvent.setup();
    renderApp();
    await user.click(
      await screen.findByRole("button", { name: /Entrar con llave de acceso/ }),
    );
    expect(
      await screen.findByText(/Esa llave de acceso no abre esta finca/),
    ).toBeInTheDocument();
  }, 20000);

  it("shows any other failure as it is", async () => {
    vi.stubGlobal("PublicKeyCredential", function PublicKeyCredential() {});
    vi.stubGlobal("navigator", {
      ...navigator,
      credentials: {
        get: vi.fn(async () => ({
          toJSON: () => ({ id: "cred-x", type: "public-key", response: {} }),
        })),
        create: vi.fn(),
      },
    });
    server.use(
      http.post("*/v1/auth/passkeys/login", () =>
        HttpResponse.json(
          { error: { code: "INTERNAL", message: "Falló el servidor" } },
          { status: 500 },
        ),
      ),
    );
    const user = userEvent.setup();
    renderApp();
    await user.click(
      await screen.findByRole("button", { name: /Entrar con llave de acceso/ }),
    );
    expect(await screen.findByRole("alert")).toBeInTheDocument();
    expect(
      screen.queryByText(/Esa llave de acceso no abre/),
    ).not.toBeInTheDocument();
  }, 20000);
});

describe("on mocks", () => {
  it("offers the test accounts, which fill the form", async () => {
    vi.stubEnv("VITE_USE_MOCKS", "true");
    const user = userEvent.setup();
    renderApp();
    expect(await screen.findByText("Datos de prueba")).toBeInTheDocument();
    await user.click(
      screen.getByRole("button", { name: "admin@laesperanza.co" }),
    );
    expect(screen.getByLabelText(/^Correo/)).toHaveValue(
      "admin@laesperanza.co",
    );
    expect(screen.getByLabelText(/^Contraseña/)).toHaveValue("esperanza");
    await user.click(screen.getByRole("button", { name: "super@bascula.co" }));
    expect(screen.getByLabelText(/^Correo/)).toHaveValue("super@bascula.co");
    expect(screen.getByLabelText(/^Contraseña/)).toHaveValue("bascula");
  });
});
