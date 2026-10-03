// SPDX-License-Identifier: MIT
/**
 * «Termine de preparar su finca»: once the owner says no, it stays gone —
 * after a reload, on another device, at the next sign-in, and even when the
 * «no» was given with no signal.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { TourProvider, useTour } from "./TourContext";
import { ResumeCard } from "./ResumeCard";
import { OWNER_DONE } from "./steps";

type Row = { tour: string; step: number; status: string; updatedAt: string };

/** The server's `user_tours`, kept across page loads like the real one. */
const server = vi.hoisted(() => ({ rows: new Map<string, Row>(), offline: false }));

vi.mock("../../api/endpoints", () => ({
  api: {
    listTours: async () => [...server.rows.values()],
    saveTour: async (tour: string, step: number, status: string) => {
      if (server.offline) throw new Error("offline");
      const row = { tour, step, status, updatedAt: new Date().toISOString() };
      server.rows.set(tour, row);
      return row;
    },
  },
}));

vi.mock("../../auth/AuthContext", () => ({
  useAuth: () => ({
    user: { id: "u-rc", isSuperAdmin: false, farm: { id: "f-rc", name: "El Roble" } },
    principal: { role: "owner", isSuperAdmin: false, farmStatus: "active" },
    readOnly: false,
  }),
}));

const KEY = "bascula.tours.u-rc.El Roble";
const TITLE = "Termine de preparar su finca";

function Page() {
  const t = useTour();
  return (
    <>
      <div data-testid="loaded">{String(t.loaded)}</div>
      <div data-testid="current">{t.current ? `${t.current.tour}:${t.current.n}` : "none"}</div>
      <button onClick={t.later}>Saltar</button>
      <button onClick={() => t.start("owner")}>Ayuda y recorrido</button>
      <ResumeCard />
    </>
  );
}

/** One page load: a reload is an unmount and a fresh mount. */
async function load() {
  const view = render(
    <TourProvider>
      <Page />
    </TourProvider>,
  );
  await waitFor(() => expect(screen.getByTestId("loaded").textContent).toBe("true"));
  await act(async () => {});
  return view;
}

const card = () => screen.queryByRole("heading", { name: TITLE });
const click = (name: string) => fireEvent.click(screen.getByRole("button", { name }));
const seed = (step: number, status: string) =>
  server.rows.set("owner", { tour: "owner", step, status, updatedAt: "2026-10-01T12:00:00Z" });

beforeEach(() => {
  server.rows.clear();
  server.offline = false;
  localStorage.removeItem(KEY);
});

describe("the resume card", () => {
  it("is offered once after the first «Saltar»", async () => {
    await load();
    expect(screen.getByTestId("current").textContent).toBe("owner:0");
    click("Saltar");
    expect(server.rows.get("owner")?.status).toBe("later");
    expect(card()).not.toBeNull();
  });

  it.each(["No, gracias", "No mostrar más"])(
    "«%s» hides it for good: after a reload, on another device and at the next sign-in",
    async (answer) => {
      seed(3, "later");
      const first = await load();
      expect(card()).not.toBeNull();
      click(answer);
      expect(card()).toBeNull();
      await act(async () => {});
      expect(server.rows.get("owner")).toMatchObject({ step: 3, status: "dismissed" });

      first.unmount(); // reload on the same device
      const second = await load();
      expect(card()).toBeNull();
      expect(screen.getByTestId("current").textContent).toBe("none");
      second.unmount();

      localStorage.removeItem(KEY); // another device, or a new sign-in
      await load();
      expect(card()).toBeNull();
    },
  );

  it("a «no» given with no signal still sticks, and reaches the server on the next load", async () => {
    seed(3, "later");
    const first = await load();
    server.offline = true;
    click("No, gracias");
    expect(card()).toBeNull();
    await act(async () => {});
    expect(server.rows.get("owner")?.status).toBe("later");
    first.unmount();

    // Signal is back; the server still has the old «later».
    server.offline = false;
    await load();
    expect(card()).toBeNull();
    await waitFor(() => expect(server.rows.get("owner")?.status).toBe("dismissed"));
  });

  it("«Seguir donde iba» resumes; saying no again inside the tour is final", async () => {
    seed(3, "later");
    const first = await load();
    click("Seguir donde iba");
    expect(screen.getByTestId("current").textContent).toBe("owner:3");
    expect(card()).toBeNull();
    click("Saltar");
    expect(card()).toBeNull();
    await act(async () => {});
    expect(server.rows.get("owner")).toMatchObject({ step: 3, status: "dismissed" });

    first.unmount();
    await load();
    expect(card()).toBeNull();
  });

  it("the tour stays in «Ayuda y recorrido» after the card was declined", async () => {
    seed(3, "dismissed");
    await load();
    expect(card()).toBeNull();
    click("Ayuda y recorrido");
    expect(screen.getByTestId("current").textContent).toBe("owner:0");
    click("Saltar");
    expect(card()).toBeNull();
    await act(async () => {});
    expect(server.rows.get("owner")?.status).toBe("dismissed");
  });

  it("watching a finished tour again and skipping keeps it finished", async () => {
    seed(OWNER_DONE, "done");
    await load();
    click("Ayuda y recorrido");
    click("Saltar");
    expect(card()).toBeNull();
    await act(async () => {});
    expect(server.rows.get("owner")).toMatchObject({ step: OWNER_DONE, status: "done" });
  });
});
