// SPDX-License-Identifier: MIT
import { describe, expect, it } from "vitest";
import { screen } from "@testing-library/react";
import { RecoleccionFormPage } from "./RecoleccionFormPage";
import { renderWithAuth } from "../../test/renderWithAuth";
import { setTokens } from "../../api/client";

describe("RecoleccionFormPage", () => {
  it("refuses a session that may not register weighings", async () => {
    setTokens(null);
    renderWithAuth(<RecoleccionFormPage />, { path: "/cosecha/recoleccion" });
    expect(
      await screen.findByRole("heading", { name: "No tiene permiso para registrar recolección" }),
    ).toBeInTheDocument();
  });
});
