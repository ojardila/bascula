import { useNavigate } from "react-router-dom";
import {
  Box, Button, Card, CardContent, Grid, Stack, Typography,
} from "@mui/material";
import TerrainIcon from "@mui/icons-material/Terrain";
import GroupsIcon from "@mui/icons-material/Groups";
import FactCheckIcon from "@mui/icons-material/FactCheck";
import { Money } from "../../components/Money";
import { useAsync } from "../../lib/useAsync";
import { api } from "../../api/endpoints";
import { useAuth } from "../../auth/AuthContext";
import { formatArea, formatQuantity } from "../../lib/money";
import { mondayOf, todayInFarm, formatMonday } from "../../lib/dates";

/**
 * The farm at a glance. Deliberately four figures and not twelve: the useful
 * dashboard is the one somebody actually reads on the way to doing something,
 * so every tile is also a door.
 */
/**
 * What a money tile shows when the figure could not be fetched.
 *
 * Not "$0". A zero is a number a farm can genuinely owe, so printing it for
 * "we do not know" makes a failed request indistinguishable from being square
 * with everybody — which is the one mistake this screen must not make.
 */
function Unknown() {
  return (
    <Typography variant="h1" sx={{ fontSize: "1.9rem", color: "text.disabled" }}>
      —
    </Typography>
  );
}

export function DashboardPage() {
  const navigate = useNavigate();
  const { user } = useAuth();
  const timezone = user?.farm?.timezone ?? "America/Bogota";
  const monday = mondayOf(todayInFarm(timezone));

  const { data: plots } = useAsync(() => api.listPlots({ status: "active" }), []);
  const { data: records, error: recordsError } = useAsync(
    () => api.listWorkRecords({ status: "active" }),
    [],
  );
  // The farm's position comes from /v1/balances, which derives it from the
  // ledger. Adding up a `balanceCents` on the worker list is what this used to
  // do, and that endpoint has never sent one — so the tile read $0 for a farm
  // that was owing a week of picking, with no sign anything was missing.
  const { data: balances, error: balancesError } = useAsync(() => api.listBalances(), []);

  const owed = (balances ?? []).reduce((a, b) => a + Math.max(0, b.balanceCents), 0);
  const pending = (records ?? []).filter((r) => !r.settled);
  const pendingCents = pending.reduce((a, r) => a + r.estimatedAmountCents, 0);
  const kgThisWeek = (records ?? [])
    .filter((r) => r.unitLabel === "kg" && mondayOf(r.dateFrom) === monday)
    .reduce((a, r) => a + r.quantity, 0);
  const totalHa = (plots ?? []).reduce((a, p) => a + p.areaHa, 0);

  const tiles = [
    {
      label: "Pendiente de pago a los empleados",
      value: balancesError ? <Unknown /> : <Money cents={owed} variant="big" />,
      hint: balancesError ? "no se pudo consultar" : "derivado del libro, no un total guardado",
      to: "/empleados",
    },
    {
      label: "Pendiente de liquidar",
      value: recordsError ? <Unknown /> : <Money cents={pendingCents} variant="big" />,
      hint: recordsError ? "no se pudo consultar" : `${pending.length} labores sin liquidar`,
      to: "/labores",
    },
    {
      label: `Kilos de la semana del ${formatMonday(monday)}`,
      value: (
        <Typography variant="h1" sx={{ fontSize: "1.9rem" }}>
          {formatQuantity(kgThisWeek)} kg
        </Typography>
      ),
      hint: "solo actividades pagadas por kilo",
      to: "/labores",
    },
    {
      label: "Parcelas activas",
      value: (
        <Typography variant="h1" sx={{ fontSize: "1.9rem" }}>
          {plots?.length ?? 0}
        </Typography>
      ),
      hint: `${formatArea(totalHa)} ha declaradas`,
      to: "/parcelas",
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
          <Stack direction={{ xs: "column", sm: "row" }} spacing={2} sx={{ mt: 2 }}>
            <Button variant="contained" startIcon={<FactCheckIcon />} onClick={() => navigate("/labores/nueva")}>
              Registrar labor
            </Button>
            <Button variant="outlined" startIcon={<GroupsIcon />} onClick={() => navigate("/empleados/nuevo")}>
              Nuevo empleado
            </Button>
            <Button variant="outlined" startIcon={<TerrainIcon />} onClick={() => navigate("/parcelas/nueva")}>
              Nueva parcela
            </Button>
          </Stack>
        </CardContent>
      </Card>
    </Box>
  );
}
