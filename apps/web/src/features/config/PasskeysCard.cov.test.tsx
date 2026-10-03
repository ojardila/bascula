/**
 * «Llaves de acceso» away from the happy path: the list will not load, a
 * passkey made on another address, failures adding or removing one, the
 * person backing out of each dialog, and a farm time zone the browser does
 * not know.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { server } from "../../mocks/node";
import * as db from "../../mocks/db";
import { renderWithAuth, signInOwner } from "../../test/renderWithAuth";
import { PasskeysCard } from "./PasskeysCard";

// Long user flows; the coverage run on a loaded machine is slow.
vi.setConfig({ testTimeout: 30_000 });

const ITEMS = [
  {
    id: "pk-1",
    name: "Mi celular",
    createdAt: "2026-09-01T15:00:00Z",
    lastUsedAt: "2026-09-20T15:30:00Z",
    host: "la-esperanza.bascula.app",
    here: true,
  },
  {
    id: "pk-2",
    name: "Portátil",
    createdAt: "2026-08-01T15:00:00Z",
    lastUsedAt: null,
    host: "bascula.app",
    here: false,
  },
];

const boom = () =>
  HttpResponse.json({ error: { code: "INTERNAL", message: "x" } }, { status: 500 });

function withItems() {
  server.use(http.get("*/v1/me/passkeys", () => HttpResponse.json({ items: ITEMS })));
}

function stubAuthenticator(create: () => Promise<unknown>) {
  vi.stubGlobal("PublicKeyCredential", function PublicKeyCredential() {});
  vi.stubGlobal("navigator", { ...navigator, credentials: { create, get: vi.fn() } });
}

function renderCard() {
  signInOwner();
  return renderWithAuth(<PasskeysCard />);
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("PasskeysCard — the list", () => {
  it("says so when the list cannot be loaded", async () => {
    server.use(http.get("*/v1/me/passkeys", boom));
    renderCard();
    expect(await screen.findByRole("alert")).toBeInTheDocument();
    expect(screen.queryByText("Todavía no tiene llaves de acceso.")).not.toBeInTheDocument();
  });

  it("shows the last use, or the creation date, and where another address's passkey works", async () => {
    withItems();
    renderCard();
    expect(await screen.findByText("Mi celular")).toBeInTheDocument();
    expect(screen.getByText(/^Último uso: /)).toBeInTheDocument();
    expect(screen.getByText(/^Creada: /)).toBeInTheDocument();
    expect(screen.getByText("Sirve en bascula.app")).toBeInTheDocument();
    expect(screen.queryByText("Sirve en la-esperanza.bascula.app")).not.toBeInTheDocument();
  });

  it("still shows dates when the farm's time zone is unknown to the browser", async () => {
    withItems();
    signInOwner();
    db.farms[0].timezone = "Marte/Base";
    renderWithAuth(<PasskeysCard />);
    expect(await screen.findByText("Mi celular")).toBeInTheDocument();
    expect(
      screen.getByText(`Último uso: ${new Date(ITEMS[0].lastUsedAt!).toLocaleString("es-CO")}`),
    ).toBeInTheDocument();
  });
});

describe("PasskeysCard — removing", () => {
  it("says why when a passkey cannot be removed, and keeps it", async () => {
    const user = userEvent.setup();
    withItems();
    server.use(http.delete("*/v1/me/passkeys/:id", boom));
    renderCard();
    await user.click(await screen.findByRole("button", { name: "Quitar Mi celular" }));
    const dialog = await screen.findByRole("dialog");
    expect(dialog).toHaveTextContent("«Mi celular» ya no servirá para entrar");
    await user.click(within(dialog).getByRole("button", { name: "Quitar" }));
    expect((await screen.findAllByRole("alert")).length).toBeGreaterThan(0);
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(screen.getByText("Mi celular")).toBeInTheDocument();
  });

  it("removes nothing when the person backs out", async () => {
    const user = userEvent.setup();
    withItems();
    let deletes = 0;
    server.use(
      http.delete("*/v1/me/passkeys/:id", () => {
        deletes += 1;
        return new HttpResponse(null, { status: 204 });
      }),
    );
    renderCard();
    await user.click(await screen.findByRole("button", { name: "Quitar Portátil" }));
    const dialog = await screen.findByRole("dialog");
    const confirm = within(dialog).getByRole("button", { name: "Quitar" });
    await user.click(within(dialog).getByRole("button", { name: "Cancelar" }));
    // A late tap while the dialog fades out removes nothing.
    fireEvent.click(confirm);
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(deletes).toBe(0);
  });
});

describe("PasskeysCard — adding", () => {
  it("shows the server's reason when adding fails for something else", async () => {
    const user = userEvent.setup();
    stubAuthenticator(async () => ({ toJSON: () => ({ id: "c", type: "public-key", response: {} }) }));
    server.use(http.post("*/v1/me/passkeys/options", boom));
    renderCard();
    await user.click(await screen.findByRole("button", { name: /Agregar llave de acceso/ }));
    const dialog = await screen.findByRole("dialog");
    await user.type(within(dialog).getByLabelText(/Su clave/), "esperanza");
    await user.click(within(dialog).getByRole("button", { name: "Continuar" }));
    const alert = await screen.findByRole("alert");
    expect(alert).not.toHaveTextContent("Este dispositivo ya tiene una llave de acceso");
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
  });

  it("closes the password dialog with Cancelar or Escape without adding", async () => {
    const user = userEvent.setup();
    const create = vi.fn();
    stubAuthenticator(create);
    renderCard();
    await user.click(await screen.findByRole("button", { name: /Agregar llave de acceso/ }));
    const dialog = await screen.findByRole("dialog");
    await user.click(within(dialog).getByRole("button", { name: "Cancelar" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());

    await user.click(screen.getByRole("button", { name: /Agregar llave de acceso/ }));
    expect(await screen.findByRole("dialog")).toBeInTheDocument();
    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(create).not.toHaveBeenCalled();
  });

  it("does not close the dialog with Escape while the phone is being asked", async () => {
    const user = userEvent.setup();
    let answer: (v: unknown) => void = () => {};
    stubAuthenticator(
      () =>
        new Promise((r) => {
          answer = r;
        }),
    );
    renderCard();
    await user.click(await screen.findByRole("button", { name: /Agregar llave de acceso/ }));
    const dialog = await screen.findByRole("dialog");
    await user.type(within(dialog).getByLabelText(/Su clave/), "esperanza");
    await user.click(within(dialog).getByRole("button", { name: "Continuar" }));
    expect(await within(dialog).findByRole("button", { name: "Esperando…" })).toBeDisabled();
    await user.keyboard("{Escape}");
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    answer({ toJSON: () => ({ id: "c", type: "public-key", response: {} }) });
    expect(await screen.findByText("Llave de acceso guardada.")).toBeInTheDocument();
  });
});
