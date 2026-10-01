/**
 * «Llaves de acceso»: add a passkey with the phone, see it listed, remove it.
 * The browser's WebAuthn is stubbed; the mock API stores what it is sent.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { ThemeProvider } from "@mui/material";
import { PasskeysCard } from "./PasskeysCard";
import { AuthProvider } from "../../auth/AuthContext";
import { setTokens } from "../../api/client";
import { invalidateRefs } from "../../api/refs";
import { theme } from "../../theme";
import * as db from "../../mocks/db";

const OWNER = "0192f3a0-0001-7000-8000-000000000001";

function renderCard() {
  return render(
    <ThemeProvider theme={theme}>
      <MemoryRouter>
        <AuthProvider>
          <PasskeysCard />
        </AuthProvider>
      </MemoryRouter>
    </ThemeProvider>,
  );
}

function stubAuthenticator(create: () => Promise<unknown>) {
  vi.stubGlobal("PublicKeyCredential", function PublicKeyCredential() {});
  vi.stubGlobal("navigator", { ...navigator, credentials: { create, get: vi.fn() } });
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

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("Llaves de acceso", () => {
  it("adds a passkey with the name given, then removes it", async () => {
    stubAuthenticator(async () => ({ toJSON: () => ({ id: "cred-1", type: "public-key", response: {} }) }));
    const user = userEvent.setup();
    renderCard();

    expect(await screen.findByText("Todavía no tiene llaves de acceso.")).toBeInTheDocument();
    await user.type(screen.getByLabelText(/Nombre/), "Mi celular");
    await user.click(screen.getByRole("button", { name: /Agregar llave de acceso/ }));

    expect(await screen.findByText("Llave de acceso guardada.")).toBeInTheDocument();
    expect(await screen.findByText("Mi celular")).toBeInTheDocument();
    expect(db.passkeys).toHaveLength(1);
    expect(db.passkeys[0]).toMatchObject({ userId: OWNER, credentialId: "cred-1", name: "Mi celular" });

    await user.click(screen.getByRole("button", { name: "Quitar Mi celular" }));
    const dialog = await screen.findByRole("dialog");
    await user.click(within(dialog).getByRole("button", { name: "Quitar" }));
    await waitFor(() => expect(db.passkeys).toHaveLength(0));
    expect(await screen.findByText("Todavía no tiene llaves de acceso.")).toBeInTheDocument();
  });

  it("says nothing when the person closes the prompt", async () => {
    stubAuthenticator(async () => {
      throw new DOMException("closed", "NotAllowedError");
    });
    const user = userEvent.setup();
    renderCard();
    await screen.findByText("Todavía no tiene llaves de acceso.");
    await user.click(screen.getByRole("button", { name: /Agregar llave de acceso/ }));
    await waitFor(() =>
      expect(screen.getByRole("button", { name: /Agregar llave de acceso/ })).toBeEnabled(),
    );
    expect(screen.queryByRole("alert")).toBeNull();
    expect(db.passkeys).toHaveLength(0);
  });

  it("explains a passkey this device already has", async () => {
    stubAuthenticator(async () => {
      throw new DOMException("excluded", "InvalidStateError");
    });
    const user = userEvent.setup();
    renderCard();
    await screen.findByText("Todavía no tiene llaves de acceso.");
    await user.click(screen.getByRole("button", { name: /Agregar llave de acceso/ }));
    expect(await screen.findByText(/ya tiene una llave de acceso/)).toBeInTheDocument();
  });

  it("does not offer to add one where the browser cannot", async () => {
    vi.stubGlobal("PublicKeyCredential", undefined);
    renderCard();
    expect(await screen.findByText("Este navegador no permite llaves de acceso.")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Agregar llave de acceso/ })).toBeNull();
  });
});
