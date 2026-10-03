import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { ThemeProvider } from "@mui/material";
import { App } from "../../App";
import { AuthProvider } from "../../auth/AuthContext";
import { setTokens } from "../../api/client";
import { invalidateRefs } from "../../api/refs";
import { theme } from "../../theme";
import { memberships, passkeys, resetDb, users } from "../../mocks/db";

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
    stubHostname("lapalma.bascula.engp.io");
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
    stubHostname("lapalma.bascula.engp.io");
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

describe("passkey sign-in (optional)", () => {
  function stubAuthenticator(credentialId: string) {
    const get = vi.fn(async () => ({ toJSON: () => ({ id: credentialId, type: "public-key", response: {} }) }));
    vi.stubGlobal("PublicKeyCredential", function PublicKeyCredential() {});
    vi.stubGlobal("navigator", { ...navigator, credentials: { get, create: vi.fn() } });
    return get;
  }

  function givePasskey(email: string, credentialId: string) {
    const u = users.find((x) => x.email === email);
    if (!u) throw new Error(`no ${email}`);
    passkeys.push({
      id: crypto.randomUUID(),
      userId: u.id,
      credentialId,
      name: "Mi celular",
      createdAt: new Date().toISOString(),
      lastUsedAt: null,
    });
    return u;
  }

  it("is not offered where the browser has no passkeys", async () => {
    vi.stubGlobal("PublicKeyCredential", undefined);
    renderApp();
    expect(await screen.findByRole("button", { name: "Entrar" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /llave de acceso/ })).toBeNull();
  });

  it("enters with no email and no password", async () => {
    givePasskey("oscar@laesperanza.co", "cred-oscar");
    stubAuthenticator("cred-oscar");
    const user = userEvent.setup();
    renderApp();
    await user.click(await screen.findByRole("button", { name: /Entrar con llave de acceso/ }));
    expect(await screen.findByRole("heading", { name: "Cosecha" }, { timeout: 5000 })).toBeInTheDocument();
    expect(passkeys[0].lastUsedAt).not.toBeNull();
  }, 20000);

  it("asks for the farm once, without asking the phone again", async () => {
    const oscar = givePasskey("oscar@laesperanza.co", "cred-oscar");
    memberships.push({ farmId: "0192f3a0-0000-7000-8000-000000000002", userId: oscar.id, role: "owner" });
    const get = stubAuthenticator("cred-oscar");
    const user = userEvent.setup();
    renderApp();
    await user.click(await screen.findByRole("button", { name: /Entrar con llave de acceso/ }));
    expect(await screen.findByText("¿A cuál finca entra?")).toBeInTheDocument();
    await user.click(screen.getAllByRole("button", { name: /Dueño/ })[0]);
    expect(await screen.findByRole("heading", { name: "Cosecha" }, { timeout: 5000 })).toBeInTheDocument();
    expect(get).toHaveBeenCalledTimes(1);
  }, 20000);

  it("points back to the password when the passkey is unknown", async () => {
    stubAuthenticator("cred-nobody");
    const user = userEvent.setup();
    renderApp();
    await user.click(await screen.findByRole("button", { name: /Entrar con llave de acceso/ }));
    expect(await screen.findByText(/No reconocimos esa llave de acceso/)).toBeInTheDocument();
  });

  it("stays quiet when the person closes the prompt", async () => {
    vi.stubGlobal("PublicKeyCredential", function PublicKeyCredential() {});
    vi.stubGlobal("navigator", {
      ...navigator,
      credentials: { get: vi.fn(async () => { throw new DOMException("closed", "NotAllowedError"); }) },
    });
    const user = userEvent.setup();
    renderApp();
    const button = await screen.findByRole("button", { name: /Entrar con llave de acceso/ });
    await user.click(button);
    await waitFor(() => expect(button).toBeEnabled());
    expect(screen.queryByRole("alert")).toBeNull();
  });
});

describe("offering a passkey after a password sign-in", () => {
  function stubPlatform(available: boolean) {
    const create = vi.fn(async () => ({
      toJSON: () => ({ id: "cred-new", type: "public-key", response: {} }),
    }));
    const PKC = Object.assign(function PublicKeyCredential() {}, {
      isUserVerifyingPlatformAuthenticatorAvailable: async () => available,
    });
    vi.stubGlobal("PublicKeyCredential", PKC);
    vi.stubGlobal("navigator", {
      ...navigator,
      userAgent:
        "Mozilla/5.0 (Linux; Android 15; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Mobile Safari/537.36",
      credentials: { create, get: vi.fn() },
    });
    return create;
  }

  async function signIn(user: ReturnType<typeof userEvent.setup>) {
    await user.type(await screen.findByLabelText(/^Correo/), "oscar@laesperanza.co");
    await user.type(screen.getByLabelText(/^Contraseña/), "esperanza");
    await user.click(screen.getByRole("button", { name: "Entrar" }));
  }

  const OFFER = "¿Quiere entrar más rápido la próxima vez?";

  it("offers once and saves a passkey with the password just typed", async () => {
    const create = stubPlatform(true);
    const user = userEvent.setup();
    renderApp();
    await signIn(user);

    expect(await screen.findByText(OFFER)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /Sí, activarlo/ }));
    expect(await screen.findByText(/La próxima vez toque «Entrar con llave de acceso»/)).toBeInTheDocument();
    expect(create).toHaveBeenCalledTimes(1);
    expect(passkeys).toHaveLength(1);
    expect(passkeys[0]).toMatchObject({ credentialId: "cred-new", name: "Chrome en Android" });

    await user.click(screen.getByRole("button", { name: "Continuar" }));
    expect(await screen.findByRole("heading", { name: "Cosecha" }, { timeout: 5000 })).toBeInTheDocument();
  }, 20000);

  it("remembers «Ahora no» and does not ask again on this device", async () => {
    stubPlatform(true);
    const user = userEvent.setup();
    const first = renderApp();
    await signIn(user);
    expect(await screen.findByText(OFFER)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Ahora no" }));
    expect(await screen.findByRole("heading", { name: "Cosecha" }, { timeout: 5000 })).toBeInTheDocument();
    expect(passkeys).toHaveLength(0);
    first.unmount();

    setTokens(null);
    renderApp();
    await signIn(user);
    expect(await screen.findByRole("heading", { name: "Cosecha" }, { timeout: 5000 })).toBeInTheDocument();
    expect(screen.queryByText(OFFER)).toBeNull();
  }, 30000);

  it("is not offered to somebody who already has a passkey here", async () => {
    stubPlatform(true);
    const oscar = users.find((u) => u.email === "oscar@laesperanza.co")!;
    passkeys.push({
      id: crypto.randomUUID(),
      userId: oscar.id,
      credentialId: "cred-old",
      name: "Mi celular",
      createdAt: new Date().toISOString(),
      lastUsedAt: null,
    });
    const user = userEvent.setup();
    renderApp();
    await signIn(user);
    expect(await screen.findByRole("heading", { name: "Cosecha" }, { timeout: 5000 })).toBeInTheDocument();
    expect(screen.queryByText(OFFER)).toBeNull();
  }, 20000);

  it("is not offered on a device without fingerprint or face", async () => {
    stubPlatform(false);
    const user = userEvent.setup();
    renderApp();
    await signIn(user);
    expect(await screen.findByRole("heading", { name: "Cosecha" }, { timeout: 5000 })).toBeInTheDocument();
    expect(screen.queryByText(OFFER)).toBeNull();
  }, 20000);

  it("goes straight on when the person closes the phone's prompt", async () => {
    const create = stubPlatform(true);
    create.mockImplementation(async () => {
      throw new DOMException("closed", "NotAllowedError");
    });
    const user = userEvent.setup();
    renderApp();
    await signIn(user);
    await user.click(await screen.findByRole("button", { name: /Sí, activarlo/ }));
    expect(await screen.findByRole("heading", { name: "Cosecha" }, { timeout: 5000 })).toBeInTheDocument();
  }, 20000);
  it("says so when the device already holds one, then lets the person in", async () => {
    const create = stubPlatform(true);
    create.mockImplementation(async () => {
      throw new DOMException("exists", "InvalidStateError");
    });
    const user = userEvent.setup();
    renderApp();
    await signIn(user);
    await user.click(await screen.findByRole("button", { name: /Sí, activarlo/ }));
    expect(await screen.findByText("No se pudo activar")).toBeInTheDocument();
    expect(screen.getByText(/ya tiene una llave de acceso/)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Continuar" }));
    expect(await screen.findByRole("heading", { name: "Cosecha" }, { timeout: 5000 })).toBeInTheDocument();
  }, 20000);
});

describe("passkey autofill on the email field", () => {
  function stubConditional(get: (opts: CredentialRequestOptions) => Promise<unknown>) {
    const PKC = Object.assign(function PublicKeyCredential() {}, {
      isConditionalMediationAvailable: async () => true,
    });
    vi.stubGlobal("PublicKeyCredential", PKC);
    const spy = vi.fn(get);
    vi.stubGlobal("navigator", { ...navigator, credentials: { get: spy, create: vi.fn() } });
    return spy;
  }

  function givePasskey(credentialId: string) {
    const u = users.find((x) => x.email === "oscar@laesperanza.co")!;
    passkeys.push({
      id: crypto.randomUUID(),
      userId: u.id,
      credentialId,
      name: "Mi celular",
      createdAt: new Date().toISOString(),
      lastUsedAt: null,
    });
  }

  it("asks the browser to suggest passkeys in the email field", async () => {
    renderApp();
    expect(await screen.findByLabelText(/^Correo/)).toHaveAttribute("autocomplete", "username webauthn");
  });

  it("signs in when the person picks the suggested passkey", async () => {
    givePasskey("cred-oscar");
    const get = stubConditional(async () => ({
      toJSON: () => ({ id: "cred-oscar", type: "public-key", response: {} }),
    }));
    renderApp();
    expect(await screen.findByRole("heading", { name: "Cosecha" }, { timeout: 5000 })).toBeInTheDocument();
    expect(get.mock.calls[0][0]).toMatchObject({ mediation: "conditional" });
  }, 20000);

  it("steps aside when the person taps the passkey button", async () => {
    givePasskey("cred-oscar");
    const get = stubConditional(
      (opts) =>
        new Promise((resolve, reject) => {
          if (opts.mediation === "conditional") {
            opts.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
            return;
          }
          resolve({ toJSON: () => ({ id: "cred-oscar", type: "public-key", response: {} }) });
        }),
    );
    const user = userEvent.setup();
    renderApp();
    await waitFor(() => expect(get).toHaveBeenCalledTimes(1));
    await user.click(screen.getByRole("button", { name: /Entrar con llave de acceso/ }));
    expect(await screen.findByRole("heading", { name: "Cosecha" }, { timeout: 5000 })).toBeInTheDocument();
    expect(get.mock.calls[0][0].signal?.aborted).toBe(true);
    expect(get.mock.calls[1][0].mediation).toBeUndefined();
  }, 20000);

  it("does nothing where the browser cannot suggest passkeys", async () => {
    const get = vi.fn();
    vi.stubGlobal("PublicKeyCredential", function PublicKeyCredential() {});
    vi.stubGlobal("navigator", { ...navigator, credentials: { get, create: vi.fn() } });
    renderApp();
    expect(await screen.findByRole("button", { name: "Entrar" })).toBeInTheDocument();
    await new Promise((r) => setTimeout(r, 50));
    expect(get).not.toHaveBeenCalled();
  });
});
