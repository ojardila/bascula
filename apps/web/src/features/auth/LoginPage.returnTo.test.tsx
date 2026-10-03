// SPDX-License-Identifier: MIT
/**
 * After signing in, the person goes back to the page they were headed to
 * (router `state.from`) — with a password or a passkey — and only if it is a
 * page of this app. Anything else falls back to the role's home.
 *
 * The bug these pin: `navigate(from)` runs in a transition, and the same
 * render flipped the page to `<Navigate to={landing}>`, which won. Everybody
 * landed on /cosecha.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, useLocation } from "react-router-dom";
import { ThemeProvider } from "@mui/material";
import { App } from "../../App";
import { AuthProvider } from "../../auth/AuthContext";
import { setTokens } from "../../api/client";
import { invalidateRefs } from "../../api/refs";
import { theme } from "../../theme";
import { passkeys, resetDb, users } from "../../mocks/db";

vi.setConfig({ testTimeout: 30_000 });

function Where() {
  return <div data-testid="where">{useLocation().pathname}</div>;
}
const path = () => screen.getByTestId("where").textContent;

function renderLogin(from?: unknown) {
  return render(
    <ThemeProvider theme={theme}>
      <MemoryRouter initialEntries={[{ pathname: "/entrar", state: from === undefined ? undefined : { from } }]}>
        <AuthProvider>
          <App />
          <Where />
        </AuthProvider>
      </MemoryRouter>
    </ThemeProvider>,
  );
}

type User = ReturnType<typeof userEvent.setup>;

async function signIn(user: User) {
  await user.type(await screen.findByLabelText(/^Correo/), "oscar@laesperanza.co");
  await user.type(screen.getByLabelText(/^Contraseña/), "esperanza");
  await user.click(screen.getByRole("button", { name: "Entrar" }));
}

function stubAuthenticator(credentialId: string) {
  vi.stubGlobal("PublicKeyCredential", function PublicKeyCredential() {});
  vi.stubGlobal("navigator", {
    ...navigator,
    credentials: {
      get: vi.fn(async () => ({
        toJSON: () => ({ id: credentialId, type: "public-key", response: {} }),
      })),
      create: vi.fn(),
    },
  });
}

function givePasskey() {
  const oscar = users.find((u) => u.email === "oscar@laesperanza.co")!;
  passkeys.push({
    id: crypto.randomUUID(),
    userId: oscar.id,
    credentialId: "cred-oscar",
    name: "Mi celular",
    createdAt: new Date().toISOString(),
    lastUsedAt: null,
  });
}

beforeEach(() => {
  resetDb();
  setTokens(null);
  invalidateRefs();
  localStorage.clear();
  vi.stubGlobal("PublicKeyCredential", undefined);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("after a password", () => {
  it("goes to the page the person was trying to open", async () => {
    const user = userEvent.setup();
    renderLogin("/configuracion");
    await signIn(user);
    expect(await screen.findByRole("heading", { name: "Configuración", level: 1 })).toBeInTheDocument();
    expect(path()).toBe("/configuracion");
  });

  it.each([
    "https://evil.example/configuracion",
    "//evil.example/configuracion",
    "/\\evil.example",
    "javascript:alert(1)",
    "/",
  ])("ignores %s and goes to the role's home", async (from) => {
    const user = userEvent.setup();
    renderLogin(from);
    await signIn(user);
    expect(await screen.findByRole("heading", { name: "Cosecha" })).toBeInTheDocument();
    expect(path()).toBe("/cosecha");
  });

  it("goes to the role's home when nobody asked for a page", async () => {
    const user = userEvent.setup();
    renderLogin();
    await signIn(user);
    expect(await screen.findByRole("heading", { name: "Cosecha" })).toBeInTheDocument();
  });
});

describe("after a passkey", () => {
  it("goes to the page the person was trying to open", async () => {
    givePasskey();
    stubAuthenticator("cred-oscar");
    const user = userEvent.setup();
    renderLogin("/configuracion");
    await user.click(await screen.findByRole("button", { name: /Entrar con llave de acceso/ }));
    expect(await screen.findByRole("heading", { name: "Configuración", level: 1 })).toBeInTheDocument();
    expect(path()).toBe("/configuracion");
  });

  it("ignores an external address", async () => {
    givePasskey();
    stubAuthenticator("cred-oscar");
    const user = userEvent.setup();
    renderLogin("https://evil.example/");
    await user.click(await screen.findByRole("button", { name: /Entrar con llave de acceso/ }));
    expect(await screen.findByRole("heading", { name: "Cosecha" })).toBeInTheDocument();
    expect(path()).toBe("/cosecha");
  });
});
