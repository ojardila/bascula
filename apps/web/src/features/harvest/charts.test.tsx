import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { Curve, RowBar, Sparkline, WeekBars, type CurvePoint } from "./charts";

const fmt = (v: number) => `${v} kg`;

function measureAs(width: number) {
  return vi
    .spyOn(HTMLElement.prototype, "getBoundingClientRect")
    .mockReturnValue({
      width,
      height: 200,
      top: 0,
      left: 0,
      right: width,
      bottom: 200,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    } as DOMRect);
}

const weeks: CurvePoint[] = [
  { key: "w1", label: "1 ago", value: 100 },
  { key: "w2", label: "8 ago", value: 250 },
  { key: "w3", label: "15 ago", value: null },
  { key: "w4", label: "22 ago", value: 180 },
  { key: "w5", label: "29 ago", value: 220 },
  { key: "w6", label: "5 sep", value: 90, partial: true },
];

describe("Curve", () => {
  beforeEach(() => {
    measureAs(640);
  });
  afterEach(() => vi.restoreAllMocks());

  it("draws gaps, the dashed running week, the highlight and hover details", () => {
    const onSelect = vi.fn();
    const { container } = render(
      <Curve
        points={weeks}
        format={fmt}
        highlight={1}
        highlightLabel="pico"
        summary="Kilos por semana"
        onSelect={onSelect}
      />,
    );
    const svg = screen.getByRole("img", { name: "Kilos por semana" });
    expect(svg).toBeInTheDocument();
    expect(screen.getByText("pico")).toBeInTheDocument();
    // The dashed hop into the running week.
    expect(
      container.querySelector('path[stroke-dasharray="4 3"]'),
    ).not.toBeNull();
    // A circle per known point.
    expect(container.querySelectorAll("circle")).toHaveLength(5);

    const hits = container.querySelectorAll('rect[fill="transparent"]');
    expect(hits).toHaveLength(weeks.length);
    fireEvent.mouseEnter(hits[5]);
    expect(screen.getByText("semana en curso")).toBeInTheDocument();
    expect(screen.getAllByText("90 kg").length).toBeGreaterThan(0);
    fireEvent.mouseEnter(hits[2]);
    expect(screen.getByText("sin dato")).toBeInTheDocument();
    fireEvent.click(hits[3]);
    expect(onSelect).toHaveBeenCalledWith("w4");
    fireEvent.mouseLeave(svg);
    expect(screen.queryByText("sin dato")).not.toBeInTheDocument();
  });

  it("formats the highlight itself when no label is given and handles a single point", () => {
    render(
      <Curve
        points={[{ key: "a", label: "1 ago", value: 40 }]}
        format={fmt}
        highlight={0}
        summary="Uno"
      />,
    );
    expect(screen.getAllByText("40 kg").length).toBeGreaterThan(0);
  });

  it("thins the axis labels when there are many weeks", () => {
    const many: CurvePoint[] = Array.from({ length: 30 }, (_, i) => ({
      key: `k${i}`,
      label: `L${i}`,
      value: i % 7 === 3 ? null : i * 10,
    }));
    render(<Curve points={many} format={fmt} summary="Muchas" />);
    expect(screen.getByText("L0")).toBeInTheDocument();
    expect(screen.getByText("L29")).toBeInTheDocument();
    expect(screen.queryByText("L1")).not.toBeInTheDocument();
  });

  it("draws nothing for an all-unknown series but still renders the frame", () => {
    render(
      <Curve
        points={[
          { key: "a", label: "a", value: null },
          { key: "b", label: "b", value: null },
        ]}
        format={fmt}
        summary="Vacía"
      />,
    );
    expect(screen.getByRole("img", { name: "Vacía" })).toBeInTheDocument();
  });
});

describe("Curve without a measured width", () => {
  it("renders no drawing until it has a width", () => {
    render(<Curve points={weeks} format={fmt} summary="Sin ancho" />);
    expect(
      screen.queryByRole("img", { name: "Sin ancho" }),
    ).not.toBeInTheDocument();
  });

  it("falls back to a fixed width when ResizeObserver is missing", () => {
    const original = globalThis.ResizeObserver;
    // @ts-expect-error simulating an environment without the API
    delete globalThis.ResizeObserver;
    try {
      render(<Curve points={weeks} format={fmt} summary="Sin observer" />);
      expect(
        screen.getByRole("img", { name: "Sin observer" }),
      ).toBeInTheDocument();
    } finally {
      globalThis.ResizeObserver = original;
    }
  });
});

describe("WeekBars", () => {
  beforeEach(() => {
    measureAs(640);
  });
  afterEach(() => vi.restoreAllMocks());

  it("draws a bar per known week, hover details and selection", () => {
    const onSelect = vi.fn();
    const { container } = render(
      <WeekBars
        points={weeks}
        format={fmt}
        summary="Barras"
        onSelect={onSelect}
      />,
    );
    expect(screen.getByRole("img", { name: "Barras" })).toBeInTheDocument();
    const bars = container.querySelectorAll("rect[rx]");
    expect(bars).toHaveLength(5);
    fireEvent.mouseEnter(bars[4]);
    expect(screen.getByText("semana en curso")).toBeInTheDocument();
    fireEvent.mouseEnter(bars[0]);
    expect(screen.getAllByText("100 kg").length).toBeGreaterThan(0);
    fireEvent.click(bars[1]);
    expect(onSelect).toHaveBeenCalledWith("w2");
    fireEvent.mouseLeave(bars[1]);
    expect(screen.queryByText("semana en curso")).not.toBeInTheDocument();
  });

  it("thins the axis labels and survives no selection handler", () => {
    const many: CurvePoint[] = Array.from({ length: 40 }, (_, i) => ({
      key: `k${i}`,
      label: `S${i}`,
      value: i,
    }));
    const { container } = render(
      <WeekBars points={many} format={fmt} summary="Muchas" />,
    );
    expect(screen.getByText("S39")).toBeInTheDocument();
    expect(screen.queryByText("S1")).not.toBeInTheDocument();
    fireEvent.click(container.querySelectorAll("rect[rx]")[2]);
  });

  it("shows no drawing for an empty series without width", () => {
    vi.restoreAllMocks();
    render(<WeekBars points={[]} format={fmt} summary="Nada" />);
    expect(screen.queryByRole("img", { name: "Nada" })).not.toBeInTheDocument();
  });
});

describe("Sparkline", () => {
  it("says there are no kilos, or only one week", () => {
    const { rerender } = render(<Sparkline values={[null, null]} label="x" />);
    expect(screen.getByText("sin kilos")).toBeInTheDocument();
    rerender(<Sparkline values={[null, 5]} label="x" />);
    expect(screen.getByText("una semana")).toBeInTheDocument();
  });

  it("breaks the line at unknown weeks", () => {
    const { container } = render(
      <Sparkline values={[1, 2, null, 4, null, 6, 7]} label="Café" />,
    );
    expect(screen.getByRole("img", { name: "Café" })).toBeInTheDocument();
    // Two runs of two or more points, each with an area and a line.
    expect(container.querySelectorAll("path")).toHaveLength(4);
    expect(container.querySelectorAll("circle")).toHaveLength(1);
  });
});

describe("RowBar", () => {
  it("clamps the fraction and treats non-numbers as zero", () => {
    const widthOf = (f: number) => {
      const { container, unmount } = render(<RowBar fraction={f} />);
      const inner = container.firstElementChild
        ?.firstElementChild as HTMLElement;
      const w = getComputedStyle(inner).width;
      unmount();
      return w;
    };
    expect(widthOf(0.5)).toBe("50%");
    expect(widthOf(2)).toBe("100%");
    expect(widthOf(-1)).toBe("0%");
    expect(widthOf(Number.NaN)).toBe("0%");
  });
});
