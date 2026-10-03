// SPDX-License-Identifier: MIT
/**
 * The crew payroll rows on their own: an account with no document number on
 * file, and the undo report in the singular and with entries already undone
 * by an earlier attempt.
 */
import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { Table, TableBody, ThemeProvider } from "@mui/material";
import { MemoryRouter } from "react-router-dom";
import { theme } from "../../theme";
import { PayRow, SettleRow, UndoneAlert } from "./CrewPayrollRows";

describe("PayRow", () => {
  it("shows a dash for an account with no document number", () => {
    render(
      <ThemeProvider theme={theme}>
        <MemoryRouter>
          <Table>
            <TableBody>
              <PayRow
                a={{ workerId: "w1", name: "Luz Dary Ospina", documentNumber: null, amountCents: 5_000_000 }}
                member={undefined}
                included
                onToggleIncluded={vi.fn()}
              />
            </TableBody>
          </Table>
        </MemoryRouter>
      </ThemeProvider>,
    );
    const cells = screen.getAllByRole("cell");
    expect(screen.getByLabelText("Pagar a Luz Dary Ospina")).toBeChecked();
    // Document and last movement: both unknown, both a dash.
    expect(cells.filter((c) => c.textContent === "—")).toHaveLength(2);
  });
});

describe("SettleRow", () => {
  it("says the balance could not be read rather than showing a zero, and prints a bare quantity", () => {
    render(
      <ThemeProvider theme={theme}>
        <MemoryRouter>
          <Table>
            <TableBody>
              <SettleRow
                a={{
                  workerId: "w1",
                  name: "Jhon Fredy Ríos",
                  documentNumber: "1020",
                  grossCents: 1_000_000,
                  quantity: 12,
                  unitLabel: null,
                  payableIds: [],
                  lines: [],
                }}
                member={undefined}
                included={false}
                isOpen={false}
                onToggleIncluded={vi.fn()}
                onToggleOpen={vi.fn()}
                onPayApart={vi.fn()}
              />
            </TableBody>
          </Table>
        </MemoryRouter>
      </ThemeProvider>,
    );
    expect(screen.getByText("no se pudo leer")).toBeInTheDocument();
    expect(screen.getByText("12")).toBeInTheDocument();
    expect(screen.getByLabelText("Incluir a Jhon Fredy Ríos")).not.toBeChecked();
  });
});

describe("UndoneAlert", () => {
  it("speaks in the singular and counts what an earlier attempt already undid", () => {
    render(
      <ThemeProvider theme={theme}>
        <UndoneAlert
          undone={{ paymentsReversed: 1, settlementsVoided: 1, alreadyUndone: 2, failures: [] }}
          onClose={vi.fn()}
        />
      </ThemeProvider>,
    );
    const alert = screen.getByRole("alert");
    expect(alert).toHaveTextContent(
      "Se corrigieron 1 pago y se anularon 1 liquidación. 2 ya estaban deshechas.",
    );
  });
});
