// SPDX-License-Identifier: MIT
import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { ConfirmEmailPage } from "./ConfirmEmailPage";
import { api } from "../../api/endpoints";
import { ApiError } from "../../api/errors";

function renderAt(hash: string) {
  window.history.replaceState(null, "", `/confirmar-correo${hash}`);
  return render(
    <MemoryRouter initialEntries={["/confirmar-correo"]}>
      <Routes>
        <Route path="/confirmar-correo" element={<ConfirmEmailPage />} />
        <Route path="/preparando/:slug" element={<p>esperando finca</p>} />
      </Routes>
    </MemoryRouter>,
  );
}

describe("ConfirmEmailPage", () => {
  beforeEach(() => vi.restoreAllMocks());

  it("sends the link and the password, then goes to the farm's waiting screen", async () => {
    const spy = vi.spyOn(api, "verifyEmail").mockResolvedValue({
      userId: "u", farmId: "f", slug: "san-jose", verified: true,
    });
    renderAt("#secreto-1");
    expect(window.location.hash).toBe("");
    await userEvent.type(screen.getByLabelText(/su clave/i), "clave-larga-1");
    await userEvent.click(screen.getByRole("button", { name: /confirmar correo/i }));
    expect(spy).toHaveBeenCalledWith("secreto-1", "clave-larga-1");
    expect(await screen.findByText("esperando finca")).toBeInTheDocument();
  });

  it("says the password is wrong without spending the link", async () => {
    vi.spyOn(api, "verifyEmail").mockRejectedValue(
      new ApiError(401, { error: { code: "INVALID_CREDENTIALS", message: "the password does not match this registration" } }),
    );
    renderAt("#secreto-2");
    await userEvent.type(screen.getByLabelText(/su clave/i), "otra");
    await userEvent.click(screen.getByRole("button", { name: /confirmar correo/i }));
    expect(await screen.findByText(/no es la clave/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /confirmar correo/i })).toBeInTheDocument();
  });

  it("explains a dead link", async () => {
    renderAt("");
    expect(screen.getByText(/este enlace ya no sirve/i)).toBeInTheDocument();
  });
});
