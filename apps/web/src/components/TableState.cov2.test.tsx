// SPDX-License-Identifier: MIT
/** A table the account may not read says so, and names who can grant it. */
import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { Table, TableBody } from "@mui/material";
import { TableState } from "./TableState";

describe("TableState", () => {
  it("explains a denied read instead of showing rows", () => {
    render(
      <Table>
        <TableBody>
          <TableState colSpan={3} rows={null} denied subject="las existencias" emptyText="Nada" />
        </TableBody>
      </Table>,
    );
    expect(
      screen.getByText(
        "Su usuario no tiene permiso para ver las existencias. Si lo necesita para trabajar, pídaselo al dueño de la finca.",
      ),
    ).toBeInTheDocument();
    expect(screen.queryByText("Nada")).not.toBeInTheDocument();
  });
});
