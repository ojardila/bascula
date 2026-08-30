/**
 * ── THE DATE FIELD, WITH ITS CALENDAR IN SPANISH ─────────────────────────
 *
 * `<input type="date">` asked for `mm/dd/yyyy`. Somebody types August 3rd as
 * 03/08, the browser saves March 8th, and the work item lands in another week
 * — at another price. Of every usability bug in here, this is the one with
 * the shortest path from a keystroke to the money somebody takes home.
 *
 * LAST SPRINT DID HALF OF IT: tagging the input `es-CO`. Firefox and Safari
 * obey; Chrome looks at the language the browser itself is configured in, and
 * doesn't. A fix that depends on which browser the farm happens to have is not
 * a fix, it is a lottery. This component is the other half, and it is the half
 * that settles the matter: the browser no longer decides the mask.
 *
 * THE THREE THINGS IT DOES, IN ORDER OF IMPORTANCE:
 *
 *   1. **IT SPELLS OUT WHAT IT UNDERSTOOD.** Under the field, always:
 *      "sábado 29 de agosto de 2026". This is the real fix. The reported
 *      problem was never the mask: it was that whoever types 29/08 *does not
 *      know what they saved*. With the date written out in words there is no
 *      need to trust the mask, or the browser, or how the machine is set up
 *      — you read it and that is that.
 *   2. It accepts what people really type: 29/8, 29/08/26, 29-8-2026,
 *      29082026. Always day first. See `parseTypedDay`.
 *   3. A calendar, in Spanish, with the week starting on Monday and the
 *      months spelled out, for whoever would rather point than type.
 *
 * WHAT IT DOES NOT DO, ON PURPOSE. It never corrects on its own. "31/02" does
 * not turn into the 28th: it is marked invalid and nothing is saved. A date
 * the program changes without saying so is exactly the bug we came here to
 * fix, wearing a different costume.
 *
 * AND IT IS NOT A NEW DEPENDENCY. An off-the-shelf date picker is hundreds of
 * kilobytes over a farm's connection, and it brings its own idea of what a day
 * is in which timezone — precisely the decision `lib/dates.ts` already makes
 * and the rest of the product respects.
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
  /** `YYYY-MM-DD`, or "" when there is not one yet. */
  value: string;
  /** Gets `YYYY-MM-DD`, or "" if the person emptied the field. */
  onChange: (iso: string) => void;
  /** Shown in place of the echo when the screen has something to say. */
  helperText?: string;
  error?: boolean;
  required?: boolean;
  disabled?: boolean;
  fullWidth?: boolean;
  size?: "small" | "medium";
  /** The earliest day accepted, `YYYY-MM-DD`. It only warns; it never blocks. */
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
   * While somebody is typing, the text is state of its own.
   *
   * If the field redrew from `value` on every keystroke, typing the "2" of
   * "29" would leave the cursor behind an "02/…" nobody asked for. The text
   * resyncs only when `value` changes from outside — the calendar, a form
   * reset, loading the record being edited.
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
    if (iso === null) return; // Still typing. Nothing half-formed goes out.
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
   * THE ECHO, which is the whole reason this exists.
   *
   * It takes the `helperText` slot only when the screen has nothing more
   * urgent to say: a form error outranks the echo.
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
          // On the way out, what we understood is written in full. Whoever
          // typed "29/8" sees "29/08/2026" and is left in no doubt about
          // the year.
          if (typed) setText(toTypedDay(typed));
        }}
        error={!!error || invalid || outOfRange}
        helperText={echo}
        required={required}
        disabled={disabled}
        fullWidth={fullWidth}
        size={size}
        placeholder="dd/mm/aaaa"
        // `numeric` and not `tel`: on a phone it brings up the number pad
        // with the row that has the "/" and the dot.
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
/* The calendar                                                        */
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
          {/* The month spelled out, not "08". The whole point of this screen
              is that nobody has to translate a number into a month. */}
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
                  // Days outside the month still show, but dimmed: the grid
                  // always keeps six weeks, so the button somebody is about
                  // to press does not move when the month changes.
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
