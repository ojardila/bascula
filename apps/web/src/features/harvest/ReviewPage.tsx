/**
 * Weighings worth a second look.
 *
 * WHAT THIS SCREEN IS NOT. It is not a fraud detector and it must never read
 * like one. Every finding here has an innocent explanation that is likelier
 * than the guilty one — a scale read twice, a key pressed twice, a phone with
 * the wrong date, a crew's sack booked to one person. So each row leads with
 * the REASON, as a sentence carrying the numbers it was measured against, and
 * the page states the rules before it lists anything. A person whose name
 * appears here is entitled to see the arithmetic that put it there.
 *
 * The server sends `rule` and `reference`; the sentence is written in
 * `text.ts`. That split is deliberate: `outlier` is a category, not a reason,
 * and a farm reading it would still have to reconstruct what "por encima" was
 * measured against and by how much.
 *
 * `reference` is NULL for `future` — the contract is explicit that a 0 there
 * would read as "compared against nothing" — so every sentence that uses it
 * checks it first.
 *
 * CORRECTING IS NOT DONE HERE. On the web a fix is an edit to a work record,
 * and `PATCH /v1/work-records/{id}` is `workRecords.admin` and refuses a
 * record already inside a live settlement. Rather than build a half-editor
 * that discovers that at the last step, each row points at Labores.
 */
import { Link as RouterLink } from "react-router-dom";
import {
  Alert, Box, Card, CardContent, Chip, CircularProgress, Divider, Stack, Typography,
} from "@mui/material";
import CheckCircleOutlineIcon from "@mui/icons-material/CheckCircleOutline";
import ScaleIcon from "@mui/icons-material/Scale";
import { useAsync } from "../../lib/useAsync";
import { PermissionDenied } from "../../components/Guards";
import { reportAnomalies } from "../../api/harvest";
import { formatDate } from "../../lib/dates";
import { formatQuantity } from "../../lib/money";
import { moneyFont } from "../../theme";
import { useHarvest } from "./HarvestLayout";
import { anomalyHeadline, anomalyReason } from "./text";

/** The rules, said once, in the farm's words, before anything is listed. */
const RULES: { key: string; title: string; body: string }[] = [
  {
    key: "impossible",
    title: "Pesos imposibles",
    body: "Una pesada por encima de lo que una persona alcanza a cargar en un día, o registrada en cero.",
  },
  {
    key: "duplicate",
    title: "Doble registro",
    body: "La misma persona, el mismo cultivo y la misma cantidad, guardados con menos de tres minutos de diferencia.",
  },
  {
    key: "digit",
    title: "Un cero de más",
    body: "Una pesada muy por encima de lo que esa persona suele pesar. La referencia se calcula sin contar la pesada sospechosa: incluirla haría que la regla no pudiera dispararse nunca.",
  },
  {
    key: "outlier",
    title: "Muy por encima de la cuadrilla",
    body: "Muy por encima de lo que hicieron los demás en ese cultivo ese día.",
  },
  {
    key: "future",
    title: "Fecha futura",
    body: "Una pesada fechada después de hoy, en el calendario de la finca.",
  },
];

export function ReviewPage() {
  const { days } = useHarvest();
  const { data, error, denied } = useAsync(() => reportAnomalies({ days }), [days]);

  if (denied) return <PermissionDenied moduleName="ver la cosecha" />;

  return (
    <Stack spacing={3}>
      {error && (
        <Alert severity="error">
          No se pudieron consultar las pesadas: {error}. Esto no quiere decir que no
          haya ninguna por revisar — quiere decir que no se pudo mirar.
        </Alert>
      )}

      {!data && !error && (
        <Stack alignItems="center" sx={{ py: 6 }}>
          <CircularProgress />
        </Stack>
      )}

      {data && data.items.length === 0 && (
        <Alert severity="success" icon={<CheckCircleOutlineIcon />}>
          Ninguna pesada del periodo levanta sospecha con estas cinco reglas. Eso no
          garantiza que todas sean exactas — solo que ninguna se sale de lo que estas
          reglas pueden ver.
        </Alert>
      )}

      {data && data.items.length > 0 && (
        <>
          <Alert severity="warning">
            {data.items.length}{" "}
            {data.items.length === 1 ? "pesada merece" : "pesadas merecen"} una segunda
            mirada.
            {data.items.length >= data.limit &&
              ` Se muestran las ${data.limit} primeras; puede haber más.`}
          </Alert>

          <Stack spacing={1.5}>
            {data.items.map((a) => (
              <Card key={a.recordId}>
                <CardContent sx={{ py: 2 }}>
                  <Stack
                    direction={{ xs: "column", sm: "row" }}
                    spacing={2}
                    justifyContent="space-between"
                    alignItems={{ sm: "flex-start" }}
                  >
                    <Box sx={{ flex: 1, minWidth: 0 }}>
                      <Stack direction="row" spacing={1} alignItems="center" sx={{ mb: 0.5, flexWrap: "wrap" }}>
                        <ScaleIcon fontSize="small" sx={{ color: "warning.dark" }} />
                        <Typography sx={{ fontWeight: 700 }}>{a.worker}</Typography>
                        <Chip size="small" color="warning" variant="outlined" label={anomalyHeadline(a)} />
                      </Stack>
                      {/* The reason, as a sentence with the numbers in it —
                          not a code the reader has to look up. */}
                      <Typography variant="body2">{anomalyReason(a)}</Typography>
                      <Typography variant="caption" color="text.secondary" sx={{ display: "block", mt: 0.75 }}>
                        {formatDate(a.date)}
                        {a.crop ? ` · ${a.crop}` : " · sin cultivo asignado"}
                      </Typography>
                    </Box>

                    <Stack alignItems="flex-end" spacing={0.5}>
                      <Box sx={{ ...moneyFont, fontWeight: 700, whiteSpace: "nowrap" }}>
                        {formatQuantity(a.quantity)}
                        <Box component="span" sx={{ color: "text.secondary", fontWeight: 500 }}>
                          {" "}
                          kg
                        </Box>
                      </Box>
                      <Typography
                        variant="caption"
                        component={RouterLink}
                        to="/labores"
                        sx={{ color: "primary.main" }}
                      >
                        Ver en Labores
                      </Typography>
                    </Stack>
                  </Stack>
                </CardContent>
              </Card>
            ))}
          </Stack>

          <Divider />
          <Typography variant="caption" color="text.secondary">
            Una pesada que rompe más de una regla aparece una sola vez, bajo la regla
            de la que estamos más seguros.
          </Typography>
        </>
      )}

      <Card sx={{ bgcolor: "#f6f9f4" }}>
        <CardContent>
          <Typography variant="h3" gutterBottom>
            Cómo se decide
          </Typography>
          <Typography variant="body2" sx={{ mb: 2 }}>
            Cinco reglas simples. Ninguna acusa a nadie: casi siempre es un peso
            guardado dos veces, una báscula mal leída o la fecha del teléfono.
          </Typography>
          <Stack spacing={1}>
            {RULES.map((r) => (
              <Box key={r.key}>
                <Typography variant="body2" sx={{ fontWeight: 700, display: "inline" }}>
                  {r.title}.{" "}
                </Typography>
                <Typography variant="body2" sx={{ display: "inline", color: "text.secondary" }}>
                  {r.body}
                </Typography>
              </Box>
            ))}
          </Stack>
          {data && (
            <Typography variant="caption" color="text.secondary" sx={{ mt: 2, display: "block" }}>
              Revisando desde el {formatDate(data.since)} ({data.days} días). El tope de
              «peso imposible» está en {formatQuantity(data.maxKg)} kg.
            </Typography>
          )}
        </CardContent>
      </Card>
    </Stack>
  );
}
