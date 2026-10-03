import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import type { TeamRef, Worker } from "../../api/types";
import {
  MemberBanner,
  TeamChip,
  TeamMembersCard,
  looksLikeTwoPeople,
} from "./TeamProfile";

const team = {
  id: "team-1",
  name: "Yorman y Sergio",
  lastName: null,
  kind: "equipo",
  members: [
    {
      id: "m1",
      name: "Yorman",
      lastName: "Pérez",
      tag: "12",
      from: "2026-01-05",
      to: null,
    },
    {
      id: "m2",
      name: "Sergio",
      lastName: null,
      tag: null,
      from: "2026-01-05",
      to: "2026-03-01",
    },
  ],
} as unknown as Worker;

function inRouter(ui: React.ReactElement) {
  return render(
    <MemoryRouter initialEntries={["/"]}>
      <Routes>
        <Route path="/" element={ui} />
        <Route path="/empleados/:id" element={<p>perfil</p>} />
        <Route path="/empleados/:id/equipo" element={<p>integrantes</p>} />
      </Routes>
    </MemoryRouter>,
  );
}

describe("looksLikeTwoPeople", () => {
  it("spots names joined by y, & or e", () => {
    expect(looksLikeTwoPeople("Yorman y Sergio")).toBe(true);
    expect(looksLikeTwoPeople("Ana & Luis")).toBe(true);
    expect(looksLikeTwoPeople("Juan e Inés")).toBe(true);
    expect(looksLikeTwoPeople("Yolanda")).toBe(false);
  });
});

describe("TeamMembersCard", () => {
  it("lists the members and opens a profile", async () => {
    const user = userEvent.setup();
    inRouter(<TeamMembersCard team={team} canEdit={false} />);
    expect(screen.getByText("Yorman Pérez")).toBeInTheDocument();
    expect(screen.getByText("Sergio")).toBeInTheDocument();
    expect(screen.getByText(/hasta/)).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Cambiar integrantes" }),
    ).not.toBeInTheDocument();
    await user.click(screen.getByText("Yorman Pérez"));
    expect(await screen.findByText("perfil")).toBeInTheDocument();
  });

  it("warns about a team without members and lets an editor change them", async () => {
    const user = userEvent.setup();
    inRouter(
      <TeamMembersCard
        team={{ ...team, members: undefined } as Worker}
        canEdit
      />,
    );
    expect(
      screen.getByText(/todavía no tiene integrantes/),
    ).toBeInTheDocument();
    await user.click(
      screen.getByRole("button", { name: "Cambiar integrantes" }),
    );
    expect(await screen.findByText("integrantes")).toBeInTheDocument();
  });
});

describe("MemberBanner", () => {
  const ref: TeamRef = {
    id: "team-1",
    name: "Los Pérez",
    from: "2026-01-05",
    to: null,
    members: 2,
  };

  it("names the team and opens it", async () => {
    const user = userEvent.setup();
    inRouter(<MemberBanner team={ref} />);
    expect(screen.getByText("Los Pérez")).toBeInTheDocument();
    expect(screen.queryByText(/hasta el/)).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Ver el equipo" }));
    expect(await screen.findByText("perfil")).toBeInTheDocument();
  });

  it("says until when for a past membership", () => {
    inRouter(<MemberBanner team={{ ...ref, to: "2026-02-01" }} />);
    expect(screen.getByText(/hasta el/)).toBeInTheDocument();
  });
});

describe("TeamChip", () => {
  it("shows nothing for a person or no worker", () => {
    const { container, rerender } = render(<TeamChip worker={null} />);
    expect(container).toBeEmptyDOMElement();
    rerender(<TeamChip worker={{ ...team, kind: "persona" } as Worker} />);
    expect(container).toBeEmptyDOMElement();
  });

  it("counts the members and names them", () => {
    const { rerender } = render(<TeamChip worker={team} />);
    expect(
      screen.getByText("Equipo de 2 · Yorman, Sergio"),
    ).toBeInTheDocument();
    rerender(<TeamChip worker={{ ...team, members: undefined } as Worker} />);
    expect(screen.getByText("Equipo de 0")).toBeInTheDocument();
  });
});
