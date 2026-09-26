import { describe, expect, it, vi, afterEach } from "vitest";
import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { ThemeProvider } from "@mui/material";
import { api } from "../../api/endpoints";
import type { ProvisionStatus } from "../../api/types";
import { theme } from "../../theme";
import { ProvisionProgress } from "./ProvisionProgress";

function status(done: [boolean, boolean, boolean], extra: Partial<ProvisionStatus> = {}): ProvisionStatus {
  return {
    slug: "lapalma",
    url: "https://lapalma.bascula.engp.io",
    dedicated: true,
    steps: [
      { key: "database", done: done[0] },
      { key: "app", done: done[1] },
      { key: "web", done: done[2] },
    ],
    ready: done.every(Boolean),
    slow: false,
    elapsedSeconds: 30,
    ...extra,
  };
}

function renderIt() {
  return render(
    <ThemeProvider theme={theme}>
      <MemoryRouter>
        <ProvisionProgress slug="lapalma" pollMs={10} />
      </MemoryRouter>
    </ThemeProvider>,
  );
}

afterEach(() => vi.restoreAllMocks());

describe("Preparando su finca", () => {
  it("walks the three steps and ends on the address with one button", async () => {
    const spy = vi
      .spyOn(api, "provisionStatus")
      .mockResolvedValueOnce(status([false, false, false]))
      .mockResolvedValueOnce(status([true, false, false]))
      .mockResolvedValueOnce(status([true, true, false]))
      .mockResolvedValue(status([true, true, true]));
    renderIt();
    expect(await screen.findByText("Preparando su finca…")).toBeInTheDocument();
    expect(await screen.findByText("¡Su finca está lista!")).toBeInTheDocument();
    expect(screen.getByText("lapalma.bascula.engp.io")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Entrar a mi finca" })).toHaveAttribute(
      "href",
      "https://lapalma.bascula.engp.io/entrar",
    );
    const calls = spy.mock.calls.length;
    await new Promise((r) => setTimeout(r, 50));
    expect(spy.mock.calls.length).toBe(calls); // stops polling once ready
  });

  it("shows the secure-connection step only when the platform reports it", async () => {
    const withCert: ProvisionStatus = {
      ...status([true, true, false]),
      steps: [
        { key: "database", done: true },
        { key: "app", done: true },
        { key: "certificate", done: false },
        { key: "web", done: false },
      ],
    };
    vi.spyOn(api, "provisionStatus").mockResolvedValue(withCert);
    renderIt();
    const cert = await screen.findByTestId("step-certificate");
    expect(cert).toHaveAttribute("data-done", "false");
    expect(screen.getByText("Conexión segura")).toBeInTheDocument();
    expect(screen.getByTestId("step-web")).toHaveAttribute("data-done", "false");
  });

  it("has no secure-connection step where the platform does not issue one", async () => {
    vi.spyOn(api, "provisionStatus").mockResolvedValue(status([true, false, false]));
    renderIt();
    expect(await screen.findByTestId("step-web")).toBeInTheDocument();
    expect(screen.queryByTestId("step-certificate")).toBeNull();
  });

  it("falls back plainly when the address takes too long", async () => {
    vi.spyOn(api, "provisionStatus").mockResolvedValue(status([true, true, false], { slow: true }));
    renderIt();
    expect(await screen.findByText(/está tardando más de lo normal/)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Entrar ahora" })).toHaveAttribute("href", "/entrar");
  });
});
