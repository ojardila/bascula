// SPDX-License-Identifier: MIT
import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { ThemeProvider } from "@mui/material";
import { WorkerHistory } from "./WorkerHistory";
import { theme } from "../../theme";
import type { LedgerEntry } from "../../api/types";

const WORKER = "0192f3a0-0006-7000-8000-000000000001";
const PAGO = "0192f3a0-9000-7000-8000-000000000001";

const LEDGER: LedgerEntry[] = [
  {
    id: PAGO,
    workerId: WORKER,
    kind: "pago",
    date: "2026-03-01",
    amountCents: -45_000_00,
    concept: "Pago semana del 24 de febrero",
    method: "efectivo",
    receiptNumber: null,
    reversesId: null,
  },
  {
    id: "0192f3a0-9000-7000-8000-000000000009",
    workerId: WORKER,
    kind: "reverso",
    date: "2026-03-02",
    amountCents: 45_000_00,
    concept: "Pago anulado",
    method: null,
    receiptNumber: null,
    reversesId: PAGO,
  },
] as LedgerEntry[];

describe("WorkerHistory, a voided payment", () => {
  it("marks the payment as anulado and hides the reversal itself", () => {
    render(
      <ThemeProvider theme={theme}>
        <MemoryRouter>
          <WorkerHistory workerId={WORKER} ledger={LEDGER} />
        </MemoryRouter>
      </ThemeProvider>,
    );
    expect(screen.getByText("Anulado")).toBeInTheDocument();
    expect(screen.getByText("Pago semana del 24 de febrero")).toBeInTheDocument();
    expect(screen.queryByText("Pago anulado")).not.toBeInTheDocument();
  });

  it("says nothing has been paid when the ledger is empty", () => {
    render(
      <ThemeProvider theme={theme}>
        <MemoryRouter>
          <WorkerHistory workerId={WORKER} ledger={[]} />
        </MemoryRouter>
      </ThemeProvider>,
    );
    expect(screen.getByText("Todavía no se le ha pagado, liquidado ni descontado nada.")).toBeInTheDocument();
  });
});
