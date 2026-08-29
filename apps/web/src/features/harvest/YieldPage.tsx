/**
 * Who is picking more and who less — presented so the answer is usable and the
 * comparison is defensible.
 *
 * THIS SCREEN IS ABOUT PEOPLE, AND IT IS BUILT LIKE IT.
 *
 * The arithmetic is the fair part and the server owns it: everyone is measured
 * only against the people who worked the SAME CROP the SAME DAY, the person is
 * excluded from their own benchmark, and it averages daily ratios rather than
 * dividing sums. Whoever gets the ripest lot cannot win by being handed it.
 *
 * The presentation is the part that can still do damage, and these are the
 * four decisions that shape it:
 *
 * 1. **No positions.** No "1.", no medal, no bottom of a list. A numbered
 *    leaderboard turns ordinary variation into a verdict, and the person at
 *    the end of it is the one whose contract does not get renewed. What is
 *    drawn instead is the DISTRIBUTION — everyone on one scale centred on 1.00
 *    — where the honest fact is usually visible at a glance: most people
 *    cluster, and the cluster is what "normal" means.
 *
 * 2. **The context travels with the number.** Every row carries how many
 *    comparable days it rests on. An index from three days is not the same
 *    claim as one from twenty and must not look like it. The absolute kilos
 *    and kg/day sit beside it too, because somebody at 0.85 who picks 45 kg a
 *    day is doing fine and the index alone hides that.
 *
 * 3. **Nobody is ranked who cannot be compared.** The server sends `index:
 *    null` with a `reason` rather than a low number, and this lists those
 *    people separately — not sorted to the bottom, where "no index" reads as
 *    "worst".
 *
 * 4. **What it does not measure is on the screen, not in a tooltip.** It does
 *    not measure effort, hours, or worth. That sentence is the difference
 *    between a tool and an accusation, so it is printed where it cannot be
 *    missed.
 */
import {
  Alert, Box, Card, CardContent, Chip, CircularProgress, Divider, Stack, Tooltip,
  Typography,
} from "@mui/material";
import TrendingDownIcon from "@mui/icons-material/TrendingDown";
import TrendingUpIcon from "@mui/icons-material/TrendingUp";
import { useAsync } from "../../lib/useAsync";
import { PermissionDenied } from "../../components/Guards";
import { reportPerformance } from "../../api/harvest";
import { formatDate } from "../../lib/dates";
import { formatQuantity } from "../../lib/money";
import { moneyFont, GREEN_DARK } from "../../theme";
import { useHarvest } from "./HarvestLayout";
import { Figure, Kg } from "./Figures";
import { INDEX_CAVEAT, INDEX_EXPLAINER, NO_INDEX_SECTION_BODY, noIndexReason } from "./text";
import type { WireWorkerPerformance } from "../../api/wire";

/** The bands, each one always rendered WITH its word. Never colour alone. */
const ABOVE = 1.15;
const BELOW = 0.85;

function band(index: number): { word: string; color: string } {
  if (index >= ABOVE) return { word: "por encima de sus compañeros", color: GREEN_DARK };
  if (index <= BELOW) return { word: "por debajo de sus compañeros", color: "#8a5a00" };
  return { word: "en el promedio de su cuadrilla", color: "#43483f" };
}

const dec = (n: number) => n.toFixed(2).replace(".", ",");

export function YieldPage() {
  const { days } = useHarvest();
  const { data, error, denied } = useAsync(() => reportPerformance(days), [days]);

  if (denied) return <PermissionDenied moduleName="ver la cosecha" />;
  if (error) {
    return (
      <Alert severity="error">
        No se pudo consultar el rendimiento: {error}. No se muestra ningún índice —
        y ninguno de ellos es cero.
      </Alert>
    );
  }
  if (!data) {
    return (
      <Stack alignItems="center" sx={{ py: 6 }}>
        <CircularProgress />
      </Stack>
    );
  }

  // The server sends the ones with an index first and never interleaves them.
  const ranked = data.items.filter((r) => r.index !== null);
  const withoutBasis = data.items.filter((r) => r.index === null);

  const lo = Math.min(0.6, ...ranked.map((r) => r.index!));
  const hi = Math.max(1.6, ...ranked.map((r) => r.index!));
  const pos = (v: number) => ((v - lo) / (hi - lo)) * 100;

  return (
    <Stack spacing={3}>
      <Card sx={{ bgcolor: "#f6f9f4" }}>
        <CardContent>
          <Typography variant="h3" gutterBottom>
            Qué está comparando esta pantalla
          </Typography>
          <Typography variant="body2" sx={{ mb: 1 }}>
            {INDEX_EXPLAINER}
          </Typography>
          <Typography variant="body2" sx={{ fontWeight: 600, color: "warning.dark" }}>
            {INDEX_CAVEAT}
          </Typography>
          <Typography variant="caption" color="text.secondary" sx={{ mt: 1.5, display: "block" }}>
            Ventana: {data.days} días, desde el {formatDate(data.since)}, en el calendario
            de la finca.
          </Typography>
        </CardContent>
      </Card>

      {!data.items.length ? (
        <Alert severity="info">
          Nadie registró recolección en esta ventana, así que no hay a quién comparar.
        </Alert>
      ) : ranked.length === 0 ? (
        <Alert severity="info">
          Todavía no se puede comparar a nadie. {NO_INDEX_SECTION_BODY}
        </Alert>
      ) : (
        <Card>
          <CardContent>
            <Typography variant="h3">Cómo se reparte el rendimiento</Typography>
            <Typography variant="body2" color="text.secondary" sx={{ mb: 3 }}>
              Cada punto es una persona. Mientras más juntos estén, más parecido rinde
              la cuadrilla — que es lo normal en una finca.
            </Typography>
            <Distribution rows={ranked} lo={lo} hi={hi} pos={pos} />
          </CardContent>
        </Card>
      )}

      {ranked.map((r) => {
        const b = band(r.index!);
        return (
          <Card key={r.workerId}>
            <CardContent sx={{ py: 2 }}>
              <Stack
                direction={{ xs: "column", sm: "row" }}
                spacing={2}
                alignItems={{ sm: "center" }}
                justifyContent="space-between"
              >
                <Box sx={{ minWidth: 0, flex: 1 }}>
                  <Typography sx={{ fontWeight: 700, fontSize: "1.05rem" }}>{r.name}</Typography>
                  <Typography variant="body2" sx={{ color: b.color, fontWeight: 600 }}>
                    {b.word}
                  </Typography>

                  {/* The context that makes the number fair, beside it, always. */}
                  <Stack direction="row" spacing={1} sx={{ mt: 1, flexWrap: "wrap", rowGap: 0.75 }}>
                    <Tooltip
                      title={`Días en los que esta persona coincidió con otras en el mismo cultivo. Hacen falta al menos ${data.minComparableDays} para que haya índice.`}
                    >
                      <Chip
                        size="small"
                        variant="outlined"
                        label={`${r.comparableDays} ${
                          r.comparableDays === 1 ? "día comparable" : "días comparables"
                        }`}
                        sx={{ cursor: "help" }}
                      />
                    </Tooltip>
                    <Chip
                      size="small"
                      variant="outlined"
                      label={`${r.days} ${r.days === 1 ? "día trabajado" : "días trabajados"}`}
                    />
                    {r.trend !== null && Math.abs(r.trend - 1) > 0.15 && (
                      <Tooltip title="Compara la mitad reciente de la ventana con la anterior. Solo aparece cuando ambas mitades tienen días suficientes.">
                        <Chip
                          size="small"
                          variant="outlined"
                          icon={r.trend > 1 ? <TrendingUpIcon /> : <TrendingDownIcon />}
                          label={r.trend > 1 ? "va subiendo" : "va bajando"}
                          sx={{ cursor: "help" }}
                        />
                      </Tooltip>
                    )}
                  </Stack>
                </Box>

                {/* The absolute figures, so the index is never read alone. */}
                <Stack direction="row" spacing={3} alignItems="center">
                  <Box sx={{ textAlign: "right" }}>
                    <Typography variant="overline" sx={{ fontSize: 10, color: "text.secondary", display: "block" }}>
                      Recogido
                    </Typography>
                    <Kg total={r} scope={r.name} />
                    <Typography variant="caption" color="text.secondary" sx={{ display: "block" }}>
                      <Figure
                        value={r.kgPerDay}
                        suffix="kg por día"
                        reason="Sus pesadas no se pudieron expresar en kilos, así que no hay una media por día. No es cero."
                      />
                    </Typography>
                  </Box>
                  <Box sx={{ textAlign: "right", minWidth: 64 }}>
                    <Typography variant="overline" sx={{ fontSize: 10, color: "text.secondary", display: "block" }}>
                      Índice
                    </Typography>
                    <Box sx={{ ...moneyFont, fontSize: "1.6rem", fontWeight: 700, color: b.color, lineHeight: 1.1 }}>
                      {dec(r.index!)}
                    </Box>
                  </Box>
                </Stack>
              </Stack>
            </CardContent>
          </Card>
        );
      })}

      {withoutBasis.length > 0 && (
        <Card variant="outlined" sx={{ bgcolor: "#fbfcfa" }}>
          <CardContent>
            <Typography variant="h3" gutterBottom>
              Sin base para comparar
            </Typography>
            <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
              {NO_INDEX_SECTION_BODY}
            </Typography>
            <Divider sx={{ mb: 1.5 }} />
            <Stack spacing={1.5}>
              {withoutBasis.map((r) => (
                <Stack
                  key={r.workerId}
                  direction={{ xs: "column", sm: "row" }}
                  justifyContent="space-between"
                  alignItems={{ sm: "baseline" }}
                  spacing={1}
                >
                  <Box>
                    <Typography sx={{ fontWeight: 600 }}>{r.name}</Typography>
                    <Typography variant="caption" color="text.secondary">
                      {noIndexReason(r.reason, data.minComparableDays)}
                    </Typography>
                  </Box>
                  <Stack direction="row" spacing={2} alignItems="baseline">
                    <Typography variant="caption" color="text.secondary">
                      {r.comparableDays} de {data.minComparableDays} días comparables
                    </Typography>
                    <Kg total={r} scope={r.name} />
                  </Stack>
                </Stack>
              ))}
            </Stack>
          </CardContent>
        </Card>
      )}
    </Stack>
  );
}

/**
 * Everyone on one scale, centred on 1.00.
 *
 * This is the anti-leaderboard: the reader sees the SHAPE first — a tight
 * cluster or a real spread — and only then reads individual names. A list
 * sorted top to bottom shows rank and hides shape, and rank is the thing that
 * invites an unfair decision.
 */
function Distribution({
  rows,
  lo,
  hi,
  pos,
}: {
  rows: WireWorkerPerformance[];
  lo: number;
  hi: number;
  pos: (v: number) => number;
}) {
  return (
    <Box sx={{ px: 1 }}>
      <Box sx={{ position: "relative", height: 74 }}>
        {/* The normal band, named. A grey strip with no label is a mystery. */}
        <Box
          sx={{
            position: "absolute",
            left: `${pos(BELOW)}%`,
            width: `${pos(ABOVE) - pos(BELOW)}%`,
            top: 18,
            height: 26,
            bgcolor: "rgba(46,125,50,.08)",
            borderRadius: 1,
          }}
        />
        <Box
          sx={{
            position: "absolute",
            left: `${pos(1)}%`,
            top: 12,
            height: 38,
            borderLeft: "2px solid",
            borderColor: "success.dark",
          }}
        />
        <Typography
          variant="caption"
          sx={{
            position: "absolute", left: `${pos(1)}%`, top: 0,
            transform: "translateX(-50%)", fontWeight: 700, color: "success.dark",
            whiteSpace: "nowrap",
          }}
        >
          1,00 · igual que sus compañeros
        </Typography>

        {rows.map((r, i) => (
          <Tooltip
            key={r.workerId}
            title={`${r.name}: ${dec(r.index!)} sobre ${r.comparableDays} días comparables`}
          >
            <Box
              sx={{
                position: "absolute",
                left: `${pos(r.index!)}%`,
                // Stagger so overlapping dots stay countable.
                top: 22 + (i % 3) * 7,
                width: 12,
                height: 12,
                ml: "-6px",
                borderRadius: "50%",
                bgcolor: band(r.index!).color,
                border: "2px solid #fff",
                cursor: "help",
              }}
            />
          </Tooltip>
        ))}

        <Box sx={{ position: "absolute", left: 0, right: 0, top: 56, borderTop: 1, borderColor: "divider" }} />
        <Typography variant="caption" sx={{ position: "absolute", left: 0, top: 58, color: "text.secondary" }}>
          {dec(lo)}
        </Typography>
        <Typography variant="caption" sx={{ position: "absolute", right: 0, top: 58, color: "text.secondary" }}>
          {dec(hi)}
        </Typography>
      </Box>
      <Typography variant="caption" color="text.secondary" sx={{ mt: 1, display: "block" }}>
        {formatQuantity(rows.length)}{" "}
        {rows.length === 1 ? "persona comparable" : "personas comparables"} en la ventana.
      </Typography>
    </Box>
  );
}
