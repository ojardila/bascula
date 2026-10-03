// SPDX-License-Identifier: MIT
/**
 * The spotlight path of the tour host, through the lazily loaded Joyride
 * wrapper: the card drawn as Joyride's tooltip, a target that never shows up
 * (the same card, centred, so the tour never gets stuck), and the closing
 * dialog when the farm's price cannot be read.
 *
 * react-joyride itself is replaced by a stand-in that renders the tooltip it
 * is given and reports the events a real one would, so these tests pin our
 * wiring rather than the library's timers.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { ThemeProvider } from "@mui/material";
import type { ComponentType } from "react";
import { http, HttpResponse } from "msw";
import { TourHost } from "./TourHost";
import { TourContext, type TourContextValue } from "./TourContext";
import { OWNER_DONE, stepOf, type TourName } from "./steps";
import { AuthProvider } from "../../auth/AuthContext";
import { invalidateRefs } from "../../api/refs";
import { theme } from "../../theme";
import { server } from "../../mocks/node";
import { signInOwner } from "../../test/renderWithAuth";

vi.mock("react-joyride", () => ({
  EVENTS: { TARGET_NOT_FOUND: "error:target_not_found", STEP_AFTER: "step:after" },
  Joyride: (props: {
    steps: { target: string; content: string; placement: string; data: unknown }[];
    tooltipComponent: ComponentType<{ step: { data: unknown }; tooltipProps: object }>;
    onEvent: (d: { type: string }) => void;
  }) => {
    const Tip = props.tooltipComponent;
    const step = props.steps[0];
    return (
      <div data-testid="joyride" data-target={step.target} data-placement={step.placement}>
        <Tip step={step} tooltipProps={{ "data-testid": "tooltip" }} />
        <button onClick={() => props.onEvent({ type: "step:after" })}>evento cualquiera</button>
        <button onClick={() => props.onEvent({ type: "error:target_not_found" })}>sin objetivo</button>
      </div>
    );
  },
}));

function fakeTour(at: [TourName, number], over: Partial<TourContextValue> = {}): TourContextValue {
  const def = stepOf(at[0], at[1])!;
  return {
    current: { tour: at[0], n: at[1], def },
    paused: false,
    saved: {},
    loaded: true,
    available: "owner",
    summary: { owners: 0, people: 0, plot: null, priceCents: null },
    start: vi.fn(),
    resume: vi.fn(),
    goTo: vi.fn(),
    pause: vi.fn(),
    later: vi.fn(),
    dismiss: vi.fn(),
    finish: vi.fn(),
    isAt: () => false,
    registerAction: () => () => {},
    runAction: async () => true,
    note: vi.fn(),
    ...over,
  };
}

function renderHost(value: TourContextValue, path: string) {
  return render(
    <ThemeProvider theme={theme}>
      <MemoryRouter initialEntries={[path]}>
        <AuthProvider>
          <TourContext.Provider value={value}>
            <Routes>
              <Route path="*" element={<TourHost />} />
            </Routes>
          </TourContext.Provider>
        </AuthProvider>
      </MemoryRouter>
    </ThemeProvider>,
  );
}

beforeEach(() => {
  invalidateRefs();
});

describe("TourHost, a spotlight step", () => {
  it("draws the step's card as the spotlight's tooltip, and centres it when the target never appears", async () => {
    signInOwner();
    const def = stepOf("owner", 1)!;
    const user = userEvent.setup();
    renderHost(fakeTour(["owner", 1]), def.route!);

    const joy = await screen.findByTestId("joyride");
    expect(joy).toHaveAttribute("data-target", def.target);
    expect(screen.getByTestId("tooltip")).toBeInTheDocument();
    expect(screen.getByRole("dialog", { name: new RegExp(`Paso 1 de \\d+: ${def.title}`) })).toBeInTheDocument();

    // An unrelated event changes nothing.
    await user.click(screen.getByRole("button", { name: "evento cualquiera" }));
    expect(screen.getByTestId("joyride")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "sin objetivo" }));
    await waitFor(() => expect(screen.queryByTestId("joyride")).not.toBeInTheDocument());
    expect(screen.getByRole("dialog", { name: new RegExp(def.title) })).toBeInTheDocument();
  });

  it("spotlights the whole page, placed automatically, for a step with no target", async () => {
    signInOwner();
    const real = stepOf("owner", 1)!;
    const def = { ...real, target: undefined, placement: undefined };
    const value = fakeTour(["owner", 1]);
    value.current = { tour: "owner", n: 1, def };
    renderHost(value, real.route!);
    const joy = await screen.findByTestId("joyride");
    expect(joy).toHaveAttribute("data-target", "body");
    expect(joy).toHaveAttribute("data-placement", "auto");
  });
});

describe("TourHost, the closing dialog", () => {
  it.each([
    [{ owners: 0, people: 1 }, "Invitó a 1 persona"],
    [{ owners: 2, people: 0 }, "Invitó a 2 socios"],
  ])("names only who was invited (%o)", async (who, sentence) => {
    signInOwner();
    renderHost(
      fakeTour(["owner", OWNER_DONE], {
        summary: { ...who, plot: null, priceCents: 120000 },
      }),
      "/cosecha",
    );
    expect(await screen.findByText(sentence)).toBeInTheDocument();
  });

  it("still closes the tour when the farm's price cannot be read", async () => {
    signInOwner();
    let asked = 0;
    server.use(
      http.get("*/v1/prices/base", () => {
        asked++;
        return HttpResponse.json({ error: { code: "internal", message: "boom" } }, { status: 500 });
      }),
    );
    renderHost(fakeTour(["owner", OWNER_DONE]), "/cosecha");
    expect(await screen.findByText("¡Su finca quedó lista!")).toBeInTheDocument();
    await waitFor(() => expect(asked).toBeGreaterThan(0));
    await new Promise((r) => setTimeout(r, 50));
    expect(screen.queryByText(/Precio del kilo:/)).not.toBeInTheDocument();
  });
});
