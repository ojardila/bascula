// SPDX-License-Identifier: MIT
/**
 * The weekly chart at its edges — every week at zero, a running week whose
 * farm average hops off a dashed line, every week finished — and the daily
 * chart with kilos on top of its bars.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import { http, HttpResponse } from "msw";
import { DaysChart, WorkerPerformance } from "./WorkerPerformance";
import { renderWithAuth, signInOwner } from "../../test/renderWithAuth";
import { invalidateRefs } from "../../api/refs";
import { server } from "../../mocks/node";
import type { WirePerformanceWeek, WireWorkerPerformanceReport } from "../../api/wire";

const MARIA = "0192f3a0-0006-7000-8000-000000000001";

beforeEach(() => {
  signInOwner();
  invalidateRefs();
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({
    width: 640, height: 240, top: 0, left: 0, right: 640, bottom: 240, x: 0, y: 0,
    toJSON: () => ({}),
  } as DOMRect);
});

afterEach(() => vi.restoreAllMocks());

const week = (weekStart: string, over: Partial<WirePerformanceWeek>): WirePerformanceWeek => ({
  weekStart, records: 1, kg: 0, recordsNotInKg: 0, daysWorked: 1,
  farmAvgKg: null, farmPickers: 3, finished: true, ...over,
});

function report(weeks: WirePerformanceWeek[]): WireWorkerPerformanceReport {
  return {
    scope: "harvest", employeeId: MARIA, kind: "persona", members: 0, team: null,
    today: "2026-08-26", thisWeek: "2026-08-24", lastRecordOn: "2026-08-25",
    summary: {
      thisWeekKg: 30, lastWeekToDateKg: 20, lastWeekKg: 80, recentFrom: "2026-07-27",
      recentKg: 160, recentDaysWorked: 4, kgPerDayWorked: 40,
    },
    weeks,
    days: [
      { day: "2026-08-24", records: 1, kg: 30, future: false },
      { day: "2026-08-25", records: 0, kg: null, future: false },
      { day: "2026-08-26", records: 0, kg: null, future: false },
      { day: "2026-08-27", records: 0, kg: null, future: true },
      { day: "2026-08-28", records: 0, kg: null, future: true },
      { day: "2026-08-29", records: 0, kg: null, future: true },
      { day: "2026-08-30", records: 0, kg: null, future: true },
    ],
    plots: [],
    unattributedKg: null,
    recordsNotInKg: 0,
  } as WireWorkerPerformanceReport;
}

function serve(weeks: WirePerformanceWeek[]) {
  server.use(
    http.get("*/v1/workers/:id/performance", () => HttpResponse.json(report(weeks))),
  );
}

async function draw() {
  const view = renderWithAuth(<WorkerPerformance workerId={MARIA} />);
  expect(await screen.findByText("Rendimiento")).toBeInTheDocument();
  await waitFor(() =>
    expect(view.container.querySelectorAll('rect[style*="pointer"]').length).toBeGreaterThan(0),
  );
  return view.container;
}

describe("WorkerPerformance weekly chart", () => {
  it("draws weeks that all came to zero kilos", async () => {
    serve([week("2026-08-17", {}), week("2026-08-24", { finished: false })]);
    const container = await draw();
    expect(container.querySelectorAll('rect[style*="pointer"]')).toHaveLength(2);
    expect(container.querySelector("path")).toBeNull();
  });

  it("joins the finished weeks' average and dashes the hop into the running week", async () => {
    serve([
      week("2026-08-10", { kg: 50, farmAvgKg: 100 }),
      week("2026-08-17", { kg: 80, farmAvgKg: 120 }),
      week("2026-08-24", { kg: 30, farmAvgKg: 40, finished: false }),
    ]);
    const container = await draw();
    const paths = [...container.querySelectorAll("path")];
    expect(paths.some((p) => p.getAttribute("stroke-dasharray") === "5 4")).toBe(true);
    expect(paths.some((p) => /^M.* L/.test(p.getAttribute("d") ?? "") && !p.getAttribute("stroke-dasharray"))).toBe(true);
    expect(container.querySelector('rect[opacity="0.5"]')).not.toBeNull();
  });

  it("draws a solid average line when every week is finished", async () => {
    serve([
      week("2026-08-17", { kg: 80, farmAvgKg: 120 }),
      week("2026-08-24", { kg: 30, farmAvgKg: 40 }),
    ]);
    const container = await draw();
    const paths = [...container.querySelectorAll("path")];
    expect(paths.some((p) => p.getAttribute("stroke-dasharray") === "5 4")).toBe(false);
    expect(paths.length).toBeGreaterThan(0);
  });
});

describe("DaysChart", () => {
  it("writes the kilos over a day's bar", async () => {
    const days = report([]).days;
    renderWithAuth(<DaysChart days={days} />);
    const chart = await screen.findByRole("img", { name: /Kilos por día esta semana/ });
    expect(chart.querySelectorAll("rect")).toHaveLength(1);
    expect(chart).toHaveTextContent("30");
  });
});
