// SPDX-License-Identifier: MIT
/**
 * The chart edges the main chart tests leave: a measuring hook with nothing
 * to measure, an observer that reports no entry, a sparkline that starts and
 * ends on an unknown week, and a hovered bar whose week turns unknown.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, renderHook, screen } from "@testing-library/react";
import { Sparkline, WeekBars, useWidth, type CurvePoint } from "./charts";

const fmt = (v: number) => `${v} kg`;

afterEach(() => vi.restoreAllMocks());

describe("useWidth", () => {
  it("stays at zero while the ref is attached to nothing", () => {
    const { result } = renderHook(() => useWidth<HTMLDivElement>());
    expect(result.current.width).toBe(0);
    expect(result.current.ref.current).toBeNull();
  });

  it("reads an observer callback with no entries as no width", () => {
    const original = globalThis.ResizeObserver;
    class EmptyObserver {
      constructor(private readonly cb: ResizeObserverCallback) {}
      observe() {
        this.cb([], this as unknown as ResizeObserver);
      }
      unobserve() {}
      disconnect() {}
    }
    globalThis.ResizeObserver = EmptyObserver as unknown as typeof ResizeObserver;
    try {
      render(<WeekBars points={[{ key: "a", label: "1 ago", value: 3 }]} format={fmt} summary="Barras vacías" />);
      expect(screen.queryByRole("img", { name: "Barras vacías" })).not.toBeInTheDocument();
    } finally {
      globalThis.ResizeObserver = original;
    }
  });
});

describe("Sparkline", () => {
  it("draws the known run between unknown weeks at both ends", () => {
    const { container } = render(
      <Sparkline values={[null, null, 10, 20, null]} label="Kilos por semana del lote" />,
    );
    expect(screen.getByRole("img", { name: "Kilos por semana del lote" })).toBeInTheDocument();
    expect(container.querySelectorAll("path")).toHaveLength(2);
    expect(container.querySelectorAll("circle")).toHaveLength(1);
  });
});

describe("WeekBars", () => {
  it("says «sin dato» when the hovered week becomes unknown", () => {
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({
      width: 640, height: 200, top: 0, left: 0, right: 640, bottom: 200, x: 0, y: 0, toJSON: () => ({}),
    } as DOMRect);
    const points: CurvePoint[] = [
      { key: "a", label: "1 ago", value: 30 },
      { key: "b", label: "8 ago", value: 40 },
    ];
    const { container, rerender } = render(<WeekBars points={points} format={fmt} summary="Barras" />);
    fireEvent.mouseEnter(container.querySelectorAll("rect[rx]")[0]);
    expect(screen.getAllByText("30 kg").length).toBeGreaterThan(0);
    // The data reloads under the pointer and that week is no longer known.
    rerender(
      <WeekBars points={[{ ...points[0], value: null }, points[1]]} format={fmt} summary="Barras" />,
    );
    expect(screen.getByText("sin dato")).toBeInTheDocument();
  });
});
