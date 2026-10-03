/**
 * The «restablecer clave» link: checks before the server, a `token=`
 * fragment, a spent link, other refusals, and a link with no secret at all.
 */
import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { http, HttpResponse } from "msw";
import { server } from "../../mocks/node";
import { ResetPasswordPage } from "./ResetPasswordPage";

vi.setConfig({ testTimeout: 30_000 });

function renderAt(hash: string) {
  window.history.replaceState(null, "", `/restablecer-clave${hash}`);
  return render(
    <MemoryRouter initialEntries={["/restablecer-clave"]}>
      <ResetPasswordPage />
    </MemoryRouter>,
  );
}

async function save(password: string, repeat: string) {
  const user = userEvent.setup();
  if (password) await user.type(screen.getByLabelText(/^Clave nueva/), password);
  if (repeat) await user.type(screen.getByLabelText(/^Repita la clave nueva/), repeat);
  await user.click(screen.getByRole("button", { name: "Guardar clave nueva" }));
}

function refuse(status: number, message: string) {
  server.use(
    http.post("*/v1/auth/password-reset", () =>
      HttpResponse.json({ error: { code: "VALIDATION", message } }, { status }),
    ),
  );
}

describe("ResetPasswordPage", () => {
  it("asks for at least 10 characters", async () => {
    renderAt("#secreto");
    await save("corta", "corta");
    expect(
      await screen.findByText("La clave nueva debe tener al menos 10 caracteres."),
    ).toBeInTheDocument();
  });

  it("asks for the two passwords to match", async () => {
    renderAt("#secreto");
    await save("clave-larga-1", "clave-larga-2");
    expect(await screen.findByText("Las dos claves no coinciden.")).toBeInTheDocument();
  });

  it("reads a token= fragment, wipes it, and changes the password", async () => {
    let sent: unknown = null;
    server.use(
      http.post("*/v1/auth/password-reset", async ({ request }) => {
        sent = await request.json();
        return new HttpResponse(null, { status: 204 });
      }),
    );
    renderAt("#token=secreto-7");
    expect(window.location.hash).toBe("");
    await save("clave-larga-1", "clave-larga-1");
    expect(await screen.findByText(/Listo\. Su clave cambió/)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Entrar" })).toHaveAttribute("href", "/entrar");
    expect(sent).toEqual({ token: "secreto-7", password: "clave-larga-1" });
  });

  it("explains a spent link", async () => {
    refuse(400, "this link is no longer valid");
    renderAt("#secreto");
    await save("clave-larga-1", "clave-larga-1");
    expect(await screen.findByText(/Este enlace ya no sirve/)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Pedir otro enlace" })).toHaveAttribute(
      "href",
      "/olvide-mi-clave",
    );
  });

  it("keeps the form for a 400 that is not about the link", async () => {
    refuse(400, "password too common");
    renderAt("#secreto");
    await save("clave-larga-1", "clave-larga-1");
    expect(await screen.findByRole("alert")).toBeInTheDocument();
    expect(screen.queryByText(/Este enlace ya no sirve/)).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Guardar clave nueva" })).toBeEnabled();
  });

  it("keeps the form for any other failure", async () => {
    refuse(500, "the link store is down");
    renderAt("#secreto");
    await save("clave-larga-1", "clave-larga-1");
    expect(await screen.findByRole("alert")).toBeInTheDocument();
    expect(screen.queryByText(/Este enlace ya no sirve/)).not.toBeInTheDocument();
  });

  it("keeps the form when the server cannot be reached", async () => {
    server.use(http.post("*/v1/auth/password-reset", () => HttpResponse.error()));
    renderAt("#secreto");
    await save("clave-larga-1", "clave-larga-1");
    expect(await screen.findByRole("alert")).toBeInTheDocument();
  });

  it("explains a link with no secret", () => {
    renderAt("");
    expect(screen.getByText(/Este enlace ya no sirve/)).toBeInTheDocument();
  });
});
