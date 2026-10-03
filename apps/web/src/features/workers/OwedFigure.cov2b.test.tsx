// SPDX-License-Identifier: MIT
import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { OwedFigure, owedDirection } from "./OwedFigure";

const unknown = { balanceCents: null, pendingCents: null, pendingIsEstimate: false };
const owesFarm = { balanceCents: -500000, pendingCents: 0, pendingIsEstimate: false };

describe("OwedFigure", () => {
  it("shows the big dash with its reason when nothing could be read", () => {
    render(<OwedFigure owed={unknown} variant="big" />);
    expect(
      screen.getByLabelText("No se pudo consultar ni el saldo ni lo pendiente de liquidar. No es cero."),
    ).toHaveTextContent("—");
  });
});

describe("owedDirection", () => {
  it("has no phrase when the total is unknown", () => {
    expect(owedDirection(unknown)).toBeNull();
  });

  it("says the worker owes the farm when the total is negative", () => {
    expect(owedDirection(owesFarm)).toBe("que el empleado le debe a la finca");
  });

  it("uses «de» for a name that does not start with «el»", () => {
    const inFavour = { balanceCents: 500000, pendingCents: 0, pendingIsEstimate: false };
    expect(owedDirection(inFavour, "la cuadrilla")).toBe("a favor de la cuadrilla");
  });
});

