/**
 * EL CAMPO DE FECHA, Y EL 3 DE AGOSTO QUE SE GUARDABA COMO EL 8 DE MARZO.
 *
 * El fallo que este componente cierra tiene un camino corto y caro: alguien
 * teclea 03/08 en un `<input type="date">` que pide `mm/dd/aaaa`, el navegador
 * guarda el 8 de marzo, la labor cae en otra semana y esa semana tiene otro
 * precio del kilo. La primera prueba de aquí abajo es exactamente ese caso.
 *
 * La segunda es la que de verdad importa para quien usa esto: que el campo
 * DIGA en letras lo que entendió. Aunque la máscara fallara, «lunes 3 de
 * agosto de 2026» debajo del campo no se puede malinterpretar.
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

describe("el día va primero, que es el fallo entero", () => {
  it("03/08 es el 3 de agosto y no el 8 de marzo", async () => {
    const user = userEvent.setup();
    render(<Harness />);
    await user.type(field(), "03/08/2026");
    expect(iso()).toBe("2026-08-03");
  });

  it("y lo dice en letras, para que nadie tenga que fiarse de la máscara", async () => {
    const user = userEvent.setup();
    render(<Harness />);
    await user.type(field(), "03/08/2026");
    expect(screen.getByText("lunes 3 de agosto de 2026")).toBeInTheDocument();
  });

  it("acepta lo que la gente teclea de verdad, no sólo la forma canónica", () => {
    // El año de referencia es 2026 en los cuatro casos.
    expect(parseTypedDay("29/8", 2026)).toBe("2026-08-29");
    expect(parseTypedDay("29/08/26", 2026)).toBe("2026-08-29");
    expect(parseTypedDay("29-8-2026", 2026)).toBe("2026-08-29");
    expect(parseTypedDay("29082026", 2026)).toBe("2026-08-29");
  });

  it("y NO arregla por su cuenta una fecha que no existe", () => {
    // Un 31 de febrero convertido en 28 sin decirlo es el mismo fallo con
    // otro disfraz: el programa guardando algo distinto de lo que se escribió.
    expect(parseTypedDay("31/02/2026", 2026)).toBeNull();
    expect(parseTypedDay("29/13/2026", 2026)).toBeNull();
    expect(parseTypedDay("hola", 2026)).toBeNull();
  });

  it("lo dice cuando no entendió, en vez de guardar cualquier cosa", async () => {
    const user = userEvent.setup();
    const onValue = vi.fn();
    render(<Harness onValue={onValue} />);
    await user.type(field(), "31/02/2026");
    expect(screen.getByText(/No entendimos esa fecha/)).toBeInTheDocument();
    expect(onValue).not.toHaveBeenCalled();
    expect(iso()).toBe("");
  });

  it("al salir del campo completa lo que faltaba, para que no queden dudas del año", async () => {
    const user = userEvent.setup();
    render(<Harness />);
    await user.type(field(), "29/8");
    await user.tab();
    // El año que se da por supuesto es el de hoy en la finca, no uno fijo:
    // esta prueba tiene que seguir pasando el año que viene.
    const year = todayInFarm("America/Bogota").slice(0, 4);
    expect(field()).toHaveValue(`29/08/${year}`);
  });
});

describe("el calendario habla castellano", () => {
  it("se abre con los meses escritos y la semana empezando en lunes", async () => {
    const user = userEvent.setup();
    render(<Harness initial="2026-08-29" />);
    await user.click(screen.getByRole("button", { name: /Abrir el calendario/ }));

    const cal = screen.getByRole("application", { name: "Calendario" });
    expect(within(cal).getByText("agosto de 2026")).toBeInTheDocument();
    // L M X J V S D — y no S M T W T F S.
    expect(within(cal).getAllByText("L").length).toBeGreaterThan(0);
    expect(within(cal).getAllByText("X").length).toBeGreaterThan(0);
  });

  it("elegir un día lo escribe en el campo y cierra", async () => {
    const user = userEvent.setup();
    render(<Harness initial="2026-08-29" />);
    await user.click(screen.getByRole("button", { name: /Abrir el calendario/ }));
    const cal = screen.getByRole("application", { name: "Calendario" });
    await user.click(within(cal).getByRole("button", { name: formatDayFull("2026-08-12") }));

    expect(iso()).toBe("2026-08-12");
    expect(field()).toHaveValue("12/08/2026");
  });

  it("la rejilla son seis semanas completas, siempre, así el botón no se mueve", () => {
    // Un mes que empieza en domingo y otro que empieza en lunes producen la
    // misma altura. Si no, cambiar de mes desplaza el día que se iba a pulsar.
    expect(monthGrid(2026, 1)).toHaveLength(42); // febrero de 2026
    expect(monthGrid(2026, 10)).toHaveLength(42); // noviembre de 2026
    expect(monthGrid(2026, 1)[0]).toBe("2026-01-26"); // un lunes
    expect(monthGrid(2026, 10)[0]).toBe("2026-10-26"); // otro lunes
  });
});
