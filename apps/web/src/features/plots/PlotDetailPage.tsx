import { useNavigate, useParams } from "react-router-dom";
import {
  Alert, Box, Button, Card, CardContent, Chip, Grid, Stack,
  Table, TableBody, TableCell, TableHead, TableRow, Typography,
} from "@mui/material";
import ArrowBackIcon from "@mui/icons-material/ArrowBack";
import EditIcon from "@mui/icons-material/Edit";
import MapIcon from "@mui/icons-material/Map";
import { pointOf, openInMaps, formatPoint } from "./PlotLocationField";
import { useAsync } from "../../lib/useAsync";
import { api } from "../../api/endpoints";
import { useAuth } from "../../auth/AuthContext";
import { Value } from "../harvest/Figures";
import { totalsOfRecords } from "../harvest/totals";
import { formatDate, formatDateRange } from "../../lib/dates";
import { PermissionDenied } from "../../components/Guards";
import { formatArea } from "../../lib/money";
import { PLOT } from "../../lib/vocab";

export function PlotDetailPage() {
  const { id = "" } = useParams();
  const navigate = useNavigate();
  const { can } = useAuth();
  const showMoney = can("money.read");
  const { data: plot, error, denied } = useAsync(() => api.getPlot(id), [id]);
  const { data: records } = useAsync(() => api.listWorkRecords({ plotId: id }), [id]);
  // The other lots, only so the map has context to draw behind this one.

  if (denied) return <PermissionDenied moduleName="ver este lote" />;
  if (error) return <Alert severity="error">{error}</Alert>;
  if (!plot) return null;

  const location = pointOf(plot.location);

  return (
    <Box>
      <Button
        startIcon={<ArrowBackIcon />}
        onClick={() => navigate(PLOT.path)}
        color="inherit"
        sx={{ mb: 1 }}
      >
        {PLOT.Many}
      </Button>

      <Stack
        direction={{ xs: "column", sm: "row" }}
        justifyContent="space-between"
        alignItems={{ sm: "center" }}
        spacing={2}
        sx={{ mb: 3 }}
      >
        <Box>
          <Stack direction="row" spacing={1} alignItems="center">
            <Typography variant="h1">{plot.name}</Typography>
            {plot.status === "inactive" && <Chip size="small" label="Inactiva" />}
          </Stack>
          <Typography color="text.secondary">
            {plot.department} · {plot.municipality}
          </Typography>
        </Box>
        {can("plots.write") && (
          <Button
            variant="outlined"
            startIcon={<EditIcon />}
            onClick={() => navigate(`${PLOT.path}/${plot.id}/editar`)}
          >
            Editar
          </Button>
        )}
      </Stack>

      <Grid container spacing={3}>
        <Grid size={{ xs: 12, md: 7 }}>
          <Card sx={{ mb: 3 }}>
            <CardContent>
              <Typography variant="overline" color="text.secondary">
                Superficie
              </Typography>
              <Box sx={{ mt: 1 }}>
                <Typography variant="h2">
                  {plot.areaHa === null ? "—" : `${formatArea(plot.areaHa)} ha`}
                </Typography>
              </Box>
              {plot.areaHa === null && can("plots.write") && (
                <Alert severity="info" sx={{ mt: 2 }}>
                  Nadie ha declarado cuántas hectáreas tiene este lote.
                </Alert>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardContent>
              <Typography variant="h3" gutterBottom>
                Cultivos
              </Typography>
              <Table size="small">
                <TableHead>
                  <TableRow>
                    <TableCell>Tipo</TableCell>
                    <TableCell>Variedad</TableCell>
                    <TableCell align="right">Área</TableCell>
                    <TableCell>Siembra</TableCell>
                  </TableRow>
                </TableHead>
                <TableBody>
                  {plot.crops.map((c) => (
                    <TableRow key={c.id}>
                      <TableCell>{c.cropTypeName}</TableCell>
                      <TableCell>{c.varietyName ?? "—"}</TableCell>
                      <TableCell align="right">
                        {c.areaHa === null ? "—" : `${formatArea(c.areaHa)} ha`}
                      </TableCell>
                      <TableCell>{c.plantedAt ? formatDate(c.plantedAt) : "—"}</TableCell>
                    </TableRow>
                  ))}
                  {plot.crops.length === 0 && (
                    <TableRow>
                      <TableCell colSpan={4} sx={{ color: "text.secondary" }}>
                        Este lote no tiene cultivos registrados.
                      </TableCell>
                    </TableRow>
                  )}
                </TableBody>
              </Table>
            </CardContent>
          </Card>
        </Grid>

        <Grid size={{ xs: 12, md: 5 }}>
          <Card>
            <CardContent>
              <Stack
                direction="row"
                justifyContent="space-between"
                alignItems="center"
                sx={{ mb: 1.5 }}
              >
                <Typography variant="h3">Dónde queda</Typography>
                {can("plots.write") && (
                  <Button
                    size="small"
                    startIcon={<MapIcon />}
                    onClick={() => navigate(`${PLOT.path}/${plot.id}/editar`)}
                  >
                    {location ? "Volver a marcar" : "Marcar el punto"}
                  </Button>
                )}
              </Stack>
              {location ? (
                <Stack spacing={1} alignItems="flex-start">
                  <Typography variant="body2">
                    Punto guardado: <strong>{formatPoint(location)}</strong>
                  </Typography>
                  <Button
                    variant="outlined"
                    startIcon={<MapIcon />}
                    href={openInMaps(location)}
                    target="_blank"
                    rel="noopener"
                  >
                    Ver en el mapa
                  </Button>
                </Stack>
              ) : (
                <Typography color="text.secondary" variant="body2">
                  Nadie ha marcado dónde queda este lote. Estando parado en él, ábralo
                  desde el celular y toque «Marcar el punto».
                </Typography>
              )}
            </CardContent>
          </Card>

          <Card sx={{ mt: 3 }}>
            <CardContent>
              <Typography variant="h3" gutterBottom>
                Últimas labores
              </Typography>
              {(records ?? []).slice(0, 6).map((r) => (
                <Stack
                  key={r.id}
                  direction="row"
                  justifyContent="space-between"
                  sx={{ py: 1, borderBottom: 1, borderColor: "divider" }}
                >
                  <Box>
                    <Typography variant="body2" sx={{ fontWeight: 600 }}>
                      {r.activityName}
                    </Typography>
                    <Typography variant="caption" color="text.secondary">
                      {r.workerName} · {formatDateRange(r.dateFrom, r.dateTo)}
                    </Typography>
                  </Box>
                  {/* ── THE HOLE THE WEIGHER GOT THE PRICE THROUGH ──────
                      `WorkRecordsPage` gates this exact column behind
                      `money.read`; this one did not. The server sends the
                      amount on a weigher's own rows — it is his work — and
                      strips the price per kilo from `/v1/farm` and
                      `/v1/activities` for that role. But an amount and a
                      quantity on the same line is a division: $32.000 over
                      40 kg is $800 a kilo, and the whole projection comes
                      apart. So the amount goes where the price goes. */}
                  {showMoney && <Value total={totalsOfRecords([r])} variant="small" />}
                </Stack>
              ))}
              {records !== null && records.length === 0 && (
                <Typography color="text.secondary" variant="body2">
                  Todavía no hay labores registradas sobre este lote.
                </Typography>
              )}
            </CardContent>
          </Card>
        </Grid>
      </Grid>
    </Box>
  );
}
