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

/** Clicks «Agregar» and answers the password the card asks for first. */
async function startAdding(
  user: ReturnType<typeof userEvent.setup>,
  password = "esperanza",
) {
  await user.click(
    screen.getByRole("button", { name: /Agregar llave de acceso/ }),
  );
  const dialog = await screen.findByRole("dialog");
  await user.type(within(dialog).getByLabelText(/Su clave/), password);
  await user.click(within(dialog).getByRole("button", { name: "Continuar" }));
}

function stubAuthenticator(create: () => Promise<unknown>) {
  vi.stubGlobal("PublicKeyCredential", function PublicKeyCredential() {});
  vi.stubGlobal("navigator", {
    ...navigator,
    credentials: { create, get: vi.fn() },
  });
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
    stubAuthenticator(async () => ({
      toJSON: () => ({ id: "cred-1", type: "public-key", response: {} }),
    }));
    const user = userEvent.setup();
    renderCard();

    expect(
      await screen.findByText("Todavía no tiene llaves de acceso."),
    ).toBeInTheDocument();
    await user.type(screen.getByLabelText(/Nombre/), "Mi celular");
    await startAdding(user);

    expect(
      await screen.findByText("Llave de acceso guardada."),
    ).toBeInTheDocument();
    expect(await screen.findByText("Mi celular")).toBeInTheDocument();
    expect(db.passkeys).toHaveLength(1);
    expect(db.passkeys[0]).toMatchObject({
      userId: OWNER,
      credentialId: "cred-1",
      name: "Mi celular",
    });
    // The password box has closed before anything else is clicked.
    await waitFor(() =>
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
    );

    await user.click(screen.getByRole("button", { name: "Quitar Mi celular" }));
    const dialog = await screen.findByRole("dialog");
    await user.click(within(dialog).getByRole("button", { name: "Quitar" }));
    await waitFor(() => expect(db.passkeys).toHaveLength(0));
    expect(
      await screen.findByText("Todavía no tiene llaves de acceso."),
    ).toBeInTheDocument();
  });

  it("says nothing when the person closes the prompt", async () => {
    stubAuthenticator(async () => {
      throw new DOMException("closed", "NotAllowedError");
    });
    const user = userEvent.setup();
    renderCard();
    await screen.findByText("Todavía no tiene llaves de acceso.");
    await startAdding(user);
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: /Agregar llave de acceso/ }),
      ).toBeEnabled(),
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
    await startAdding(user);
    expect(
      await screen.findByText(/ya tiene una llave de acceso/),
    ).toBeInTheDocument();
  });

  it("asks for the password first, and a wrong one asks again without touching the phone", async () => {
    const create = vi.fn(async () => ({
      toJSON: () => ({ id: "cred-2", type: "public-key", response: {} }),
    }));
    stubAuthenticator(create);
    const user = userEvent.setup();
    renderCard();
    await screen.findByText("Todavía no tiene llaves de acceso.");
    await startAdding(user, "no-es-esta");

    const dialog = await screen.findByRole("dialog");
    expect(
      await within(dialog).findByText("La clave no es correcta."),
    ).toBeInTheDocument();
    expect(create).not.toHaveBeenCalled();

    await user.clear(within(dialog).getByLabelText(/Su clave/));
    await user.type(within(dialog).getByLabelText(/Su clave/), "esperanza");
    await user.click(within(dialog).getByRole("button", { name: "Continuar" }));
    expect(
      await screen.findByText("Llave de acceso guardada."),
    ).toBeInTheDocument();
    expect(create).toHaveBeenCalledTimes(1);
    expect(db.passkeys).toHaveLength(1);
  });

  it("does not offer to add one where the browser cannot", async () => {
    vi.stubGlobal("PublicKeyCredential", undefined);
    renderCard();
    expect(
      await screen.findByText("Este navegador no permite llaves de acceso."),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /Agregar llave de acceso/ }),
    ).toBeNull();
  });
});
