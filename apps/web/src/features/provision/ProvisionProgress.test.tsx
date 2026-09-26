import { describe, expect, it, vi, afterEach } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { ThemeProvider } from "@mui/material";
import { api } from "../../api/endpoints";
import type { ProvisionStatus } from "../../api/types";
import { theme } from "../../theme";
import { ProvisionProgress, REDIRECT_MS, goTo } from "./ProvisionProgress";

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

function renderIt(redirectWhenReady = false) {
  return render(
    <ThemeProvider theme={theme}>
      <MemoryRouter>
        <ProvisionProgress slug="lapalma" pollMs={10} redirectWhenReady={redirectWhenReady} />
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
      "https://lapalma.bascula.engp.io/tablero",
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

  it("keeps 'entre aquí con su correo' on the shared app while the address has no valid certificate", async () => {
    vi.spyOn(api, "provisionStatus").mockResolvedValue(status([true, false, false]));
    renderIt();
    await waitFor(() => expect(screen.getByTestId("step-database")).toHaveAttribute("data-done", "true"));
    expect(await screen.findByRole("link", { name: "entre aquí con su correo" })).toHaveAttribute(
      "href",
      "/entrar",
    );
  });

  it("does not send anybody to the farm's address before its certificate step is done", async () => {
    vi.spyOn(api, "provisionStatus").mockResolvedValue({
      ...status([true, false, true]),
      steps: [
        { key: "database", done: true },
        { key: "app", done: false },
        { key: "certificate", done: false },
        { key: "web", done: true },
      ],
    });
    renderIt();
    await waitFor(() => expect(screen.getByTestId("step-database")).toHaveAttribute("data-done", "true"));
    expect(await screen.findByRole("link", { name: "entre aquí con su correo" })).toHaveAttribute(
      "href",
      "/entrar",
    );
  });

  it("sends 'entre aquí con su correo' to the farm's own login once the address opens", async () => {
    vi.spyOn(api, "provisionStatus").mockResolvedValue(status([true, false, true]));
    renderIt();
    await waitFor(() =>
      expect(screen.getByRole("link", { name: "entre aquí con su correo" })).toHaveAttribute(
        "href",
        "https://lapalma.bascula.engp.io/entrar",
      ),
    );
  });

  it("goes to the farm's own address once ready, on the waiting page only", async () => {
    vi.spyOn(api, "provisionStatus").mockResolvedValue(status([true, true, true]));
    const assign = vi.spyOn(goTo, "assign").mockImplementation(() => undefined);
    renderIt(true);
    expect(await screen.findByText("¡Su finca está lista!")).toBeInTheDocument();
    await new Promise((r) => setTimeout(r, REDIRECT_MS + 200));
    expect(assign).toHaveBeenCalledWith("https://lapalma.bascula.engp.io/tablero");
  }, REDIRECT_MS + 3000);

  it("stays put when embedded (console, super-admin)", async () => {
    vi.spyOn(api, "provisionStatus").mockResolvedValue(status([true, true, true]));
    const assign = vi.spyOn(goTo, "assign").mockImplementation(() => undefined);
    renderIt(false);
    expect(await screen.findByText("¡Su finca está lista!")).toBeInTheDocument();
    await new Promise((r) => setTimeout(r, REDIRECT_MS + 200));
    expect(assign).not.toHaveBeenCalled();
  }, REDIRECT_MS + 3000);

  it("explains the database step in plain words", async () => {
    vi.spyOn(api, "provisionStatus").mockResolvedValue(status([false, false, false]));
    renderIt();
    expect(await screen.findByText(/Creamos una base de datos exclusiva para su finca\./)).toBeInTheDocument();
  });

  it("hides the email option when the platform cannot send email", async () => {
    vi.spyOn(api, "provisionStatus").mockResolvedValue(status([true, false, false], { notifyAvailable: false }));
    renderIt();
    expect(await screen.findByTestId("step-web")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Avísenme por correo/ })).toBeNull();
  });

  it("asks for the email and says the page can be closed", async () => {
    vi.spyOn(api, "provisionStatus").mockResolvedValue(
      status([true, false, false], { notifyAvailable: true, notifyRequested: false }),
    );
    const ask = vi.spyOn(api, "requestReadyEmail").mockResolvedValue({ slug: "lapalma", requested: true });
    renderIt();
    const button = await screen.findByRole("button", { name: /Avísenme por correo cuando esté lista/ });
    fireEvent.click(button);
    expect(await screen.findByText(/Ya puede cerrar esta página/)).toBeInTheDocument();
    expect(ask).toHaveBeenCalledWith("lapalma");
  });

  it("remembers that the email was already asked for", async () => {
    vi.spyOn(api, "provisionStatus").mockResolvedValue(
      status([true, false, false], { notifyAvailable: true, notifyRequested: true }),
    );
    renderIt();
    expect(await screen.findByTestId("ready-email-done")).toBeInTheDocument();
  });

  it("shows real progress: a bar with the percentage, the current step and every stage", async () => {
    vi.spyOn(api, "provisionStatus").mockResolvedValue({
      ...status([true, false, false]),
      percent: 42,
      current: "Estamos creando la base de datos exclusiva de su finca.",
      source: "cluster",
      stages: [
        { key: "received", label: "Solicitud recibida", state: "done", weight: 2 },
        { key: "namespace", label: "Espacio propio", state: "done", weight: 40 },
        { key: "database", label: "Base de datos", state: "active", weight: 20 },
        { key: "site", label: "Dirección abierta", state: "pending", weight: 38 },
      ],
    });
    renderIt();
    expect(await screen.findByTestId("stage-database")).toHaveAttribute("data-state", "active");
    expect(screen.getByTestId("stage-received")).toHaveAttribute("data-state", "done");
    expect(screen.getByTestId("stage-site")).toHaveAttribute("data-state", "pending");
    expect(screen.getByTestId("provision-percent")).toHaveTextContent("42");
    expect(screen.getByRole("progressbar")).toHaveAttribute("aria-valuenow", "42");
    expect(screen.getByTestId("provision-current")).toHaveTextContent("Estamos creando la base de datos");
    expect(screen.getByText("Base de datos — en curso")).toBeInTheDocument();
    expect(screen.queryByTestId("provision-note")).toBeNull();
  });

  it("says plainly when it cannot see every detail", async () => {
    vi.spyOn(api, "provisionStatus").mockResolvedValue({
      ...status([false, false, false]),
      percent: 7,
      current: "Estamos registrando su finca en nuestro sistema.",
      source: "pipeline",
      note: "No podemos ver todos los detalles en este momento; le mostramos el avance que sí conocemos. Su finca sigue preparándose.",
      stages: [
        { key: "received", label: "Solicitud recibida", state: "done", weight: 2 },
        { key: "pipeline_started", label: "Preparación iniciada", state: "done", weight: 5 },
        { key: "pipeline_done", label: "Preparación registrada", state: "active", weight: 93 },
      ],
    });
    renderIt();
    expect(await screen.findByTestId("provision-note")).toHaveTextContent("No podemos ver todos los detalles");
    expect(screen.getByTestId("provision-percent")).toHaveTextContent("7");
  });
});
