// SPDX-License-Identifier: MIT
/**
 * «Cambiar clave»: what the form says before it asks the server, what it says
 * when the server refuses, and the #clave landing in a browser with no
 * ResizeObserver.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { ThemeProvider } from "@mui/material";
import { http, HttpResponse } from "msw";
import { server } from "../../mocks/node";
import { ChangePasswordCard } from "./ChangePasswordCard";
import { theme } from "../../theme";
import { signInOwner } from "../../test/renderWithAuth";

// Long user flows; the coverage run on a loaded machine is slow.
vi.setConfig({ testTimeout: 30_000 });

function renderCard(path = "/configuracion") {
  return render(
    <ThemeProvider theme={theme}>
      <MemoryRouter initialEntries={[path]}>
        <ChangePasswordCard />
      </MemoryRouter>
    </ThemeProvider>,
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
});

async function fill(current: string, next: string, repeat: string) {
  const user = userEvent.setup();
  if (current) await user.type(screen.getByLabelText("Clave actual"), current);
  if (next) await user.type(screen.getByLabelText("Clave nueva"), next);
  if (repeat) await user.type(screen.getByLabelText("Repita la clave nueva"), repeat);
  await user.click(screen.getByRole("button", { name: "Cambiar clave" }));
}

describe("ChangePasswordCard — checks before the server", () => {
  it("asks for the current password first", async () => {
    renderCard();
    await fill("", "nueva-clave-larga", "nueva-clave-larga");
    expect(await screen.findByText("Escriba su clave actual.")).toBeInTheDocument();
  });

  it("asks for at least 10 characters", async () => {
    renderCard();
    await fill("vieja", "corta", "corta");
    expect(
      await screen.findByText("La clave nueva debe tener al menos 10 caracteres."),
    ).toBeInTheDocument();
  });

  it("asks for the two new passwords to match", async () => {
    renderCard();
    await fill("vieja", "nueva-clave-larga", "otra-clave-larga");
    expect(await screen.findByText("Las dos claves nuevas no coinciden.")).toBeInTheDocument();
  });
});

describe("ChangePasswordCard — the server's answer", () => {
  it("says the current password is wrong", async () => {
    signInOwner();
    server.use(
      http.post("*/v1/me/password", () =>
        HttpResponse.json(
          { error: { code: "INVALID_CREDENTIALS", message: "bad" } },
          { status: 400 },
        ),
      ),
    );
    renderCard();
    await fill("vieja", "nueva-clave-larga", "nueva-clave-larga");
    expect(await screen.findByText("La clave actual no es correcta.")).toBeInTheDocument();
  });

  it("shows any other failure in plain words", async () => {
    signInOwner();
    server.use(http.post("*/v1/me/password", () => HttpResponse.error()));
    renderCard();
    await fill("vieja", "nueva-clave-larga", "nueva-clave-larga");
    const alert = await screen.findByRole("alert");
    expect(alert).not.toHaveTextContent("La clave actual no es correcta.");
    expect(alert.textContent).not.toBe("");
    expect(screen.getByRole("button", { name: "Cambiar clave" })).toBeEnabled();
  });

  it("confirms and clears the form when it changes", async () => {
    signInOwner();
    server.use(
      http.post("*/v1/me/password", () =>
        HttpResponse.json({ accessToken: "a", refreshToken: "r" }),
      ),
    );
    renderCard();
    await fill("vieja", "nueva-clave-larga", "nueva-clave-larga");
    expect(await screen.findByText("Su clave cambió.")).toBeInTheDocument();
    expect(screen.getByLabelText("Clave actual")).toHaveValue("");
  });
});

describe("ChangePasswordCard — #clave without ResizeObserver", () => {
  it("still brings the card into view and focuses the first field", () => {
    vi.stubGlobal("ResizeObserver", undefined);
    const scrolled: Element[] = [];
    const orig = Element.prototype.scrollIntoView;
    Element.prototype.scrollIntoView = function (this: Element) {
      scrolled.push(this);
    };
    try {
      renderCard("/configuracion#clave");
      expect(scrolled).toContain(document.getElementById("clave"));
      expect(screen.getByLabelText("Clave actual")).toHaveFocus();
    } finally {
      Element.prototype.scrollIntoView = orig;
    }
  });
});
