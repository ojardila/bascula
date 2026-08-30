import { useNavigate, useParams } from "react-router-dom";
import {
  Alert, Box, Button, Card, CardContent, Chip, Grid, Stack,
  Table, TableBody, TableCell, TableHead, TableRow, Typography,
} from "@mui/material";
import ArrowBackIcon from "@mui/icons-material/ArrowBack";
import EditIcon from "@mui/icons-material/Edit";
import MapIcon from "@mui/icons-material/Map";
import { PlotBoundaryEditor, type MapNeighbour } from "./PlotBoundaryEditor";
import { AreaComparison } from "./AreaComparison";
import { useAsync } from "../../lib/useAsync";
import { api } from "../../api/endpoints";
import { useAuth } from "../../auth/AuthContext";
import { Value } from "../harvest/Figures";
import { totalsOfRecords } from "../harvest/totals";
import { formatDate, formatDateRange } from "../../lib/dates";
import { PermissionDenied } from "../../components/Guards";
import { formatArea } from "../../lib/money";
import { asGeometry } from "../../lib/geo";
import { LOTE } from "../../lib/vocab";

export function PlotDetailPage() {
  const { id = "" } = useParams();
  const navigate = useNavigate();
  const { can } = useAuth();
  const showMoney = can("money.read");
  const { data: plot, error, denied } = useAsync(() => api.getPlot(id), [id]);
  const { data: records } = useAsync(() => api.listWorkRecords({ plotId: id }), [id]);
  // The other lots, only so the map has context to draw behind this one.
  const { data: siblings } = useAsync(() => api.listPlots({ status: "active" }), [id]);

  if (denied) return <PermissionDenied moduleName="ver este lote" />;
  if (error) return <Alert severity="error">{error}</Alert>;
  if (!plot) return null;

  const boundary = asGeometry(plot.boundary);
  const neighbours: MapNeighbour[] = (siblings ?? []).flatMap((p) => {
    if (p.id === plot.id) return [];
    const g = asGeometry(p.boundary);
    return g ? [{ id: p.id, name: p.name, boundary: g }] : [];
  });

  return (
    <Box>
      <Button
        startIcon={<ArrowBackIcon />}
        onClick={() => navigate(LOTE.path)}
        color="inherit"
        sx={{ mb: 1 }}
      >
        {LOTE.Many}
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
            onClick={() => navigate(`${LOTE.path}/${plot.id}/editar`)}
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
                <AreaComparison declaredHa={plot.areaHa} computedHa={plot.computedAreaHa} />
              </Box>
              {plot.computedAreaHa === null && can("plots.write") && (
                <Alert severity="info" sx={{ mt: 2 }}>
                  Todavía no hay polígono dibujado, así que solo hay una cifra. Dibújelo en
                  el mapa y el sistema mide las hectáreas por su cuenta.
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
                <Typography variant="h3">Mapa</Typography>
                {can("plots.write") && (
                  <Button
                    size="small"
                    startIcon={<MapIcon />}
                    onClick={() => navigate(`${LOTE.path}/${plot.id}/mapa`)}
                  >
                    {boundary ? "Editar el polígono" : "Dibujar el polígono"}
                  </Button>
                )}
              </Stack>
              {boundary ? (
                <PlotBoundaryEditor
                  plotId={plot.id}
                  initialBoundary={plot.boundary}
                  neighbours={neighbours}
                  declaredAreaHa={plot.areaHa}
                  readOnly
                  height={240}
                />
              ) : (
                <Typography color="text.secondary" variant="body2">
                  Este lote todavía no tiene su contorno dibujado. Mientras no lo tenga,
                  la única superficie que existe es la que usted declaró.
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
