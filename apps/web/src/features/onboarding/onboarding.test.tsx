import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ThemeProvider } from "@mui/material";
import { theme } from "../../theme";
import { OWNER_DONE, OWNER_STEPS, TOTALS, WEIGHER_STEPS, autoStartAt, ownerPartsDone, resumeIndex, stepOf } from "./steps";
import { TourCard } from "./TourCard";
import { TourContext, type TourContextValue } from "./TourContext";

describe("the owner's tour, as approved", () => {
  it("is a welcome, eleven numbered steps and a closing screen", () => {
    expect(OWNER_STEPS.map((s) => s.n)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, OWNER_DONE]);
    expect(TOTALS.owner).toBe(11);
    expect(OWNER_STEPS.filter((s) => s.kind !== "center")).toHaveLength(11);
    // 2 about the price, 1 about other owners, 4 about administrators and
    // weighers, 4 about the first lote.
    expect(OWNER_STEPS.filter((s) => s.section === "Su precio")).toHaveLength(2);
    expect(OWNER_STEPS.filter((s) => s.section === "Su gente")).toHaveLength(5);
    expect(OWNER_STEPS.filter((s) => s.section === "Sus lotes")).toHaveLength(4);
    expect(stepOf("owner", 3)?.title).toBe("¿Tiene socios en la finca?");
  });

  it("the weigher's is two steps and starts on «Registrar una recolección»", () => {
    expect(WEIGHER_STEPS).toHaveLength(2);
    expect(WEIGHER_STEPS[0].title).toBe("Aquí anota cada pesada");
    expect(WEIGHER_STEPS[0].target).toBe('[data-tour="record-one"]');
  });

  it("resumes steps that live inside a dialog or a form at the step that opens them", () => {
    expect(resumeIndex("owner", 5)).toBe(4);
    expect(resumeIndex("owner", 6)).toBe(4);
    expect(resumeIndex("owner", 10)).toBe(9);
    expect(resumeIndex("owner", 11)).toBe(9);
    expect(resumeIndex("owner", 7)).toBe(7);
    expect(resumeIndex("weigher", 0)).toBe(1);
  });

  it("counts the three parts the welcome promises", () => {
    expect(ownerPartsDone(0)).toBe(0);
    expect(ownerPartsDone(3)).toBe(1);
    expect(ownerPartsDone(8)).toBe(2);
    expect(ownerPartsDone(OWNER_DONE)).toBe(3);
  });
});

describe("the tour card", () => {
  it("says which step of how many, and offers «Soy el único dueño» as a full answer", () => {
    render(
      <ThemeProvider theme={theme}>
        <TourCard tour="owner" def={stepOf("owner", 3)!} />
      </ThemeProvider>,
    );
    expect(screen.getByText("Paso 3 de 11")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Soy el único dueño" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Invitar a otro dueño" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Atrás" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Saltar" })).toBeInTheDocument();
  });

  it.each([
    [3, "Soy el único dueño", "Invitar a otro dueño", 4],
    [4, "Nadie me ayuda", "Invitar a alguien", 8],
  ])("step %i: «%s» is as big as «%s» and moves the tour to step %i", async (n, no, yes, next) => {
    const goTo = vi.fn();
    const runAction = vi.fn(async () => true);
    const ctx = { goTo, runAction, later: vi.fn(), finish: vi.fn() } as unknown as TourContextValue;
    render(
      <ThemeProvider theme={theme}>
        <TourContext.Provider value={ctx}>
          <TourCard tour="owner" def={stepOf("owner", n)!} />
        </TourContext.Provider>
      </ThemeProvider>,
    );
    const noBtn = screen.getByRole("button", { name: no });
    const yesBtn = screen.getByRole("button", { name: yes });
    // Same weight: one filled, one outlined, both the big 56-pixel answer.
    expect(noBtn.parentElement).toBe(yesBtn.parentElement);
    expect(noBtn.className).toMatch(/MuiButton-outlined/);
    expect(yesBtn.className).toMatch(/MuiButton-contained/);
    await userEvent.click(noBtn);
    expect(goTo).toHaveBeenCalledWith(next);
    expect(runAction).not.toHaveBeenCalled();
  });

  it("has no «Atrás» on the first step, and always a «Saltar»", () => {
    render(
      <ThemeProvider theme={theme}>
        <TourCard tour="owner" def={stepOf("owner", 1)!} />
      </ThemeProvider>,
    );
    expect(screen.getByText("Paso 1 de 11")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Atrás" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Saltar" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Continuar" })).toBeInTheDocument();
  });
});

describe("when a tour starts by itself", () => {
  it("starts for anybody who has never seen it, whatever the farm looks like", () => {
    expect(autoStartAt("owner", undefined)).toBe(0);
    expect(autoStartAt("weigher", undefined)).toBe(1);
  });

  it("picks up a tour left open where it was", () => {
    expect(autoStartAt("owner", { step: 7, status: "active" })).toBe(7);
    expect(autoStartAt("owner", { step: 10, status: "active" })).toBe(9);
  });

  it("never again once finished or closed, and waits on the card after Saltar", () => {
    expect(autoStartAt("owner", { step: OWNER_DONE, status: "done" })).toBeNull();
    expect(autoStartAt("owner", { step: 3, status: "dismissed" })).toBeNull();
    expect(autoStartAt("owner", { step: 3, status: "later" })).toBeNull();
  });
});
