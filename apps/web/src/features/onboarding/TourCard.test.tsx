// SPDX-License-Identifier: MIT
import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { TourCard } from "./TourCard";
import type { TourStepDef } from "./steps";

const tour = vi.hoisted(() => ({
  goTo: vi.fn(),
  finish: vi.fn(),
  later: vi.fn(),
  runAction: vi.fn(async () => true),
}));

vi.mock("./TourContext", () => ({ useTour: () => tour }));

const step = (over: Partial<TourStepDef>): TourStepDef => ({
  n: 3,
  kind: "center",
  section: "Empleados",
  title: "Agregue a una persona",
  body: "Texto del paso.",
  primary: "Continuar",
  ...over,
});

beforeEach(() => {
  tour.goTo.mockReset();
  tour.finish.mockReset();
  tour.later.mockReset();
  tour.runAction.mockReset();
  tour.runAction.mockResolvedValue(true);
});

describe("TourCard", () => {
  it("moves to the next step, goes back and skips", async () => {
    const user = userEvent.setup();
    render(<TourCard tour="owner" def={step({})} />);
    expect(
      screen.getByRole("dialog", {
        name: "Paso 3 de 11: Agregue a una persona",
      }),
    ).toBeInTheDocument();
    expect(screen.getByText("Paso 3 de 11")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Continuar" }));
    expect(tour.goTo).toHaveBeenCalledWith(4);
    await user.click(screen.getByRole("button", { name: "Atrás" }));
    expect(tour.goTo).toHaveBeenCalledWith(2);
    await user.click(screen.getByRole("button", { name: "Saltar" }));
    expect(tour.later).toHaveBeenCalled();
  });

  it("goes back past the optional steps to step 4", async () => {
    const user = userEvent.setup();
    const { rerender } = render(<TourCard tour="owner" def={step({ n: 7 })} />);
    await user.click(screen.getByRole("button", { name: "Atrás" }));
    expect(tour.goTo).toHaveBeenLastCalledWith(4);
    rerender(<TourCard tour="owner" def={step({ n: 6 })} />);
    await user.click(screen.getByRole("button", { name: "Atrás" }));
    expect(tour.goTo).toHaveBeenLastCalledWith(4);
  });

  it("runs the page action and stays when it fails", async () => {
    const user = userEvent.setup();
    tour.runAction.mockResolvedValue(false);
    render(
      <TourCard tour="owner" def={step({ action: "guardar", next: 9 })} />,
    );
    await user.click(screen.getByRole("button", { name: "Continuar" }));
    expect(tour.runAction).toHaveBeenCalledWith("guardar");
    expect(tour.goTo).not.toHaveBeenCalled();
  });

  it("jumps to a numbered next step, or finishes, or stays", async () => {
    const user = userEvent.setup();
    const { rerender } = render(
      <TourCard tour="owner" def={step({ action: "a", next: 9 })} />,
    );
    await user.click(screen.getByRole("button", { name: "Continuar" }));
    expect(tour.goTo).toHaveBeenCalledWith(9);

    rerender(<TourCard tour="owner" def={step({ next: "finish" })} />);
    await user.click(screen.getByRole("button", { name: "Continuar" }));
    expect(tour.finish).toHaveBeenCalled();

    tour.goTo.mockReset();
    rerender(<TourCard tour="owner" def={step({ next: "stay" })} />);
    await user.click(screen.getByRole("button", { name: "Continuar" }));
    expect(tour.goTo).not.toHaveBeenCalled();
  });

  it("uses the override for the primary button and shows it busy", async () => {
    const user = userEvent.setup();
    let release: (v: boolean) => void = () => {};
    const onPrimary = vi.fn(
      () =>
        new Promise<boolean>((resolve) => {
          release = resolve;
        }),
    );
    render(
      <TourCard
        tour="weigher"
        def={step({ n: 1 })}
        onPrimary={onPrimary}
        elevated={false}
      />,
    );
    expect(
      screen.queryByRole("button", { name: "Atrás" }),
    ).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Continuar" }));
    expect(
      await screen.findByRole("button", { name: "Un momento…" }),
    ).toBeDisabled();
    release(true);
    await waitFor(() => expect(tour.goTo).toHaveBeenCalledWith(2));
  });

  it("offers a choice, a secondary link and an alternative", async () => {
    const user = userEvent.setup();
    const { rerender } = render(
      <TourCard
        tour="owner"
        def={step({
          noBack: true,
          choice: { label: "Soy el único dueño", next: 6 },
          secondary: { label: "Ya tengo empleados", next: 5 },
          alt: { label: "Ahora no", next: 8 },
        })}
      />,
    );
    expect(
      screen.queryByRole("button", { name: "Atrás" }),
    ).not.toBeInTheDocument();
    await user.click(
      screen.getByRole("button", { name: "Soy el único dueño" }),
    );
    expect(tour.goTo).toHaveBeenLastCalledWith(6);
    await user.click(
      screen.getByRole("button", { name: "Ya tengo empleados" }),
    );
    expect(tour.goTo).toHaveBeenLastCalledWith(5);
    await user.click(screen.getByRole("button", { name: "Ahora no" }));
    expect(tour.goTo).toHaveBeenLastCalledWith(8);
    await user.click(
      screen.getByRole("button", { name: "Saltar el recorrido" }),
    );
    expect(tour.later).toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "Continuar" }));
    expect(tour.goTo).toHaveBeenLastCalledWith(4);

    rerender(
      <TourCard
        tour="owner"
        def={step({ alt: { label: "Terminar", next: "finish" } })}
      />,
    );
    await user.click(screen.getByRole("button", { name: "Terminar" }));
    expect(tour.finish).toHaveBeenCalled();
  });
});
