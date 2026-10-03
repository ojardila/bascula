// SPDX-License-Identifier: MIT
/**
 * The figure readers: a partial value that is also provisional, partial
 * kilos, and the plain nullable `Figure` with and without a suffix.
 */
import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { ThemeProvider } from "@mui/material";
import type { ReactElement } from "react";
import { theme } from "../../theme";
import { Figure, Kg, Value } from "./Figures";
import type { Totals } from "./totals";

const base: Totals = {
  records: 0,
  kg: null,
  recordsNotInKg: 0,
  valueCents: null,
  recordsWithoutValue: 0,
  valueIsEstimate: false,
  recordsSpanningWeeks: 0,
};

const show = (ui: ReactElement) => render(<ThemeProvider theme={theme}>{ui}</ThemeProvider>);

describe("Figures", () => {
  it("marks a partial value that still rides on the week's price as provisional", () => {
    show(
      <Value
        total={{ ...base, records: 3, valueCents: 500_000, recordsWithoutValue: 1, valueIsEstimate: true }}
      />,
    );
    expect(screen.getByText(/al menos · faltan 1 · provisional/)).toBeInTheDocument();
  });

  it("presents kilos with weighings left out as a floor", () => {
    show(<Kg total={{ ...base, records: 3, kg: 40, recordsNotInKg: 2 }} scope="la semana" />);
    expect(screen.getByText(/al menos · faltan 2/)).toBeInTheDocument();
    expect(screen.getByText("40")).toBeInTheDocument();
  });

  it("shows a missing number as a dash with its reason", () => {
    show(<Figure value={null} reason="Sin índice todavía." />);
    expect(screen.getByRole("img", { name: "Sin índice todavía." })).toHaveTextContent("—");
  });

  it("prints a number bold without a suffix, and with one when given", () => {
    const { rerender } = show(<Figure value={1.5} bold />);
    expect(screen.getByText("1,5")).toBeInTheDocument();
    rerender(
      <ThemeProvider theme={theme}>
        <Figure value={2} suffix="kg/día" />
      </ThemeProvider>,
    );
    expect(screen.getByText("kg/día")).toBeInTheDocument();
  });
});
