/**
 * ── HEADINGS JUMP FROM h1 TO h3, AND SCREEN READERS LOSE THE SHAPE ────────
 *
 * On the dashboard and on the "paying one worker" screen the page title is an
 * `<h1>` and the next section heading was `<h3>`. There is no `<h2>` in
 * between. A screen reader user who navigates by heading hears "section
 * heading, level three" and infers there is a missing level two above it that
 * they already skipped — so they walk back up looking for a section that does
 * not exist.
 *
 * The visible text size is tied to MUI's `variant="h3"` typography scale and
 * must not change. The fix is to keep the visual variant and move the
 * semantics down a level with `component="h2"`. This test fails before the
 * fix because the headings of these two pages don't form a monotonically
 * increasing sequence that only ever grows by one.
 */
import { describe, expect, it, beforeEach } from "vitest";
import { render, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { ThemeProvider } from "@mui/material";
import { DashboardPage } from "../features/dashboard/DashboardPage";
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
            <Route path="/" element={<DashboardPage />} />
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

/**
 * Returns the heading-level sequence as rendered: 1 for `<h1>`, 2 for `<h2>`,
 * and so on. The DOM traversal is in document order — the same order a
 * screen reader walks when the user hits the "next heading" shortcut.
 */
function levelsIn(container: HTMLElement): number[] {
  return Array.from(container.querySelectorAll("h1,h2,h3,h4,h5,h6")).map(
    (h) => Number(h.tagName.slice(1)),
  );
}

/**
 * Finds jumps that WCAG 1.3.1 (and axe's `heading-order`) call out: a step
 * from `N` to anything greater than `N + 1`. The caller sees the actual
 * sequence in the assertion message so the regression is obvious.
 */
function findJumps(levels: number[]): Array<{ from: number; to: number }> {
  const jumps: Array<{ from: number; to: number }> = [];
  for (let i = 1; i < levels.length; i++) {
    const prev = levels[i - 1];
    const cur = levels[i];
    if (cur > prev + 1) jumps.push({ from: prev, to: cur });
  }
  return jumps;
}

describe("heading levels only step down by one", () => {
  it("DashboardPage never jumps a level", async () => {
    const { container } = renderAt("/");
    await waitPainted(container);
    const levels = levelsIn(container);
    expect({ levels, jumps: findJumps(levels) }).toEqual({
      levels,
      jumps: [],
    });
  });

  it("PayWorkerPage never jumps a level", async () => {
    const { container } = renderAt(`/empleados/${MARIA}/pagar`);
    await waitPainted(container);
    const levels = levelsIn(container);
    expect({ levels, jumps: findJumps(levels) }).toEqual({
      levels,
      jumps: [],
    });
  });
});
