// SPDX-License-Identifier: MIT
/**
 * Issue #145: a password can be changed, signed in («Cambiar clave») or with
 * a mailed link («Olvidé mi clave» → /restablecer-clave).
 */
import { describe, expect, it, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { ThemeProvider } from "@mui/material";
import { ChangePasswordCard } from "../config/ChangePasswordCard";
import { ForgotPasswordPage } from "./ForgotPasswordPage";
import { ResetPasswordPage } from "./ResetPasswordPage";
import { api } from "../../api/endpoints";
import { getTokens, setTokens } from "../../api/client";
import { invalidateRefs } from "../../api/refs";
import { theme } from "../../theme";
import * as db from "../../mocks/db";

const EMAIL = "oscar@laesperanza.co";
const OLD = "esperanza";
const NEW = "una-clave-nueva-1";

function renderWith(ui: React.ReactNode) {
  return render(
    <ThemeProvider theme={theme}>
      <MemoryRouter>{ui}</MemoryRouter>
    </ThemeProvider>,
  );
}

beforeEach(() => {
  db.resetDb();
  invalidateRefs();
  setTokens(null);
  window.history.replaceState(null, "", "/");
});

describe("Cambiar clave", () => {
  it("refuses a wrong current password without signing out", async () => {
    await api.login({ email: EMAIL, password: OLD });
    const user = userEvent.setup();
    renderWith(<ChangePasswordCard />);
    await user.type(screen.getByLabelText("Clave actual"), "no-es-esta");
    await user.type(screen.getByLabelText("Clave nueva"), NEW);
    await user.type(screen.getByLabelText("Repita la clave nueva"), NEW);
    await user.click(screen.getByRole("button", { name: "Cambiar clave" }));
    expect(await screen.findByText("La clave actual no es correcta.")).toBeInTheDocument();
    expect(getTokens()).not.toBeNull();
  });

  it("changes it, keeps this device signed in, and the old one stops working", async () => {
    await api.login({ email: EMAIL, password: OLD });
    const before = getTokens()!.refreshToken;
    const user = userEvent.setup();
    renderWith(<ChangePasswordCard />);
    await user.type(screen.getByLabelText("Clave actual"), OLD);
    await user.type(screen.getByLabelText("Clave nueva"), NEW);
    await user.type(screen.getByLabelText("Repita la clave nueva"), NEW);
    await user.click(screen.getByRole("button", { name: "Cambiar clave" }));
    expect(await screen.findByText("Su clave cambió.")).toBeInTheDocument();
    expect(getTokens()!.refreshToken).not.toBe(before);
    await expect(api.login({ email: EMAIL, password: OLD })).rejects.toBeTruthy();
    await expect(api.login({ email: EMAIL, password: NEW })).resolves.toBeTruthy();
  });

  it("checks the two new passwords match before asking the server", async () => {
    await api.login({ email: EMAIL, password: OLD });
    const user = userEvent.setup();
    renderWith(<ChangePasswordCard />);
    await user.type(screen.getByLabelText("Clave actual"), OLD);
    await user.type(screen.getByLabelText("Clave nueva"), NEW);
    await user.type(screen.getByLabelText("Repita la clave nueva"), NEW + "x");
    await user.click(screen.getByRole("button", { name: "Cambiar clave" }));
    expect(screen.getByText("Las dos claves nuevas no coinciden.")).toBeInTheDocument();
  });
});

describe("Olvidé mi clave", () => {
  it("mails a link and answers the same for any address", async () => {
    const user = userEvent.setup();
    renderWith(<ForgotPasswordPage />);
    await user.type(await screen.findByLabelText(/Correo/), "nadie@ejemplo.com");
    await user.click(screen.getByRole("button", { name: "Enviarme el enlace" }));
    expect(await screen.findByText(/Si ese correo está registrado/)).toBeInTheDocument();
  });

  it("sets a new password from the link, once", async () => {
    const { resetToken } = await api.requestPasswordReset(EMAIL);
    window.history.replaceState(null, "", `/restablecer-clave#${resetToken}`);
    const user = userEvent.setup();
    renderWith(<ResetPasswordPage />);
    // The secret leaves the address bar as soon as it is read.
    expect(window.location.hash).toBe("");
    await user.type(screen.getByLabelText(/^Clave nueva/), NEW);
    await user.type(screen.getByLabelText(/Repita la clave nueva/), NEW);
    await user.click(screen.getByRole("button", { name: "Guardar clave nueva" }));
    expect(await screen.findByText(/Su clave cambió/)).toBeInTheDocument();
    await expect(api.login({ email: EMAIL, password: NEW })).resolves.toBeTruthy();
    await expect(api.resetPassword(resetToken!, "otra-clave-mas-1")).rejects.toBeTruthy();
  });

  it("says a missing link is not valid instead of showing a form", () => {
    window.history.replaceState(null, "", "/restablecer-clave");
    renderWith(<ResetPasswordPage />);
    expect(screen.getByText(/Este enlace ya no sirve/)).toBeInTheDocument();
  });
});
