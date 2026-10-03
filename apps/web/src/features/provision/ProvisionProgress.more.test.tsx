/**
 * The waiting screen's other states: a farm this browser cannot see, a
 * passing network error, the address waiting on an email confirmation, the
 * compact (dialog) look, and a ready-email request that fails.
 */
import { describe, expect, it, vi, afterEach } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { ThemeProvider } from "@mui/material";
import { api } from "../../api/endpoints";
import { ApiError } from "../../api/errors";
import type { ProvisionStatus } from "../../api/types";
import { theme } from "../../theme";
import { ProvisionProgress } from "./ProvisionProgress";

function status(extra: Partial<ProvisionStatus> = {}): ProvisionStatus {
  return {
    slug: "lapalma",
    url: "https://lapalma.bascula.engp.io",
    dedicated: true,
    steps: [
      { key: "database", done: true },
      { key: "app", done: false },
      { key: "web", done: false },
    ],
    ready: false,
    slow: false,
    elapsedSeconds: 30,
    ...extra,
  };
}

function renderIt(compact = false) {
  return render(
    <ThemeProvider theme={theme}>
      <MemoryRouter>
        <ProvisionProgress slug="lapalma" pollMs={10} compact={compact} />
      </MemoryRouter>
    </ThemeProvider>,
  );
}

afterEach(() => vi.restoreAllMocks());

describe("a farm whose progress cannot be shown", () => {
  it("says so plainly and offers to sign in by email instead", async () => {
    vi.spyOn(api, "provisionStatus").mockRejectedValue(
      new ApiError(404, { error: { code: "NOT_FOUND", message: "no" } }),
    );
    renderIt();
    expect(
      await screen.findByText(/No podemos mostrar el avance/),
    ).toHaveTextContent("lapalma.bascula.engp.io");
    expect(
      screen.getByRole("link", { name: "entre con su correo" }),
    ).toHaveAttribute("href", "/entrar");
  });

  it("rides out a passing error and keeps asking", async () => {
    const spy = vi
      .spyOn(api, "provisionStatus")
      .mockRejectedValueOnce(new ApiError(503, null))
      .mockResolvedValue(status());
    renderIt();
    await waitFor(() =>
      expect(spy.mock.calls.length).toBeGreaterThanOrEqual(2),
    );
    expect(await screen.findByTestId("step-web")).toBeInTheDocument();
    expect(screen.queryByText(/No podemos mostrar el avance/)).toBeNull();
  });
});

describe("waiting on the email confirmation", () => {
  it.each([false, true])(
    "asks to open the link (compact: %s)",
    async (compact) => {
      vi.spyOn(api, "provisionStatus").mockResolvedValue(
        status({ awaitingVerification: true }),
      );
      renderIt(compact);
      expect(
        await screen.findByTestId("provision-awaiting-email"),
      ).toHaveTextContent("Confirme su correo");
      expect(
        screen.getByText(/El enlace sirve por 48 horas/),
      ).toBeInTheDocument();
    },
  );

  it("moves on by itself once the address is confirmed", async () => {
    vi.spyOn(api, "provisionStatus")
      .mockResolvedValueOnce(status({ awaitingVerification: true }))
      .mockResolvedValue(status());
    renderIt();
    await screen.findByTestId("provision-awaiting-email");
    expect(await screen.findByText("Preparando su finca…")).toBeInTheDocument();
  });
});

describe("in a dialog", () => {
  it("shows the ready farm's address", async () => {
    vi.spyOn(api, "provisionStatus").mockResolvedValue(
      status({
        ready: true,
        steps: [
          { key: "database", done: true },
          { key: "app", done: true },
          { key: "web", done: true },
        ],
      }),
    );
    renderIt(true);
    expect(await screen.findByTestId("provision-ready")).toHaveTextContent(
      "lapalma.bascula.engp.io",
    );
  });
});

describe("the ready email", () => {
  it("says the request was not saved when it fails, and lets it be asked again", async () => {
    vi.spyOn(api, "provisionStatus").mockResolvedValue(
      status({ notifyAvailable: true, notifyRequested: false }),
    );
    const ask = vi
      .spyOn(api, "requestReadyEmail")
      .mockRejectedValueOnce(new ApiError(500, null))
      .mockResolvedValue({ slug: "lapalma", requested: true });
    renderIt();
    const button = await screen.findByRole("button", {
      name: /Avísenme por correo cuando esté lista/,
    });
    fireEvent.click(button);
    expect(
      await screen.findByText(
        "No pudimos guardar su pedido. Intente otra vez.",
      ),
    ).toBeInTheDocument();
    fireEvent.click(
      screen.getByRole("button", {
        name: /Avísenme por correo cuando esté lista/,
      }),
    );
    expect(
      await screen.findByText(/Ya puede cerrar esta página/),
    ).toBeInTheDocument();
    await waitFor(() => expect(ask).toHaveBeenCalledTimes(2));
  });
});
