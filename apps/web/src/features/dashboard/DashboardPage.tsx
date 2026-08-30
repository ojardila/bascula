import { useNavigate } from "react-router-dom";
import {
  Box, Button, Card, CardContent, Grid, Skeleton, Stack, Typography,
} from "@mui/material";
import TerrainIcon from "@mui/icons-material/Terrain";
import GroupsIcon from "@mui/icons-material/Groups";
import FactCheckIcon from "@mui/icons-material/FactCheck";
import PriceChangeIcon from "@mui/icons-material/PriceChange";
import PaymentsIcon from "@mui/icons-material/Payments";
import { Money } from "../../components/Money";
import { useAsync } from "../../lib/useAsync";
import { api } from "../../api/endpoints";
import { useAuth } from "../../auth/AuthContext";
import { formatArea, formatQuantity } from "../../lib/money";
import { mondayOf, todayInFarm, formatMonday } from "../../lib/dates";
import { Value } from "../harvest/Figures";
import { totalsOfRecords } from "../harvest/totals";
import { owedByWorker, sumOwedToFarmWorkers } from "../workers/owed";
import { PLOT, PROVISIONAL_INCLUDES } from "../../lib/vocab";

/**
 * The farm at a glance. Deliberately four figures and not twelve: the useful
 * dashboard is the one somebody actually reads on the way to doing something,
 * so every tile is also a door.
 */
/**
 * What a tile shows when the figure could not be fetched.
 *
 * Not "$0". A zero is a number a farm can genuinely owe, so printing it for
 * "we do not know" makes a failed request indistinguishable from being square
 * with everybody — which is the one mistake this screen must not make.
 *
 * AND IT IS NOT ONLY THE MONEY TILES. This function existed, with that comment
 * on it, while the two tiles next to it printed "0 kg" and "0" out of the very
 * same failed requests: `kgThisWeek` folds the `records` list that the tile
 * above it correctly refuses to sum, and "Lotes activos" printed `plots
 * ?.length ?? 0`, which is 0 for a farm whose lots could not be loaded. A
 * quantity and a count are as capable of meaning "I do not know" as a peso is.
 */
function Unknown() {
  return (
    <Typography variant="h1" sx={{ fontSize: "1.9rem", color: "text.disabled" }}>
      —
    </Typography>
  );
}

/**
 * And what it shows IN THE MEANTIME, which is a different thing again.
 *
 * "The dashboard says $0 while it loads" was literal: `(balances ?? [])` adds
 * up to zero before anything arrives, so the first figure the owner sees every
 * morning is a zero that lasts as long as the network does — and on a farm
 * that is a while. A dash is no good here either: a dash means "could not",
 * and we still can. Three states, three drawings.
 */
function Loading() {
  return (
    <Skeleton variant="text" width="60%" sx={{ fontSize: "1.9rem" }} />
  );
}

export function DashboardPage() {
  const navigate = useNavigate();
  const { user, can } = useAuth();
  const timezone = user?.farm?.timezone ?? "America/Bogota";
  const monday = mondayOf(todayInFarm(timezone));

  // The error was not even captured before, which is why the tile could not
  // have told the truth however carefully it was written.
  const { data: plots, error: plotsError, loading: plotsLoading } = useAsync(
    () => api.listPlots({ status: "active" }),
    [],
  );
  const { data: records, error: recordsError, loading: recordsLoading } = useAsync(
    () => api.listWorkRecords({ status: "active" }),
    [],
  );
  // The farm's position comes from /v1/balances, which derives it from the
  // ledger. Adding up a `balanceCents` on the worker list is what this used to
  // do, and that endpoint has never sent one — so the tile read $0 for a farm
  // that was owing a week of picking, with no sign anything was missing.
  const { data: balances, error: balancesError, loading: balancesLoading } = useAsync(
    () => api.listBalances(),
    [],
  );

  /**
   * ── THE FIGURE THAT HAS TO AGREE WITH THE OTHER THREE ────────────────
   *
   * This tile said $334.500 —the sum of the ledgers— while the pay screen said
   * $338.100 for the same farm, because work done and not yet settled was not
   * in it. The farm owes it just the same: settling is the paperwork, not the
   * debt.
   *
   * The sum is done by `features/workers/owed.ts`, which is also what adds up
   * the employee list and what each profile shows. One definition, three
   * screens — and not the other way round.
   */
  const accounts = owedByWorker(balances, records);
  const farmOwes = sumOwedToFarmWorkers([...accounts.values()]);
  const shownOwedCents = balancesError ? null : (farmOwes.cents ?? farmOwes.floorCents);
  const pending = (records ?? []).filter((r) => !r.settled);
  /**
   * Folded rather than summed, so the tile keeps `amountIsEstimate`. On the
   * seeded farm all 44 unsettled labores are priced by the week, which makes
   * this figure 100% estimate — and it printed as a firm "$1.507.920".
   */
  const pendingTotals = totalsOfRecords(pending);
  const kgThisWeek = (records ?? [])
    .filter((r) => r.unitLabel === "kg" && mondayOf(r.dateFrom) === monday)
    .reduce((a, r) => a + r.quantity, 0);
  // Only the lots that declared one. A lot with no area used to add a zero
  // here and quietly shrink the farm.
  const declaredPlots = (plots ?? []).filter((p) => p.areaHa !== null);
  const totalHa = declaredPlots.reduce((a, p) => a + (p.areaHa as number), 0);
  const undeclaredPlots = (plots ?? []).length - declaredPlots.length;

  const tiles = [
    {
      label: "Lo que la finca les debe a los empleados",
      /**
       * When the thing that failed is `/v1/work-records`, the ledger WAS read
       * and that balance is a valid FLOOR — what is outstanding can only add
       * to it. A dash there would hide a figure we do know; a clean total
       * would lie. We print the floor and say that is what it is.
       */
      value: balancesLoading || recordsLoading ? (
        <Loading />
      ) : shownOwedCents === null ? (
        <Unknown />
      ) : (
        <Money cents={shownOwedCents} variant="big" />
      ),
      hint:
        balancesLoading || recordsLoading
          ? "consultando…"
          : shownOwedCents === null
          ? "no se pudo consultar"
          : farmOwes.cents === null
            ? "al menos: sólo lo ya liquidado, lo pendiente no se pudo consultar"
            : "lo ya liquidado más lo que falta liquidar" +
              (farmOwes.isEstimate ? ` · ${PROVISIONAL_INCLUDES}` : ""),
      to: "/empleados",
    },
    {
      label: "Pendiente de liquidar",
      value: recordsLoading ? (
        <Loading />
      ) : recordsError ? (
        <Unknown />
      ) : (
        <Value total={pendingTotals} variant="big" align="flex-start" />
      ),
      hint: recordsLoading
        ? "consultando…"
        : recordsError
          ? "no se pudo consultar"
          : `${pending.length} ${pending.length === 1 ? "labor sin liquidar" : "labores sin liquidar"}`,
      to: "/labores",
    },
    {
      label: `Kilos de la semana del ${formatMonday(monday)}`,
      // SAME REQUEST as the tile above. When `/v1/work-records` fails, the
      // money tile said "—" and this one said "0 kg" — out of the identical
      // failure, side by side on one screen.
      value: recordsLoading ? (
        <Loading />
      ) : recordsError ? (
        <Unknown />
      ) : (
        <Typography variant="h1" sx={{ fontSize: "1.9rem" }}>
          {formatQuantity(kgThisWeek)} kg
        </Typography>
      ),
      hint: recordsLoading
        ? "consultando…"
        : recordsError
          ? "no se pudo consultar"
          : "solo actividades pagadas por kilo",
      to: "/labores",
    },
    {
      label: `${PLOT.Many} activos`,
      // "0 lotes activos" is a statement about a farm, and a farm with no
      // lots does not exist. `plots?.length ?? 0` made it out of a failed GET.
      value: plotsLoading ? (
        <Loading />
      ) : plotsError ? (
        <Unknown />
      ) : (
        <Typography variant="h1" sx={{ fontSize: "1.9rem" }}>
          {plots?.length ?? 0}
        </Typography>
      ),
      hint: plotsLoading
        ? "consultando…"
        : plotsError
        ? "no se pudo consultar"
        : `${formatArea(totalHa)} ha declaradas` +
          (undeclaredPlots > 0 ? ` · ${undeclaredPlots} sin declarar` : ""),
      to: PLOT.path,
    },
  ];

  return (
    <Box>
      <Typography variant="h1" gutterBottom>
        {user?.farm?.name}
      </Typography>
      <Typography color="text.secondary" sx={{ mb: 3 }}>
        Buenos días, {user?.name?.split(" ")[0]}.
      </Typography>

      <Grid container spacing={2.5}>
        {tiles.map((t) => (
          <Grid size={{ xs: 12, sm: 6, lg: 3 }} key={t.label}>
            <Card
              onClick={() => navigate(t.to)}
              sx={{ cursor: "pointer", height: "100%", "&:hover": { borderColor: "primary.main" } }}
            >
              <CardContent>
                <Typography variant="overline" color="text.secondary" sx={{ display: "block", minHeight: 32 }}>
                  {t.label}
                </Typography>
                {t.value}
                <Typography variant="caption" color="text.secondary" component="div" sx={{ mt: 0.5 }}>
                  {t.hint}
                </Typography>
              </CardContent>
            </Card>
          </Grid>
        ))}
      </Grid>

      <Card sx={{ mt: 3 }}>
        <CardContent>
          <Typography variant="h3" gutterBottom>
            Qué hacer ahora
          </Typography>
          <Stack direction={{ xs: "column", sm: "row" }} spacing={2} sx={{ mt: 2 }} flexWrap="wrap" useFlexGap>
            {can("config.prices") && (
              <Button variant="contained" startIcon={<PriceChangeIcon />} onClick={() => navigate("/precio-semana")}>
                Fijar precio del kilo
              </Button>
            )}
            {can("money.pay") && (
              <Button variant="contained" startIcon={<PaymentsIcon />} onClick={() => navigate("/nomina")}>
                Pagar nómina
              </Button>
            )}
            <Button variant="outlined" startIcon={<FactCheckIcon />} onClick={() => navigate("/labores/nueva")}>
              Registrar labor
            </Button>
            <Button variant="outlined" startIcon={<GroupsIcon />} onClick={() => navigate("/empleados/nuevo")}>
              Nuevo empleado
            </Button>
            <Button variant="outlined" startIcon={<TerrainIcon />} onClick={() => navigate(`${PLOT.path}/nuevo`)}>
              Nuevo {PLOT.one}
            </Button>
          </Stack>
        </CardContent>
      </Card>
    </Box>
  );
}
