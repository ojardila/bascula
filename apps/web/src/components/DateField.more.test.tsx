/**
 * The calendar's navigation and limits: months that cross a year, "Hoy",
 * closing without picking, days outside min/max, and emptying the field.
 */
import { describe, expect, it } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ThemeProvider } from "@mui/material";
import { useState } from "react";
import { DateField } from "./DateField";
import { AuthProvider } from "../auth/AuthContext";
import { theme } from "../theme";
import { formatDayFull, todayInFarm } from "../lib/dates";

function Harness({
  initial = "",
  min,
  max,
}: Readonly<{ initial?: string; min?: string; max?: string }>) {
  const [value, setValue] = useState(initial);
  return (
    <ThemeProvider theme={theme}>
      <AuthProvider>
        <DateField
          label="Fecha"
          value={value}
          onChange={setValue}
          min={min}
          max={max}
        />
        <output data-testid="iso">{value}</output>
      </AuthProvider>
    </ThemeProvider>
  );
}

const iso = () => screen.getByTestId("iso").textContent;

async function openCalendar(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole("button", { name: /Abrir el calendario/ }));
  return screen.getByRole("application", { name: "Calendario" });
}

describe("the calendar", () => {
  it("moves across the turn of the year in both directions", async () => {
    const user = userEvent.setup();
    render(<Harness initial="2026-01-15" />);
    const cal = await openCalendar(user);
    await user.click(within(cal).getByRole("button", { name: "Mes anterior" }));
    expect(within(cal).getByText("diciembre de 2025")).toBeInTheDocument();
    await user.click(
      within(cal).getByRole("button", { name: "Mes siguiente" }),
    );
    await user.click(
      within(cal).getByRole("button", { name: "Mes siguiente" }),
    );
    expect(within(cal).getByText("febrero de 2026")).toBeInTheDocument();
  });

  it("with no date yet, opens on today and Hoy picks it", async () => {
    const user = userEvent.setup();
    const today = todayInFarm("America/Bogota");
    render(<Harness />);
    const cal = await openCalendar(user);
    expect(
      within(cal).getByRole("button", { name: formatDayFull(today) }),
    ).toHaveAttribute("aria-current", "date");
    await user.click(within(cal).getByRole("button", { name: "Hoy" }));
    expect(iso()).toBe(today);
  });

  it("closes without changing anything", async () => {
    const user = userEvent.setup();
    render(<Harness initial="2026-08-29" />);
    const cal = await openCalendar(user);
    await user.click(within(cal).getByRole("button", { name: "Cerrar" }));
    expect(
      screen.queryByRole("application", { name: "Calendario" }),
    ).not.toBeInTheDocument();
    expect(iso()).toBe("2026-08-29");
  });

  it("does not offer the days outside the field's limits", async () => {
    const user = userEvent.setup();
    render(<Harness initial="2026-08-10" min="2026-08-05" max="2026-08-20" />);
    const cal = await openCalendar(user);
    expect(
      within(cal).getByRole("button", { name: formatDayFull("2026-08-04") }),
    ).toBeDisabled();
    expect(
      within(cal).getByRole("button", { name: formatDayFull("2026-08-21") }),
    ).toBeDisabled();
    expect(
      within(cal).getByRole("button", { name: formatDayFull("2026-08-05") }),
    ).toBeEnabled();
  });
});

describe("typing", () => {
  it("warns about a day outside the limits, but still passes it on", async () => {
    const user = userEvent.setup();
    render(<Harness min="2026-08-05" />);
    await user.type(screen.getByLabelText(/^Fecha/), "01/08/2026");
    expect(
      screen.getByText("Esa fecha queda fuera de lo que este campo admite."),
    ).toBeInTheDocument();
    expect(iso()).toBe("2026-08-01");
  });

  it("emptying the field sends an empty value", async () => {
    const user = userEvent.setup();
    render(<Harness initial="2026-08-29" />);
    await user.clear(screen.getByLabelText(/^Fecha/));
    expect(iso()).toBe("");
  });
});
