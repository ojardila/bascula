// SPDX-License-Identifier: MIT
/**
 * ── A `<ul>` MAY ONLY CONTAIN `<li>`, OR SCREEN READERS LOSE THE LIST ──────
 *
 * The worker's financial history is rendered with MUI's `<List>` — which is
 * a plain `<ul>` — but each row is a `<ListItemButton>` that renders as
 * `<div role="button">`. VoiceOver and NVDA then describe the structure as
 * "button, button, button" without the "list, N items" context. The user
 * loses the shape of the list and the "position 3 of 8" announcement every
 * row carries when it is wrapped in an `<li>`.
 *
 * Fix: wrap each clickable row in `<ListItem disablePadding>` (which renders
 * as `<li>` and adds no visual padding) so the DOM is `<ul><li><button>`.
 * This test fails before the fix because the `<ul>` has direct children that
 * are not `<li>`.
 */
import { describe, expect, it } from "vitest";
import { render } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { ThemeProvider } from "@mui/material";
import { WorkerHistory } from "./WorkerHistory";
import { theme } from "../../theme";
import type { LedgerEntry } from "../../api/types";

const WORKER = "0192f3a0-0006-7000-8000-000000000001";

const LEDGER: LedgerEntry[] = [
  {
    id: "0192f3a0-9000-7000-8000-000000000001",
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
    id: "0192f3a0-9000-7000-8000-000000000002",
    workerId: WORKER,
    kind: "anticipo",
    date: "2026-02-25",
    amountCents: -10_000_00,
    concept: "Anticipo",
    method: "efectivo",
    receiptNumber: null,
    reversesId: null,
  },
];

describe("WorkerHistory list semantics", () => {
  it("the <ul> only contains <li> children", () => {
    const { container } = render(
      <ThemeProvider theme={theme}>
        <MemoryRouter>
          <WorkerHistory workerId={WORKER} ledger={LEDGER} />
        </MemoryRouter>
      </ThemeProvider>,
    );
    const ul = container.querySelector('ul[data-testid="worker-history"]');
    expect(ul).not.toBeNull();
    const nonLiChildren = Array.from(ul!.children).filter(
      (c) => c.tagName.toLowerCase() !== "li",
    );
    expect(nonLiChildren).toEqual([]);
  });
});
