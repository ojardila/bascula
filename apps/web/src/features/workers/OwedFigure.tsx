/**
 * La cifra de «lo que se le debe», escrita igual en todas partes.
 *
 * Un componente y no cuatro `<Money>` sueltos, por lo mismo que
 * `harvest/Figures.tsx`: no acepta un número pelado. Recibe un `Owed`, que
 * sabe cuánto de sí mismo se pudo establecer, y decide solo si lo que
 * corresponde es una cifra, una cifra con «al menos», o un guion con su
 * motivo. Una pantalla no puede equivocarse en esto por prisa.
 *
 * RESPONDER PRIMERO Y EXPLICAR DESPUÉS. Arriba va el total —la cifra por la
 * que preguntó— y debajo, en pequeño, de dónde sale. Al revés, que es como
 * estaba el perfil, la cifra grande es la mitad de la respuesta y la otra
 * mitad se lee sólo si alguien baja la vista.
 */
import { Box, Stack, Tooltip, Typography } from "@mui/material";
import { Money } from "../../components/Money";
import { owedState, type Owed } from "./owed";

/** Un guion que dice por qué. Igual que el de `harvest/Figures.tsx`. */
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
 * El total. Positivo es lo que la finca le debe a la persona; negativo, lo que
 * la persona le debe a la finca — y en ese caso la cifra se escribe sin signo
 * con la frase al lado, porque nadie lee un menos como «me deben a mí».
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
            incluye estimado · precio de la semana
          </Typography>
        </Tooltip>
      )}
    </Stack>
  );
}

/** «a favor del empleado» / «que el empleado le debe a la finca». */
export function owedDirection(owed: Owed, who = "el empleado"): string | null {
  const state = owedState(owed);
  if (state.kind === "unknown") return null;
  if (state.cents === 0) return "está a paz y salvo";
  return state.cents > 0 ? `a favor ${dePrefix(who)}` : `que ${who} le debe a la finca`;
}

const dePrefix = (who: string) => (who.startsWith("el ") ? `del ${who.slice(3)}` : `de ${who}`);

/**
 * El desglose: las dos mitades de las que sale el total, en pequeño y debajo.
 *
 * Las dos se escriben SIEMPRE, incluso cuando una es cero, porque la pregunta
 * que contestan no es «¿cuánto?» sino «¿de dónde sale?», y una línea que
 * desaparece deja al lector sin saber si es cero o si no existe. Un hueco de
 * lectura se escribe como hueco, no se omite.
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
