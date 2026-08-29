import { useNavigate, useParams } from "react-router-dom";
import {
  Alert, Box, Button, Card, CardContent, Chip, Divider, Grid, Stack,
  Table, TableBody, TableCell, TableHead, TableRow, Typography,
} from "@mui/material";
import ArrowBackIcon from "@mui/icons-material/ArrowBack";
import EditIcon from "@mui/icons-material/Edit";
import { MapPanelPlaceholder } from "./MapPanelPlaceholder";
import { useAsync } from "../../lib/useAsync";
import { api } from "../../api/endpoints";
import { useAuth } from "../../auth/AuthContext";
import { formatArea } from "../../lib/money";
import { Money } from "../../components/Money";
import { formatDate, formatDateRange } from "../../lib/dates";
import { PermissionDenied } from "../../components/Guards";

export function PlotDetailPage() {
  const { id = "" } = useParams();
  const navigate = useNavigate();
  const { can } = useAuth();
  const { data: plot, error, denied } = useAsync(() => api.getPlot(id), [id]);
  const { data: records } = useAsync(() => api.listWorkRecords({ plotId: id }), [id]);

  if (denied) return <PermissionDenied moduleName="ver esta parcela" />;
  if (error) return <Alert severity="error">{error}</Alert>;
  if (!plot) return null;

  const diff =
    plot.computedAreaHa !== null && plot.areaHa > 0
      ? Math.round(((plot.areaHa - plot.computedAreaHa) / plot.areaHa) * 100)
      : null;

  return (
    <Box>
      <Button
        startIcon={<ArrowBackIcon />}
        onClick={() => navigate("/parcelas")}
        color="inherit"
        sx={{ mb: 1 }}
      >
        Parcelas
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
            onClick={() => navigate(`/parcelas/${plot.id}/editar`)}
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
              <Stack direction="row" spacing={4} sx={{ mt: 1 }}>
                <Box>
                  <Typography variant="h2">{formatArea(plot.areaHa)} ha</Typography>
                  <Typography variant="caption" color="text.secondary">
                    declarada
                  </Typography>
                </Box>
                <Divider orientation="vertical" flexItem />
                <Box>
                  <Typography variant="h2" color={plot.computedAreaHa === null ? "text.disabled" : undefined}>
                    {plot.computedAreaHa === null ? "—" : `${formatArea(plot.computedAreaHa)} ha`}
                  </Typography>
                  <Typography variant="caption" color="text.secondary">
                    calculada del polígono
                  </Typography>
                </Box>
              </Stack>
              {diff !== null && diff !== 0 && (
                <Alert severity="warning" sx={{ mt: 2 }}>
                  Las dos cifras difieren un {Math.abs(diff)}%. Ninguna de las dos es
                  «la buena» por sí sola: la declarada es la suya, la calculada sale
                  del polígono dibujado.
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
                        Esta parcela no tiene cultivos registrados.
                      </TableCell>
                    </TableRow>
                  )}
                </TableBody>
              </Table>
            </CardContent>
          </Card>
        </Grid>

        <Grid size={{ xs: 12, md: 5 }}>
          <MapPanelPlaceholder height={280} />

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
                  <Money cents={r.estimatedAmountCents} variant="small" />
                </Stack>
              ))}
              {records !== null && records.length === 0 && (
                <Typography color="text.secondary" variant="body2">
                  Todavía no hay labores registradas sobre esta parcela.
                </Typography>
              )}
            </CardContent>
          </Card>
        </Grid>
      </Grid>
    </Box>
  );
}
