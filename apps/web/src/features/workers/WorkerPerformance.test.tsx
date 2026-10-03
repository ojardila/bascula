/**
 * The «Rendimiento» card on a worker's profile, drawn at a real width so the
 * weekly and daily charts are actually laid out (jsdom measures everything
 * as zero wide, which skipped the drawing entirely).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, screen, waitFor } from "@testing-library/react";
import { http, HttpResponse } from "msw";
import { WorkerPerformance } from "./WorkerPerformance";
import { renderWithAuth, signInOwner } from "../../test/renderWithAuth";
import { api } from "../../api/endpoints";
import { invalidateRefs } from "../../api/refs";
import { server } from "../../mocks/node";

const MARIA = "0192f3a0-0006-7000-8000-000000000001";
const JHON = "0192f3a0-0006-7000-8000-000000000002";
const LUZ = "0192f3a0-0006-7000-8000-000000000003";
const TEAM = "0192f3a0-0006-7000-8000-0000000000aa";

beforeEach(() => {
  signInOwner();
  invalidateRefs();
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({
    width: 640,
    height: 240,
    top: 0,
    left: 0,
    right: 640,
    bottom: 240,
    x: 0,
    y: 0,
    toJSON: () => ({}),
  } as DOMRect);
});

afterEach(() => vi.restoreAllMocks());

async function createTeam() {
  await api.createWorker({
    id: TEAM,
    name: "Los Primos",
    tag: "40",
    kind: "equipo",
    memberIds: [JHON, LUZ],
  } as Parameters<typeof api.createWorker>[0]);
  invalidateRefs();
}

describe("WorkerPerformance", () => {
  it("draws the weeks and the days, and selecting a week describes it", async () => {
    const { container } = renderWithAuth(
      <WorkerPerformance workerId={MARIA} />,
    );
    expect(await screen.findByText("Rendimiento")).toBeInTheDocument();
    await waitFor(() =>
      expect(container.querySelectorAll("svg rect").length).toBeGreaterThan(0),
    );
    const slots = [...container.querySelectorAll('rect[style*="pointer"]')];
    expect(slots.length).toBeGreaterThan(1);
    fireEvent.click(slots[0]);
    fireEvent.mouseEnter(slots[slots.length - 1]);
    expect(container.textContent).toMatch(/kg/);
  });

  it("hides itself from a role that may not see it", async () => {
    server.use(
      http.get("*/v1/workers/:id/performance", () =>
        HttpResponse.json(
          { error: { code: "FORBIDDEN", message: "no", details: {} } },
          { status: 403 },
        ),
      ),
    );
    const { container } = renderWithAuth(
      <WorkerPerformance workerId={MARIA} />,
    );
    await waitFor(() =>
      expect(container.querySelector("#rendimiento")).toBeNull(),
    );
    expect(screen.queryByText("Rendimiento")).not.toBeInTheDocument();
  });

  it("shows a failure without taking the profile down", async () => {
    server.use(
      http.get("*/v1/workers/:id/performance", () =>
        HttpResponse.json(
          { error: { code: "INTERNAL", message: "se cayó", details: {} } },
          { status: 500 },
        ),
      ),
    );
    renderWithAuth(<WorkerPerformance workerId={MARIA} />);
    expect(await screen.findByRole("alert")).toBeInTheDocument();
  });

  it("explains a team member's share and a team's per-person kilos", async () => {
    await createTeam();
    const { unmount } = renderWithAuth(<WorkerPerformance workerId={JHON} />);
    expect(await screen.findByText("Rendimiento")).toBeInTheDocument();
    await waitFor(() =>
      expect(
        screen.queryByLabelText("Cargando el rendimiento"),
      ).not.toBeInTheDocument(),
    );
    unmount();
    renderWithAuth(<WorkerPerformance workerId={TEAM} />);
    expect(await screen.findByText("Rendimiento")).toBeInTheDocument();
    await waitFor(() =>
      expect(
        screen.queryByLabelText("Cargando el rendimiento"),
      ).not.toBeInTheDocument(),
    );
  });

  describe("with a crafted answer", () => {
    const today = "2026-03-12"; // a Thursday
    const monday = (i: number) => {
      const d = new Date(Date.UTC(2026, 2, 9) - 7 * 86_400_000 * (11 - i));
      return d.toISOString().slice(0, 10);
    };
    const days = (kgs: (number | null)[]) =>
      kgs.map((kg, i) => ({
        day: `2026-03-${String(9 + i).padStart(2, "0")}`,
        records: kg === null ? 0 : 1,
        kg,
        future: i > 3,
      }));
    const weeks = (kgs: (number | null)[]) =>
      kgs.map((kg, i) => ({
        weekStart: monday(i),
        records: kg === null ? 0 : 2,
        kg,
        recordsNotInKg: 0,
        daysWorked: kg === null ? 0 : 3,
        farmAvgKg: i % 3 === 0 ? null : 80,
        farmPickers: 4,
        finished: i < 11,
      }));
    const base = {
      scope: "harvest",
      employeeId: MARIA,
      kind: "persona",
      members: 0,
      team: null,
      today,
      thisWeek: "2026-03-09",
      lastRecordOn: "2026-03-11",
      summary: {
        thisWeekKg: 120,
        lastWeekToDateKg: 60,
        lastWeekKg: 200,
        recentFrom: "2026-02-16",
        recentKg: 600,
        recentDaysWorked: 10,
        kgPerDayWorked: 60,
      },
      weeks: weeks([null, 40, 55, null, 70, 90, 110, 95, 80, 130, 150, 120]),
      days: days([30, 0, 90, null, null, null, null]),
      plots: [
        { plotId: "p1", name: "El Alto", kg: 300, records: 5 },
        { plotId: "p2", name: "La Cuchilla", kg: 120, records: 3 },
        { plotId: "p3", name: "Bajo del Río", kg: 60, records: 2 },
        { plotId: "p4", name: "San José", kg: 40, records: 1 },
        { plotId: "p5", name: "El Mirador", kg: 30, records: 1 },
        { plotId: "p6", name: "La Palma", kg: 20, records: 1 },
        { plotId: "p7", name: "Villa Nueva", kg: 10, records: 1 },
      ],
      unattributedKg: 25,
      recordsNotInKg: 1,
    };

    function answer(body: Record<string, unknown>) {
      server.use(
        http.get("*/v1/workers/:id/performance", () => HttpResponse.json(body)),
      );
    }

    it("draws a team's figures per person, every lote and the leftovers", async () => {
      answer({ ...base, kind: "equipo", members: 3 });
      const { container } = renderWithAuth(
        <WorkerPerformance workerId={MARIA} />,
      );
      expect(
        await screen.findByText("Esta semana, juntos"),
      ).toBeInTheDocument();
      expect(screen.getAllByText(/c\/u/).length).toBeGreaterThan(0);
      expect(screen.getByText("El Alto")).toBeInTheDocument();
      expect(
        screen.getByText(/no se cuenta en estas gráficas/),
      ).toBeInTheDocument();
      const slots = [...container.querySelectorAll('rect[style*="pointer"]')];
      for (const slot of slots) fireEvent.click(slot);
    });

    it("explains a member's share with no days worked and no lotes", async () => {
      answer({
        ...base,
        team: { id: TEAM, name: "Los Primos", members: 2 },
        summary: {
          ...base.summary,
          thisWeekKg: null,
          lastWeekToDateKg: 90,
          kgPerDayWorked: null,
          recentDaysWorked: 0,
        },
        days: days([null, null, null, null, null, null, null]),
        plots: [],
        unattributedKg: null,
        recordsNotInKg: 3,
      });
      renderWithAuth(<WorkerPerformance workerId={MARIA} />);
      expect(
        await screen.findByText("Su parte esta semana"),
      ).toBeInTheDocument();
      expect(screen.getByText(/Los Primos/)).toBeInTheDocument();
      expect(screen.getByText("Todavía sin recolección.")).toBeInTheDocument();
      expect(
        screen.getByText("Sin días trabajados en 4 semanas."),
      ).toBeInTheDocument();
      expect(
        screen.getByText(/no se cuentan en estas gráficas/),
      ).toBeInTheDocument();
    });

    it("says when there is nothing in the window", async () => {
      answer({
        ...base,
        lastRecordOn: "2025-06-01",
        summary: { ...base.summary, thisWeekKg: 50, lastWeekToDateKg: 50 },
        weeks: weeks(Array.from({ length: 12 }, () => null)),
        recordsNotInKg: 0,
      });
      renderWithAuth(<WorkerPerformance workerId={MARIA} />);
      expect(
        await screen.findByText(/No tiene recolecciones en las últimas/),
      ).toBeInTheDocument();
      expect(screen.getByText("Igual")).toBeInTheDocument();
    });

    it("says when the person has never been weighed", async () => {
      answer({ ...base, lastRecordOn: null });
      renderWithAuth(<WorkerPerformance workerId={MARIA} />);
      expect(await screen.findByText("Rendimiento")).toBeInTheDocument();
      await waitFor(() =>
        expect(
          screen.queryByLabelText("Cargando el rendimiento"),
        ).not.toBeInTheDocument(),
      );
      expect(screen.queryByText("Kilos por semana")).not.toBeInTheDocument();
    });
  });
});
