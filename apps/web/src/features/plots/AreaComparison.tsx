import { Alert, Box, Divider, Stack, Typography } from "@mui/material";
import { formatArea } from "../../lib/money";

/**
 * The two hectare figures, side by side, with the gap between them spelled
 * out.
 *
 * THIS COMPONENT IS THE DECISION, not a formatting detail. `openapi.yaml` says
 * it in the schema: "Returned alongside `areaHa` and never instead of it: they
 * always disagree, and hiding one decides for the owner which one lies." So
 * the screen shows both, at the same size, in the same weight, and the
 * difference is stated rather than left for the reader to subtract.
 *
 * THE TONE IS DELIBERATE. The difference is `info`, never `warning`, and the
 * sentence never says "corrija" or "revise". A declared figure that is larger
 * than the drawn one is the normal case and it is not a mistake: a deed says
 * 4 ha, the fence follows a creek, and the polygon is a person tracing a
 * hillside with a mouse. The owner is the only one who knows which number the
 * bank, the buyer and the cooperative are going to ask for. Our job is to put
 * the two in front of them and get out of the way — a red box telling a farmer
 * their own land title is wrong is the fastest way to have them ignore
 * everything else this console says.
 *
 * Above 25% the wording changes — not to scold, but because at that size the
 * likeliest explanation stops being "the creek" and starts being "a corner
 * landed on the wrong hill", and saying so is useful rather than bossy.
 */
export interface AreaComparisonProps {
  /** What the owner declared. */
  declaredHa: number | null;
  /** What was measured off the polygon. Null until one is drawn. */
  computedHa: number | null;
  /**
   * True while the measurement is this browser's arithmetic and not the
   * server's. Says so on screen: an unlabelled provisional number that later
   * moves is how a person stops trusting both of them.
   */
  provisional?: boolean;
  dense?: boolean;
}

export function areaDifference(
  declaredHa: number | null,
  computedHa: number | null,
): { deltaHa: number; percent: number } | null {
  if (declaredHa === null || computedHa === null) return null;
  if (!(declaredHa > 0)) return null;
  return {
    deltaHa: computedHa - declaredHa,
    percent: ((computedHa - declaredHa) / declaredHa) * 100,
  };
}

export function AreaComparison({
  declaredHa,
  computedHa,
  provisional = false,
  dense = false,
}: AreaComparisonProps) {
  const diff = areaDifference(declaredHa, computedHa);
  const pct = diff ? Math.abs(diff.percent) : 0;
  const bigger = diff ? diff.deltaHa > 0 : false;

  return (
    <Box>
      <Stack direction="row" spacing={dense ? 2 : 4} alignItems="flex-start">
        <Box>
          <Typography variant={dense ? "h3" : "h2"} component="p">
            {declaredHa === null ? "—" : `${formatArea(declaredHa)} ha`}
          </Typography>
          <Typography variant="caption" color="text.secondary">
            declarada por usted
          </Typography>
        </Box>
        <Divider orientation="vertical" flexItem />
        <Box>
          <Typography
            variant={dense ? "h3" : "h2"}
            component="p"
            color={computedHa === null ? "text.disabled" : undefined}
          >
            {computedHa === null ? "—" : `${formatArea(computedHa)} ha`}
          </Typography>
          <Typography variant="caption" color="text.secondary">
            {computedHa === null
              ? "del polígono (sin dibujar)"
              : provisional
                ? "del polígono (mientras dibuja)"
                : "medida del polígono"}
          </Typography>
        </Box>
      </Stack>

      {diff !== null && (
        <Alert severity="info" sx={{ mt: 2 }} icon={false}>
          <Typography variant="body2" sx={{ fontWeight: 600, mb: 0.5 }}>
            La diferencia es de {formatArea(Math.abs(diff.deltaHa))} ha
            {" "}({pct < 0.5 ? "menos del 1" : Math.round(pct)}%
            {" "}
            {bigger ? "más" : "menos"} que la declarada).
          </Typography>
          <Typography variant="body2" color="text.secondary">
            {pct >= 25
              ? "Es una diferencia grande. Suele significar que alguna esquina quedó en el sitio equivocado, o que la superficie declarada incluye terreno que el polígono no abarca. Las dos cifras se guardan; usted decide cuál usa."
              : "Es lo normal: la declarada viene de la escritura y el polígono de lo que se dibujó sobre el terreno. Ninguna de las dos reemplaza a la otra, y las dos quedan guardadas."}
          </Typography>
        </Alert>
      )}
    </Box>
  );
}
