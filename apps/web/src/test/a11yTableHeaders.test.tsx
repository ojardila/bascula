/**
 * ── TABLE HEADERS THAT ARE EMPTY ARE A SCREEN-READER DEAD SPOT ─────────────
 *
 * On the employees list, the employee profile and the "paying one worker"
 * screen, the last column holds a control: a row-actions kebab, a receipt
 * link, a selection checkbox. For a sighted user the icon is self-explanatory
 * and the column header can be blank. For a screen reader the blank header is
 * the whole label of every cell in the column: VoiceOver reads "columna 6
 * sin encabezado — botón" instead of "acciones de María — botón".
 *
 * Fix: give those `<th>` an accessible name — either visible text or a
 * `visuallyHidden` span. This test fails before the fix because every page
 * has at least one `<th>` whose combined accessible text is empty.
 */
import { describe, expect, it, beforeEach } from "vitest";
import { render, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { ThemeProvider } from "@mui/material";
import { WorkerProfilePage } from "../features/workers/WorkerProfilePage";
import { WorkersPage } from "../features/workers/WorkersPage";
import { PayWorkerPage } from "../features/workers/PayWorkerPage";
import { AuthProvider } from "../auth/AuthContext";
import { setTokens } from "../api/client";
import { invalidateRefs } from "../api/refs";
import { theme } from "../theme";
import * as db from "../mocks/db";

const OWNER = "0192f3a0-0001-7000-8000-000000000001";
const MARIA = "0192f3a0-0006-7000-8000-000000000001";

function renderAt(path: string) {
  return render(
    <ThemeProvider theme={theme}>
      <MemoryRouter initialEntries={[path]}>
        <AuthProvider>
          <Routes>
            <Route path="/empleados" element={<WorkersPage />} />
            <Route path="/empleados/:id" element={<WorkerProfilePage />} />
            <Route path="/empleados/:id/pagar" element={<PayWorkerPage />} />
          </Routes>
        </AuthProvider>
      </MemoryRouter>
    </ThemeProvider>,
  );
}

beforeEach(() => {
  db.resetDb();
  invalidateRefs();
  const now = Date.now();
  setTokens({
    accessToken: `mock-access.${OWNER}.${db.FARM_ID}.${now}.${now + 900_000}`,
    refreshToken: `mock-refresh.${OWNER}`,
  });
});

/**
 * Returns the screen-reader text of a `<th>`: visible text, trimmed, with any
 * `aria-label` on the element as a fallback. If both are empty, so is the
 * header for a lector de pantalla.
 */
function accessibleTextOf(th: Element): string {
  const ariaLabel = th.getAttribute("aria-label")?.trim();
  if (ariaLabel) return ariaLabel;
  return (th.textContent ?? "").replace(/\s+/g, " ").trim();
}

async function waitPainted(container: HTMLElement): Promise<void> {
  await waitFor(
    () => {
      const stillLoading =
        container.querySelector('[role="progressbar"]') ||
        container.querySelector(".MuiSkeleton-root");
      expect(stillLoading).toBeNull();
    },
    { timeout: 4000 },
  );
}

async function emptyHeadersIn(container: HTMLElement): Promise<Element[]> {
  await waitPainted(container);
  return Array.from(container.querySelectorAll("th")).filter(
    (th) => accessibleTextOf(th) === "",
  );
}

describe("every table header carries text a screen reader can announce", () => {
  it("WorkersPage has no empty <th>", async () => {
    const { container } = renderAt("/empleados");
    expect(await emptyHeadersIn(container)).toEqual([]);
  });

  it("WorkerProfilePage has no empty <th>", async () => {
    const { container } = renderAt(`/empleados/${MARIA}`);
    expect(await emptyHeadersIn(container)).toEqual([]);
  });

  it("PayWorkerPage has no empty <th>", async () => {
    const { container } = renderAt(`/empleados/${MARIA}/pagar`);
    expect(await emptyHeadersIn(container)).toEqual([]);
  });
});
