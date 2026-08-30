/**
 * THE DATE FIELD, AND THE 3RD OF AUGUST THAT GOT SAVED AS THE 8TH OF MARCH.
 *
 * The bug this component closes has a short and expensive path: somebody types
 * 03/08 into an `<input type="date">` that asks for `mm/dd/yyyy`, the browser
 * saves March 8th, the work item falls in another week, and that week has a
 * different price per kilo. The first test below is exactly that case.
 *
 * The second is the one that really matters to whoever uses this: that the
 * field SAYS in words what it understood. Even if the mask failed, "lunes 3 de
 * agosto de 2026" under the field cannot be misread.
 */
import { describe, expect, it, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ThemeProvider } from "@mui/material";
import { useState } from "react";
import { DateField } from "./DateField";
import { AuthProvider } from "../auth/AuthContext";
import { theme } from "../theme";
import { parseTypedDay, formatDayFull, monthGrid, todayInFarm } from "../lib/dates";

function Harness({ initial = "", onValue }: { initial?: string; onValue?: (v: string) => void }) {
  const [value, setValue] = useState(initial);
  return (
    <ThemeProvider theme={theme}>
      <AuthProvider>
        <DateField
          label="Fecha"
          value={value}
          onChange={(v) => {
            setValue(v);
            onValue?.(v);
          }}
        />
        <output data-testid="iso">{value}</output>
      </AuthProvider>
    </ThemeProvider>
  );
}

const field = () => screen.getByLabelText(/^Fecha/);
const iso = () => screen.getByTestId("iso").textContent;

describe("the day comes first, which is the whole bug", () => {
  it("03/08 is the 3rd of August and not the 8th of March", async () => {
    const user = userEvent.setup();
    render(<Harness />);
    await user.type(field(), "03/08/2026");
    expect(iso()).toBe("2026-08-03");
  });

  it("and says it in words, so nobody has to trust the mask", async () => {
    const user = userEvent.setup();
    render(<Harness />);
    await user.type(field(), "03/08/2026");
    expect(screen.getByText("lunes 3 de agosto de 2026")).toBeInTheDocument();
  });

  it("accepts what people really type, not only the canonical form", () => {
    // The reference year is 2026 in all four cases.
    expect(parseTypedDay("29/8", 2026)).toBe("2026-08-29");
    expect(parseTypedDay("29/08/26", 2026)).toBe("2026-08-29");
    expect(parseTypedDay("29-8-2026", 2026)).toBe("2026-08-29");
    expect(parseTypedDay("29082026", 2026)).toBe("2026-08-29");
  });

  it("and does NOT quietly repair a date that does not exist", () => {
    // A 31st of February turned into the 28th without saying so is the same
    // bug in a different costume: the program saving something other than
    // what was typed.
    expect(parseTypedDay("31/02/2026", 2026)).toBeNull();
    expect(parseTypedDay("29/13/2026", 2026)).toBeNull();
    expect(parseTypedDay("hola", 2026)).toBeNull();
  });

  it("says so when it did not understand, instead of saving anything at all", async () => {
    const user = userEvent.setup();
    const onValue = vi.fn();
    render(<Harness onValue={onValue} />);
    await user.type(field(), "31/02/2026");
    expect(screen.getByText(/No entendimos esa fecha/)).toBeInTheDocument();
    expect(onValue).not.toHaveBeenCalled();
    expect(iso()).toBe("");
  });

  it("on blur it fills in what was missing, so the year is beyond doubt", async () => {
    const user = userEvent.setup();
    render(<Harness />);
    await user.type(field(), "29/8");
    await user.tab();
    // The year it assumes is today's on the farm, not a hard-coded one: this
    // test has to keep passing next year.
    const year = todayInFarm("America/Bogota").slice(0, 4);
    expect(field()).toHaveValue(`29/08/${year}`);
  });
});

describe("the calendar speaks Spanish", () => {
  it("opens with the months spelled out and the week starting on Monday", async () => {
    const user = userEvent.setup();
    render(<Harness initial="2026-08-29" />);
    await user.click(screen.getByRole("button", { name: /Abrir el calendario/ }));

    const cal = screen.getByRole("application", { name: "Calendario" });
    expect(within(cal).getByText("agosto de 2026")).toBeInTheDocument();
    // L M X J V S D — and not S M T W T F S.
    expect(within(cal).getAllByText("L").length).toBeGreaterThan(0);
    expect(within(cal).getAllByText("X").length).toBeGreaterThan(0);
  });

  it("picking a day writes it into the field and closes", async () => {
    const user = userEvent.setup();
    render(<Harness initial="2026-08-29" />);
    await user.click(screen.getByRole("button", { name: /Abrir el calendario/ }));
    const cal = screen.getByRole("application", { name: "Calendario" });
    await user.click(within(cal).getByRole("button", { name: formatDayFull("2026-08-12") }));

    expect(iso()).toBe("2026-08-12");
    expect(field()).toHaveValue("12/08/2026");
  });

  it("the grid is always six full weeks, so the button does not move", () => {
    // A month starting on a Sunday and one starting on a Monday come out the
    // same height. Otherwise changing month shifts the day about to be pressed.
    expect(monthGrid(2026, 1)).toHaveLength(42); // February 2026
    expect(monthGrid(2026, 10)).toHaveLength(42); // November 2026
    expect(monthGrid(2026, 1)[0]).toBe("2026-01-26"); // a Monday
    expect(monthGrid(2026, 10)[0]).toBe("2026-10-26"); // another Monday
  });
});
