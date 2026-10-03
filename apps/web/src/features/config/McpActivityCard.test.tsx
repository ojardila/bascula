// SPDX-License-Identifier: MIT
/**
 * «Lo que hicieron los asistentes»: the owner and the administrator see what
 * assistants wrote on the farm; the weigher does not (and the server would
 * refuse them anyway).
 */
import { beforeEach, describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { ThemeProvider } from "@mui/material";
import { McpActivityCard } from "./McpActivityCard";
import { AuthProvider } from "../../auth/AuthContext";
import { setTokens } from "../../api/client";
import { invalidateRefs } from "../../api/refs";
import { theme } from "../../theme";
import * as db from "../../mocks/db";

const OWNER = "0192f3a0-0001-7000-8000-000000000001";
const WEIGHER = "0192f3a0-0001-7000-8000-000000000003";

function signIn(userId: string) {
  const now = Date.now();
  setTokens({
    accessToken: `mock-access.${userId}.${db.FARM_ID}.${now}.${now + 900_000}`,
    refreshToken: `mock-refresh.${userId}`,
  });
}

function renderCard() {
  return render(
    <ThemeProvider theme={theme}>
      <MemoryRouter>
        <AuthProvider>
          <McpActivityCard />
        </AuthProvider>
      </MemoryRouter>
    </ThemeProvider>,
  );
}

beforeEach(() => {
  db.resetDb();
  invalidateRefs();
  db.tenantOf(db.FARM_ID)!.mcpActivity = [{
    id: "0192f3a0-00dd-7000-8000-000000000001",
    userId: OWNER,
    userName: "Oscar",
    clientId: "597868dc",
    clientName: "ChatGPT",
    tool: "register_payment",
    outcome: "done",
    summary: "Pago registrado: $50.000 a María Gómez.",
    args: { amountCents: 5000000 },
    createdAt: new Date().toISOString(),
  }];
});

describe("McpActivityCard", () => {
  it("shows the owner what an assistant registered, who and with which assistant", async () => {
    signIn(OWNER);
    renderCard();
    expect(await screen.findByText("Registró un pago")).toBeInTheDocument();
    expect(screen.getByText("Hecho")).toBeInTheDocument();
    expect(screen.getByText(/Oscar · ChatGPT/)).toBeInTheDocument();
    expect(screen.getByText("Pago registrado: $50.000 a María Gómez.")).toBeInTheDocument();
  });

  it("shows nothing to the weigher", async () => {
    signIn(WEIGHER);
    const { container } = renderCard();
    await new Promise((r) => setTimeout(r, 50));
    expect(container).toBeEmptyDOMElement();
  });
});
