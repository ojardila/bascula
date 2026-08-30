/**
 * ── EL CAMPO DE FECHA, CON SU CALENDARIO EN CASTELLANO ───────────────────
 *
 * `<input type="date">` pedía `mm/dd/aaaa`. Alguien escribe el 3 de agosto
 * como 03/08, el navegador lo guarda como el 8 de marzo, y la labor se va a
 * otra semana — a otro precio. Es el fallo de usabilidad con la relación más
 * directa entre un teclazo y la plata que alguien recibe.
 *
 * EL SPRINT PASADO SE HIZO LA MITAD: marcar el input como `es-CO`. Firefox y
 * Safari hacen caso; Chrome mira el idioma con el que está configurado el
 * navegador y no. Un arreglo que depende de qué navegador tenga la finca no es
 * un arreglo, es una lotería. Este componente es la otra mitad, y es la que
 * cierra el asunto: la máscara ya no la decide el navegador.
 *
 * LAS TRES COSAS QUE HACE, EN ORDEN DE IMPORTANCIA:
 *
 *   1. **DICE EN LETRAS LO QUE ENTENDIÓ.** Debajo del campo, siempre:
 *      «sábado 29 de agosto de 2026». Esto es el arreglo de verdad. El
 *      problema reportado no era la máscara: era que quien escribe 29/08 *no
 *      sabe qué guardó*. Con la fecha escrita en palabras no hace falta
 *      confiar en la máscara, ni en el navegador, ni en la configuración del
 *      equipo — se lee y ya.
 *   2. Acepta lo que la gente teclea de verdad: 29/8, 29/08/26, 29-8-2026,
 *      29082026. Siempre día primero. Ver `parseTypedDay`.
 *   3. Un calendario, en castellano, con la semana empezando en lunes y los
 *      meses escritos, para quien prefiere señalar a teclear.
 *
 * LO QUE NO HACE, A PROPÓSITO. No corrige por su cuenta. «31/02» no se
 * convierte en el 28: se marca como inválido y no se guarda nada. Una fecha
 * que el programa cambia sin decirlo es exactamente el fallo que venimos a
 * arreglar, con otro disfraz.
 *
 * Y NO ES UNA DEPENDENCIA NUEVA. Un date picker de librería son cientos de
 * kilobytes sobre la conexión de una finca, y trae su propia idea de qué es un
 * día en qué huso horario — justo la decisión que `lib/dates.ts` ya toma y que
 * el resto del producto respeta.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import {
  Box, Button, IconButton, InputAdornment, Popover, Stack, TextField, Typography,
} from "@mui/material";
import CalendarMonthIcon from "@mui/icons-material/CalendarMonth";
import ChevronLeftIcon from "@mui/icons-material/ChevronLeft";
import ChevronRightIcon from "@mui/icons-material/ChevronRight";
import {
  MONTH_NAMES, WEEKDAY_INITIALS, formatDayFull, isValidDay, monthGrid, parseDay,
  parseTypedDay, todayInFarm, toTypedDay,
} from "../lib/dates";
import { useAuth } from "../auth/AuthContext";

export interface DateFieldProps {
  label: string;
  /** `YYYY-MM-DD`, o "" cuando todavía no hay ninguna. */
  value: string;
  /** Recibe `YYYY-MM-DD`, o "" si la persona vació el campo. */
  onChange: (iso: string) => void;
  /** Se muestra en vez del eco cuando la pantalla tiene algo que decir. */
  helperText?: string;
  error?: boolean;
  required?: boolean;
  disabled?: boolean;
  fullWidth?: boolean;
  size?: "small" | "medium";
  /** El día mínimo aceptado, `YYYY-MM-DD`. Sólo avisa; no bloquea el teclado. */
  min?: string;
  max?: string;
  name?: string;
}

export function DateField({
  label, value, onChange, helperText, error, required, disabled,
  fullWidth = true, size = "medium", min, max, name,
}: DateFieldProps) {
  const { user } = useAuth();
  const today = todayInFarm(user?.farm.timezone ?? "America/Bogota");

  /**
   * El texto es estado propio mientras se teclea.
   *
   * Si el campo se redibujara desde `value` en cada tecla, escribir «2» de
   * «29» dejaría el cursor detrás de un «02/…» que nadie pidió. El texto se
   * resincroniza sólo cuando `value` cambia desde fuera — el calendario, un
   * reset del formulario, la carga de un registro que se está editando.
   */
  const [text, setText] = useState(() => toTypedDay(value));
  const [open, setOpen] = useState(false);
  const anchor = useRef<HTMLDivElement | null>(null);
  const lastEmitted = useRef(value);

  useEffect(() => {
    if (value !== lastEmitted.current) {
      lastEmitted.current = value;
      setText(toTypedDay(value));
    }
  }, [value]);

  const refYear = Number((value || today).slice(0, 4));
  const typed = text.trim() === "" ? null : parseTypedDay(text, refYear);
  const empty = text.trim() === "";
  const invalid = !empty && typed === null;
  const outOfRange =
    typed !== null && ((min !== undefined && typed < min) || (max !== undefined && typed > max));

  function commit(next: string) {
    setText(next);
    const iso = next.trim() === "" ? "" : parseTypedDay(next, refYear);
    if (iso === null) return; // Se sigue escribiendo. No se emite basura.
    lastEmitted.current = iso;
    onChange(iso);
  }

  function pick(iso: string) {
    lastEmitted.current = iso;
    setText(toTypedDay(iso));
    onChange(iso);
    setOpen(false);
  }

  /**
   * EL ECO, que es la razón de ser de todo esto.
   *
   * Ocupa el sitio del `helperText` sólo cuando la pantalla no tiene nada más
   * urgente que decir: un error del formulario manda sobre el eco.
   */
  const echo = helperText
    ? helperText
    : invalid
      ? "No entendimos esa fecha. Escríbala como 29/08/2026 — el día primero."
      : outOfRange
        ? "Esa fecha queda fuera de lo que este campo admite."
        : typed
          ? formatDayFull(typed)
          : "Día, mes y año: 29/08/2026";

  return (
    <>
      <TextField
        label={label}
        name={name}
        value={text}
        onChange={(e) => commit(e.target.value)}
        onBlur={() => {
          // Al salir, lo entendido se escribe entero. Quien tecleó «29/8» ve
          // «29/08/2026» y se queda sin dudas sobre el año.
          if (typed) setText(toTypedDay(typed));
        }}
        error={!!error || invalid || outOfRange}
        helperText={echo}
        required={required}
        disabled={disabled}
        fullWidth={fullWidth}
        size={size}
        placeholder="dd/mm/aaaa"
        // `numeric` y no `tel`: en un teléfono saca el teclado de números con
        // la barra donde están la «/» y el punto.
        inputMode="numeric"
        autoComplete="off"
        ref={anchor}
        slotProps={{
          inputLabel: { shrink: true },
          input: {
            endAdornment: (
              <InputAdornment position="end">
                <IconButton
                  aria-label={`Abrir el calendario de ${label.toLocaleLowerCase("es")}`}
                  edge="end"
                  size="small"
                  disabled={disabled}
                  onClick={() => setOpen(true)}
                >
                  <CalendarMonthIcon fontSize="small" />
                </IconButton>
              </InputAdornment>
            ),
          },
        }}
      />
      {open && (
        <Calendar
          anchorEl={anchor.current}
          selected={isValidDay(value) ? value : null}
          today={today}
          min={min}
          max={max}
          onPick={pick}
          onClose={() => setOpen(false)}
        />
      )}
    </>
  );
}

/* ------------------------------------------------------------------ */
/* El calendario                                                       */
/* ------------------------------------------------------------------ */

function Calendar({
  anchorEl, selected, today, min, max, onPick, onClose,
}: {
  anchorEl: HTMLElement | null;
  selected: string | null;
  today: string;
  min?: string;
  max?: string;
  onPick: (iso: string) => void;
  onClose: () => void;
}) {
  const start = selected ?? today;
  const [cursor, setCursor] = useState(() => ({
    year: Number(start.slice(0, 4)),
    month: Number(start.slice(5, 7)) - 1,
  }));

  const days = useMemo(() => monthGrid(cursor.year, cursor.month), [cursor]);
  const shift = (n: number) =>
    setCursor(({ year, month }) => {
      const m = month + n;
      return { year: year + Math.floor(m / 12), month: ((m % 12) + 12) % 12 };
    });

  const blocked = (iso: string) =>
    (min !== undefined && iso < min) || (max !== undefined && iso > max);

  return (
    <Popover
      open
      anchorEl={anchorEl}
      onClose={onClose}
      anchorOrigin={{ vertical: "bottom", horizontal: "left" }}
      slotProps={{ paper: { sx: { p: 1.5 } } }}
    >
      <Box role="application" aria-label="Calendario">
        <Stack direction="row" alignItems="center" justifyContent="space-between" sx={{ mb: 1 }}>
          <IconButton size="small" aria-label="Mes anterior" onClick={() => shift(-1)}>
            <ChevronLeftIcon fontSize="small" />
          </IconButton>
          {/* El mes escrito, no «08». El punto entero de esta pantalla es que
              nadie tenga que traducir un número a un mes. */}
          <Typography sx={{ fontWeight: 700, minWidth: 168, textAlign: "center" }}>
            {MONTH_NAMES[cursor.month]} de {cursor.year}
          </Typography>
          <IconButton size="small" aria-label="Mes siguiente" onClick={() => shift(1)}>
            <ChevronRightIcon fontSize="small" />
          </IconButton>
        </Stack>

        <Box sx={{ display: "grid", gridTemplateColumns: "repeat(7, 36px)", gap: 0.25 }}>
          {WEEKDAY_INITIALS.map((d, i) => (
            <Typography
              key={i}
              variant="caption"
              sx={{ textAlign: "center", color: "text.secondary", fontWeight: 700 }}
            >
              {d}
            </Typography>
          ))}
          {days.map((iso) => {
            const inMonth = parseDay(iso).getUTCMonth() === cursor.month;
            const isSelected = iso === selected;
            const isToday = iso === today;
            return (
              <Button
                key={iso}
                onClick={() => onPick(iso)}
                disabled={blocked(iso)}
                aria-label={formatDayFull(iso)}
                aria-current={isToday ? "date" : undefined}
                sx={{
                  minWidth: 0,
                  p: 0,
                  height: 36,
                  borderRadius: 1,
                  fontWeight: isSelected || isToday ? 700 : 400,
                  // Fuera del mes se ven, pero apagados: la rejilla mantiene
                  // seis semanas siempre, así que el botón que alguien va a
                  // pulsar no se mueve al cambiar de mes.
                  color: isSelected ? "primary.contrastText" : inMonth ? "text.primary" : "text.disabled",
                  bgcolor: isSelected ? "primary.main" : "transparent",
                  border: !isSelected && isToday ? 1 : 0,
                  borderColor: "primary.main",
                  "&:hover": { bgcolor: isSelected ? "primary.dark" : "action.hover" },
                }}
              >
                {parseDay(iso).getUTCDate()}
              </Button>
            );
          })}
        </Box>

        <Stack direction="row" justifyContent="space-between" sx={{ mt: 1 }}>
          <Button size="small" onClick={() => onPick(today)} disabled={blocked(today)}>
            Hoy
          </Button>
          <Button size="small" color="inherit" onClick={onClose}>
            Cerrar
          </Button>
        </Stack>
      </Box>
    </Popover>
  );
}
