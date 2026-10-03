// SPDX-License-Identifier: MIT
/** The "this is not your farm" strip, shown only in mock mode. */
import { afterEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { ApiModeBanner } from "./ApiModeBanner";

const mode = vi.hoisted(() => ({ mocks: true, label: "Datos simulados", target: "MSW" }));
vi.mock("../api/mode", () => ({ apiMode: () => mode }));

afterEach(() => vi.restoreAllMocks());

describe("ApiModeBanner", () => {
  it("in mock mode tells the person nothing is saved, and logs how to switch", () => {
    mode.mocks = true;
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    render(<ApiModeBanner />);
    expect(screen.getByRole("status")).toHaveTextContent(
      "Datos de prueba. Ésta no es su finca: nada de lo que registre aquí se guarda.",
    );
    expect(info).toHaveBeenCalledWith(expect.stringContaining("VITE_USE_MOCKS=false"));
  });

  it("against the real server shows nothing and logs nothing", () => {
    mode.mocks = false;
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    const { container } = render(<ApiModeBanner />);
    expect(container).toBeEmptyDOMElement();
    expect(screen.queryByText("Datos de prueba.")).not.toBeInTheDocument();
    expect(info).not.toHaveBeenCalled();
  });
});
