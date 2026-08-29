/**
 * The figures the harvest module is allowed to print.
 *
 * This file exists so that "never show a zero you do not mean" is enforced by
 * the component and not by the discipline of whoever writes the next screen.
 * `<Value>` and `<Kg>` take a `ReportTotals` — which knows how much of itself
 * could be established — and there is deliberately NO prop for passing a bare
 * number. A screen that wants to print a figure has to hand over the
 * provenance with it.
 *
 * A missing figure renders as an em dash carrying its reason, never as `0` and
 * never as a blank cell. A blank reads as "nothing here"; a dash reads as
 * "something is missing", which is the truth.
 */
import type { ReactNode } from "react";
import { Box, Stack, Tooltip, Typography } from "@mui/material";
import { Money } from "../../components/Money";
import { formatQuantity } from "../../lib/money";
import { moneyFont } from "../../theme";
import { kgState, valueState, type Totals } from "./totals";

const plural = (n: number, one: string, many: string) => (n === 1 ? one : many);

/**
 * A dash that says why.
 *
 * Given both a tooltip and an `aria-label`, so the reason survives a mouse and
 * a screen reader alike — "—" read aloud is nothing at all.
 */
export function Unknown({ reason }: { reason: string }) {
  return (
    <Tooltip title={reason}>
      <Box
        component="span"
        aria-label={reason}
        sx={{ color: "text.disabled", fontWeight: 600, cursor: "help" }}
      >
        —
      </Box>
    </Tooltip>
  );
}

/** The small note that rides beside a provisional or partial figure. */
function Note({ children, title }: { children: ReactNode; title?: string }) {
  const text = (
    <Typography variant="caption" sx={{ color: "warning.dark", lineHeight: 1.2 }}>
      {children}
    </Typography>
  );
  return title ? (
    <Tooltip title={title}>
      <Box component="span" sx={{ cursor: "help" }}>
        {text}
      </Box>
    </Tooltip>
  ) : (
    text
  );
}

interface FigureProps {
  total: Totals;
  /** Named in the tooltip, e.g. "esta semana". */
  scope?: string;
  align?: "flex-start" | "flex-end";
}

/**
 * Pesos, with the provenance the farm is owed.
 *
 * `valueIsEstimate` is the server's way of separating what is owed from what
 * has been paid, and it is shown for the same reason `WorkRecordsPage` shows
 * it: a figure that can still move must not look like one that cannot.
 */
export function Value({
  total,
  scope,
  align = "flex-end",
  variant = "inherit",
}: FigureProps & { variant?: "inherit" | "big" | "small" }) {
  const state = valueState(total);
  const where = scope ? ` de ${scope}` : "";

  if (state.kind === "unknown") {
    return (
      <Unknown
        reason={
          total.records === 0
            ? `No hay recolección${where}.`
            : `No se pudo calcular el valor${where}: ${state.missing} ` +
              `${plural(state.missing, "labor no tiene", "labores no tienen")} importe. No es cero.`
        }
      />
    );
  }

  return (
    <Stack alignItems={align} sx={{ minWidth: 0 }}>
      <Money cents={state.cents} variant={variant} />
      {state.kind === "estimate" && <Note>estimado · precio de la semana</Note>}
      {state.kind === "partial" && (
        <Note
          title={
            `Faltan ${state.missing} ${plural(state.missing, "labor sin importe", "labores sin importe")}. ` +
            `La cifra es un mínimo, no el total${where}.`
          }
        >
          al menos · faltan {state.missing}
          {state.isEstimate ? " · estimado" : ""}
        </Note>
      )}
    </Stack>
  );
}

/**
 * Kilos.
 *
 * `recordsNotInKg` is a hole with a specific cause worth naming: a farm can
 * invent a work unit — "canasta" — with no conversion to kilos, and the server
 * leaves those weighings out rather than multiplying by a factor that is not
 * there. Saying so is the difference between "the farm picked less" and "we
 * cannot add these two units together".
 */
export function Kg({
  total,
  scope,
  align = "flex-end",
  bold,
  showUnit = true,
}: FigureProps & { bold?: boolean; showUnit?: boolean }) {
  const state = kgState(total);
  const where = scope ? ` de ${scope}` : "";

  if (state.kind === "unknown") {
    return (
      <Unknown
        reason={
          total.records === 0
            ? `No hay recolección${where}.`
            : `No se pudo expresar en kilos${where}: ${state.missing} ` +
              `${plural(state.missing, "pesada está", "pesadas están")} en una unidad que no ` +
              `convierte a kilos. No es cero.`
        }
      />
    );
  }

  return (
    <Stack alignItems={align} sx={{ minWidth: 0 }}>
      <Box component="span" sx={{ ...moneyFont, fontWeight: bold ? 700 : 500, whiteSpace: "nowrap" }}>
        {formatQuantity(state.kg)}
        {showUnit && (
          <Box component="span" sx={{ color: "text.secondary", fontWeight: 500 }}>
            {" "}
            kg
          </Box>
        )}
      </Box>
      {state.kind === "partial" && (
        <Note
          title={
            `${state.missing} ${plural(state.missing, "pesada quedó fuera", "pesadas quedaron fuera")} ` +
            `porque su unidad no convierte a kilos. La cifra es un mínimo.`
          }
        >
          al menos · faltan {state.missing}
        </Note>
      )}
    </Stack>
  );
}

/** A plain nullable number — an index, a rate — that is a dash when absent. */
export function Figure({
  value,
  format = (n) => formatQuantity(n),
  suffix,
  reason = "Sin dato.",
  bold,
}: {
  value: number | null;
  format?: (n: number) => string;
  suffix?: string;
  reason?: string;
  bold?: boolean;
}) {
  if (value === null) return <Unknown reason={reason} />;
  return (
    <Box component="span" sx={{ ...moneyFont, fontWeight: bold ? 700 : 500, whiteSpace: "nowrap" }}>
      {format(value)}
      {suffix ? (
        <Box component="span" sx={{ color: "text.secondary", fontWeight: 500 }}>
          {" "}
          {suffix}
        </Box>
      ) : null}
    </Box>
  );
}

/** A big number over a small label. The tiles across the top of a screen. */
export function Stat({
  label,
  children,
  hint,
}: {
  label: string;
  children: ReactNode;
  hint?: string;
}) {
  const body = (
    <Box
      sx={{
        px: 2,
        py: 1.5,
        borderRadius: 3,
        border: 1,
        borderColor: "divider",
        bgcolor: "#fbfcfa",
        minWidth: 0,
        height: "100%",
      }}
    >
      <Typography
        variant="overline"
        sx={{ color: "text.secondary", fontSize: 10, display: "block", lineHeight: 1.6 }}
      >
        {label}
      </Typography>
      <Box sx={{ fontSize: "1.35rem", fontWeight: 700, ...moneyFont, mt: 0.25 }}>{children}</Box>
    </Box>
  );
  return hint ? <Tooltip title={hint}>{body}</Tooltip> : body;
}
