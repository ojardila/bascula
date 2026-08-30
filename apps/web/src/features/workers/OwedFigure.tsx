/**
 * The "what they are owed" figure, written the same way everywhere.
 *
 * One component rather than four loose `<Money>`s, for the same reason as
 * `harvest/Figures.tsx`: it does not accept a bare number. It takes an `Owed`,
 * which knows how much of itself could be established, and decides on its own
 * whether what belongs there is a figure, a figure with an "al menos", or a
 * dash with its reason. A screen must not be able to get this wrong in a
 * hurry.
 *
 * ANSWER FIRST, EXPLAIN AFTERWARDS. The total goes on top —the figure they
 * asked for— and underneath, small, where it comes from. The other way round,
 * which is how the profile used to be, the big figure is half the answer and
 * the other half is only read if somebody looks down.
 */
import { Box, Stack, Tooltip, Typography } from "@mui/material";
import { Money } from "../../components/Money";
import { owedState, type Owed } from "./owed";
import { PROVISIONAL_INCLUDES } from "../../lib/vocab";

/** A dash that says why. The same one as in `harvest/Figures.tsx`. */
function Unknown({ reason, big }: { reason: string; big?: boolean }) {
  return (
    <Tooltip title={reason}>
      <Box
        component="span"
        aria-label={reason}
        sx={{
          color: "text.disabled",
          fontWeight: 700,
          cursor: "help",
          fontSize: big ? "1.9rem" : undefined,
          lineHeight: big ? 1.1 : undefined,
        }}
      >
        —
      </Box>
    </Tooltip>
  );
}

/**
 * The total. Positive is what the farm owes the person; negative, what the
 * person owes the farm — and in that case the figure is written unsigned with
 * the phrase beside it, because nobody reads a minus sign as "they owe me".
 */
export function OwedFigure({
  owed,
  variant = "inherit",
  align = "flex-end",
}: {
  owed: Owed;
  variant?: "inherit" | "big" | "small";
  align?: "flex-start" | "flex-end";
}) {
  const state = owedState(owed);

  if (state.kind === "unknown") {
    return <Unknown reason={state.reason} big={variant === "big"} />;
  }

  return (
    <Stack alignItems={align} sx={{ minWidth: 0 }}>
      <Money cents={Math.abs(state.cents)} variant={variant} />
      {state.kind === "partial" && (
        <Tooltip title={state.reason}>
          <Typography
            variant="caption"
            sx={{ color: "warning.dark", lineHeight: 1.2, cursor: "help" }}
          >
            al menos · falta lo pendiente
          </Typography>
        </Tooltip>
      )}
      {state.kind === "known" && state.isEstimate && (
        <Tooltip title="Parte de esta cifra se paga al precio de la semana, que se fija al liquidar. Hasta entonces puede moverse.">
          <Typography
            variant="caption"
            sx={{ color: "warning.dark", lineHeight: 1.2, cursor: "help" }}
          >
            {PROVISIONAL_INCLUDES}
          </Typography>
        </Tooltip>
      )}
    </Stack>
  );
}

/** "a favor del empleado" / "que el empleado le debe a la finca". */
export function owedDirection(owed: Owed, who = "el empleado"): string | null {
  const state = owedState(owed);
  if (state.kind === "unknown") return null;
  if (state.cents === 0) return "está a paz y salvo";
  return state.cents > 0 ? `a favor ${dePrefix(who)}` : `que ${who} le debe a la finca`;
}

const dePrefix = (who: string) => (who.startsWith("el ") ? `del ${who.slice(3)}` : `de ${who}`);

/**
 * The breakdown: the two halves the total comes out of, small and underneath.
 *
 * Both are ALWAYS written, even when one is zero, because the question they
 * answer is not "how much?" but "where does it come from?", and a line that
 * disappears leaves the reader unable to tell zero from missing. A hole in
 * the reading is written as a hole; it is not omitted.
 */
export function OwedBreakdown({
  owed,
  align = "flex-end",
}: {
  owed: Owed;
  align?: "flex-start" | "flex-end";
}) {
  return (
    <Stack spacing={0.25} alignItems={align} sx={{ mt: 0.5 }}>
      <Line
        label="ya liquidado, en el libro"
        cents={owed.balanceCents}
        missing="No se pudo consultar el saldo del libro. No es cero."
      />
      <Line
        label={
          owed.pendingIsEstimate
            ? "sin liquidar (al precio de la semana)"
            : "sin liquidar todavía"
        }
        cents={owed.pendingCents}
        missing="No se pudo consultar lo pendiente de liquidar. No es cero."
      />
    </Stack>
  );
}

function Line({
  label,
  cents,
  missing,
}: {
  label: string;
  cents: number | null;
  missing: string;
}) {
  return (
    <Stack direction="row" spacing={0.75} alignItems="baseline">
      {cents === null ? (
        <Unknown reason={missing} />
      ) : (
        <Money cents={cents} variant="small" />
      )}
      <Typography variant="caption" color="text.secondary">
        {label}
      </Typography>
    </Stack>
  );
}
