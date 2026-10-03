/**
 * The demo-data card: shown only on an empty farm, it asks before loading,
 * shows progress while it loads, says what it created, and shows the error
 * when loading fails. The loader itself is covered by `demoData.test.ts`.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { ThemeProvider } from "@mui/material";
import { DemoDataCard } from "./DemoDataCard";
import { AuthProvider } from "../../auth/AuthContext";
import { setTokens } from "../../api/client";
import { invalidateRefs } from "../../api/refs";
import { theme } from "../../theme";
import * as db from "../../mocks/db";
import type { DemoProgress } from "./demoData";

const demo = vi.hoisted(() => ({
  farmIsEmpty: vi.fn<() => Promise<boolean>>(),
  loadDemoData:
    vi.fn<
      (
        today: string,
        onProgress?: (p: DemoProgress) => void,
      ) => Promise<{ workers: number; weighings: number }>
    >(),
}));
vi.mock("./demoData", () => demo);

const OWNER = "0192f3a0-0001-7000-8000-000000000001";

function renderCard() {
  return render(
    <ThemeProvider theme={theme}>
      <MemoryRouter>
        <AuthProvider>
          <DemoDataCard />
        </AuthProvider>
      </MemoryRouter>
    </ThemeProvider>,
  );
}

beforeEach(() => {
  db.resetDb();
  invalidateRefs();
  demo.farmIsEmpty.mockReset();
  demo.loadDemoData.mockReset();
  const now = Date.now();
  setTokens({
    accessToken: `mock-access.${OWNER}.${db.FARM_ID}.${now}.${now + 900_000}`,
    refreshToken: `mock-refresh.${OWNER}`,
  });
});

const askAndConfirm = async (user: ReturnType<typeof userEvent.setup>) => {
  await user.click(
    await screen.findByRole("button", { name: "Cargar datos de demostración" }),
  );
  await user.click(
    within(await screen.findByRole("dialog")).getByRole("button", {
      name: "Cargar",
    }),
  );
  await waitFor(() =>
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
  );
};

describe("on a farm with data", () => {
  it("shows nothing", async () => {
    demo.farmIsEmpty.mockResolvedValue(false);
    const { container } = renderCard();
    await waitFor(() => expect(demo.farmIsEmpty).toHaveBeenCalled());
    expect(container).toBeEmptyDOMElement();
  });
});

describe("on an empty farm", () => {
  it("can be asked and then left alone", async () => {
    demo.farmIsEmpty.mockResolvedValue(true);
    const user = userEvent.setup();
    renderCard();
    await user.click(
      await screen.findByRole("button", {
        name: "Cargar datos de demostración",
      }),
    );
    const dialog = await screen.findByRole("dialog");
    expect(
      within(dialog).getByText("¿Cargar datos de demostración?"),
    ).toBeInTheDocument();
    await user.click(within(dialog).getByRole("button", { name: /Cancelar/ }));
    await waitFor(() =>
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
    );
    expect(demo.loadDemoData).not.toHaveBeenCalled();
  });

  it("shows the progress and then what it created", async () => {
    demo.farmIsEmpty.mockResolvedValue(true);
    let finish: (v: { workers: number; weighings: number }) => void = () => {};
    demo.loadDemoData.mockImplementation((_today, onProgress) => {
      onProgress?.({ done: 3, total: 10 });
      return new Promise((resolve) => {
        finish = resolve;
      });
    });
    const user = userEvent.setup();
    renderCard();
    await askAndConfirm(user);
    expect(await screen.findByText("Cargando… 3 de 10")).toBeInTheDocument();
    expect(screen.getByRole("progressbar")).toBeInTheDocument();
    finish({ workers: 6, weighings: 120 });
    expect(
      await screen.findByText(
        "Listo: 6 empleados y 120 pesadas de las últimas cuatro semanas.",
      ),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Cargar datos de demostración" }),
    ).not.toBeInTheDocument();
    expect(demo.loadDemoData.mock.calls[0][0]).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it("shows why loading failed, and the notice can be closed", async () => {
    demo.farmIsEmpty.mockResolvedValue(true);
    demo.loadDemoData.mockRejectedValue(new Error("se cayó la red"));
    const user = userEvent.setup();
    renderCard();
    await askAndConfirm(user);
    await waitFor(() =>
      expect(document.querySelector(".MuiAlert-colorError")).not.toBeNull(),
    );
    expect(
      screen.getByRole("button", { name: "Cargar datos de demostración" }),
    ).toBeInTheDocument();
    await user.click(
      within(
        document.querySelector(".MuiAlert-colorError") as HTMLElement,
      ).getByRole("button", {
        name: /close|cerrar/i,
      }),
    );
    await waitFor(() =>
      expect(document.querySelector(".MuiAlert-colorError")).toBeNull(),
    );
  });
});
