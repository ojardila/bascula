// SPDX-License-Identifier: MIT
/**
 * «Cambiar clave» in the account menu must land on the card: on screen, with
 * the first field focused. It used to look like it did nothing — the cards
 * above grew after one scroll on mount and pushed this one below the fold,
 * and choosing the item again from Configuración (same #clave) did not
 * scroll at all.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, useNavigate } from "react-router-dom";
import { ThemeProvider } from "@mui/material";
import { ChangePasswordCard } from "./ChangePasswordCard";
import { theme } from "../../theme";

let scrolled: Element[] = [];
let resized: (() => void) | null = null;

class FakeResizeObserver {
  constructor(private readonly cb: () => void) {}
  observe() {
    resized = this.cb;
  }
  disconnect() {
    if (resized === this.cb) resized = null;
  }
  unobserve() {}
}

beforeEach(() => {
  scrolled = [];
  resized = null;
  Element.prototype.scrollIntoView = function (this: Element) {
    scrolled.push(this);
  };
  vi.stubGlobal("ResizeObserver", FakeResizeObserver);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function MenuItem() {
  const navigate = useNavigate();
  return <button onClick={() => navigate("/configuracion#clave")}>menú</button>;
}

function renderAt(path: string) {
  return render(
    <ThemeProvider theme={theme}>
      <MemoryRouter initialEntries={[path]}>
        <MenuItem />
        <ChangePasswordCard />
      </MemoryRouter>
    </ThemeProvider>,
  );
}

const card = () => document.getElementById("clave");

describe("Cambiar clave from the account menu", () => {
  it("scrolls to the card and focuses the current password", () => {
    renderAt("/configuracion#clave");
    expect(scrolled).toContain(card());
    expect(screen.getByLabelText("Clave actual")).toHaveFocus();
  });

  it("follows the card while the page above it is still growing", () => {
    renderAt("/configuracion#clave");
    scrolled = [];
    act(() => resized?.());
    expect(scrolled).toContain(card());
  });

  it("lets go once the person scrolls on their own", () => {
    renderAt("/configuracion#clave");
    act(() => {
      window.dispatchEvent(new Event("wheel"));
    });
    expect(resized).toBeNull();
  });

  it("scrolls again when chosen a second time from Configuración", async () => {
    const user = userEvent.setup();
    renderAt("/configuracion#clave");
    scrolled = [];
    await user.click(screen.getByRole("button", { name: "menú" }));
    expect(scrolled).toContain(card());
    expect(screen.getByLabelText("Clave actual")).toHaveFocus();
  });

  it("stays put on Configuración opened without #clave", () => {
    renderAt("/configuracion");
    expect(scrolled).toHaveLength(0);
    expect(screen.getByLabelText("Clave actual")).not.toHaveFocus();
  });
});
