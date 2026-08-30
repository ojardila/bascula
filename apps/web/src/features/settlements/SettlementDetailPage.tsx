/**
 * ONE LIQUIDACIÓN, LINE BY LINE.
 *
 * `docs/diagramas/web.md` §SG_liq calls this "liquidación · líneas congeladas",
 * and *congeladas* is the whole point: these rows carry the price they were
 * settled at, not the price the activity has today. Reading a settlement three
 * weeks later and getting today's prices back would make the document useless
 * for the argument it exists to settle.
 *
 * TWO THINGS THIS SCREEN IS CAREFUL ABOUT.
 *
 * ANULAR IS NOT A CASUAL BUTTON. `docs/sincronizacion.md` is explicit: "Anular
 * la liquidación no es un botón de esa pantalla: es una decisión del
 * administrador". So it sits apart from the document, under its own heading,
 * behind a confirmation that states the consequence in the words the domain
 * uses — and `docs/diagramas/movil.md` supplies the sentence the confirmation
 * has to say: "No hay void -> open. Anular es definitivo."
 *
 * A VOID SETTLEMENT STILL SHOWS EVERYTHING. It is not hidden and it is not
 * emptied. Somebody was handed a printout of it; they need to be able to look
 * the same document up and find it marked cancelled, with the date.
 */
import { useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import {
  Alert, Box, Button, Card, CardContent, Chip, Divider, Grid, Stack, Table, TableBody,
  TableCell, TableHead, TableRow, Typography,
} from "@mui/material";
import ArrowBackIcon from "@mui/icons-material/ArrowBack";
import PrintIcon from "@mui/icons-material/Print";
import BlockIcon from "@mui/icons-material/Block";
import { Money } from "../../components/Money";
import { ConfirmDialog } from "../../components/ConfirmDialog";
import { PermissionDenied } from "../../components/Guards";
import { useAsync } from "../../lib/useAsync";
import { useAuth } from "../../auth/AuthContext";
import { api } from "../../api/endpoints";
import { messageFor } from "../../api/errors";
import { formatDate, formatDateRange, formatWeekRange, todayInFarm } from "../../lib/dates";
import { formatQuantity } from "../../lib/money";
import { settlementHtml } from "../documents/documents";
import { printDocument } from "../documents/print";
import { useWriteOnce } from "../../lib/writeOnce";
import { CORRECCION_GLOSS, PROVISIONAL } from "../../lib/vocab";

export function SettlementDetailPage() {
  const { id = "" } = useParams();
  const navigate = useNavigate();
  const { user, can } = useAuth();

  const { data, error, denied, reload } = useAsync(() => api.getSettlement(id), [id]);
  const [confirming, setConfirming] = useState(false);
  const { busy, run: runOnce } = useWriteOnce();
  const [actionError, setActionError] = useState<string | null>(null);

  if (denied) return <PermissionDenied moduleName="ver una liquidación" />;
  if (error) return <Alert severity="error">{error}</Alert>;
  if (!data) return null;

  const isVoid = data.status === "void";
  const provisional = data.lines.filter((l) => l.rateSource === "weekly_price");
  const weighed = data.lines.reduce((a, l) => a + (l.unitLabel ? l.quantity : 0), 0);
  const unit = data.lines.find((l) => l.unitLabel)?.unitLabel ?? null;

  async function voidIt() {
    // The reversal carries its own id, and it used to be minted inside the
    // call — so a double click on "Sí, anular" sent two different reversal
    // ids for one settlement. See `lib/writeOnce.ts`.
    const outcome = await runOnce(`anular|${id}`, async (mint) => {
      setActionError(null);
      return api.voidSettlement(id, mint());
    }).catch((e: unknown) => {
      setActionError(messageFor(e));
      return { ran: false } as const;
    });
    if (!outcome.ran) return;
    setConfirming(false);
    reload();
  }

  function print() {
    printDocument(
      settlementHtml({
        farmName: user?.farm.name ?? "Finca",
        settlement: data!,
        printedOn: todayInFarm(user?.farm.timezone ?? "America/Bogota"),
      }),
    );
  }

  return (
    <Box>
      <Button
        startIcon={<ArrowBackIcon />}
        onClick={() => navigate("/liquidaciones")}
        color="inherit"
        sx={{ mb: 1 }}
      >
        Liquidaciones
      </Button>

      <Stack
        direction={{ xs: "column", sm: "row" }}
        justifyContent="space-between"
        alignItems={{ sm: "flex-start" }}
        spacing={2}
        sx={{ mb: 2 }}
      >
        <Box>
          <Typography variant="h1">Liquidación de {data.workerName}</Typography>
          <Typography color="text.secondary">
            {formatWeekRange(data.periodStart)} · registrada el{" "}
            {formatDate(data.createdAt.slice(0, 10))}
          </Typography>
        </Box>
        <Button startIcon={<PrintIcon />} variant="outlined" onClick={print}>
          Imprimir
        </Button>
      </Stack>

      {actionError && (
        <Alert severity="error" sx={{ mb: 2 }} onClose={() => setActionError(null)}>
          {actionError}
        </Alert>
      )}

      {isVoid && (
        <Alert severity="error" variant="outlined" sx={{ mb: 3 }}>
          <strong>Liquidación anulada</strong>
          {data.voidedAt ? ` el ${formatDate(data.voidedAt.slice(0, 10))}` : ""}. Las labores
          volvieron a quedar pendientes y lo que se había ganado se canceló con una
          corrección en el libro. El documento se conserva: no es un comprobante de pago.
        </Alert>
      )}

      <Grid container spacing={2} sx={{ mb: 3 }}>
        <Grid size={{ xs: 12, sm: 4 }}>
          <Card variant="outlined">
            <CardContent>
              <Typography variant="overline" color="text.secondary">
                Bruto liquidado
              </Typography>
              <Money cents={data.grossCents} variant="big" />
            </CardContent>
          </Card>
        </Grid>
        <Grid size={{ xs: 6, sm: 4 }}>
          <Card variant="outlined">
            <CardContent>
              <Typography variant="overline" color="text.secondary">
                Líneas congeladas
              </Typography>
              <Typography variant="h2">{data.lines.length}</Typography>
            </CardContent>
          </Card>
        </Grid>
        <Grid size={{ xs: 6, sm: 4 }}>
          <Card variant="outlined">
            <CardContent>
              <Typography variant="overline" color="text.secondary">
                {unit ?? "Cantidad"}
              </Typography>
              {/* No unit means nothing here is weighed — a contract or a day
                  wage. "—" says that; a "0 kg" would say the picker weighed
                  nothing, which is a different claim. */}
              <Typography variant="h2">{unit ? formatQuantity(weighed) : "—"}</Typography>
            </CardContent>
          </Card>
        </Grid>
      </Grid>

      <Card sx={{ mb: 3 }}>
        <CardContent>
          <Typography variant="h3" gutterBottom>
            Qué se liquidó
          </Typography>
          <Typography color="text.secondary" variant="body2" sx={{ mb: 1 }}>
            Cada línea guarda el precio al que se liquidó, no el precio de hoy.
          </Typography>
          <Table size="small">
            <TableHead>
              <TableRow>
                <TableCell>Fecha</TableCell>
                <TableCell>Semana</TableCell>
                <TableCell>Actividad</TableCell>
                <TableCell align="right">Cantidad</TableCell>
                <TableCell align="right">Precio</TableCell>
                <TableCell align="right">Valor</TableCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {data.lines.map((l) => (
                <TableRow
                  key={l.id}
                  sx={{
                    opacity: data.voidedLineIds.includes(l.id) ? 0.5 : 1,
                    textDecoration: data.voidedLineIds.includes(l.id) ? "line-through" : "none",
                  }}
                >
                  <TableCell>{formatDateRange(l.dateFrom, l.dateTo)}</TableCell>
                  <TableCell>{formatWeekRange(l.weekStart)}</TableCell>
                  <TableCell sx={{ fontWeight: 600 }}>
                    {l.activityName}
                    {l.rateSource === "weekly_price" && (
                      <Chip
                        size="small"
                        color="warning"
                        variant="outlined"
                        label={PROVISIONAL}
                        sx={{ ml: 1, height: 20, fontSize: "0.68rem" }}
                      />
                    )}
                  </TableCell>
                  <TableCell align="right">
                    {l.unitLabel ? `${formatQuantity(l.quantity)} ${l.unitLabel}` : "contrato"}
                  </TableCell>
                  <TableCell align="right">
                    <Money cents={l.rateCents} variant="small" />
                  </TableCell>
                  <TableCell align="right">
                    <Money cents={l.amountCents} variant="small" />
                  </TableCell>
                </TableRow>
              ))}
              {data.lines.length === 0 && (
                <TableRow>
                  <TableCell colSpan={6} sx={{ color: "text.secondary" }}>
                    El servidor no devolvió las líneas de esta liquidación.
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>

          {provisional.length > 0 && (
            <Alert severity="warning" variant="outlined" sx={{ mt: 2 }}>
              {provisional.length === 1 ? "Una línea se pagó" : `${provisional.length} líneas se pagaron`}{" "}
              al precio de la semana. Ese precio quedó congelado aquí al liquidar: si
              después cambió, esta liquidación no cambia.
            </Alert>
          )}

          {data.note && (
            <>
              <Divider sx={{ my: 2 }} />
              <Typography variant="overline" color="text.secondary">
                Nota
              </Typography>
              <Typography>{data.note}</Typography>
            </>
          )}
        </CardContent>
      </Card>

      <Stack direction="row" spacing={2}>
        <Button variant="outlined" onClick={() => navigate(`/empleados/${data.workerId}`)}>
          Ver el perfil de {data.workerName}
        </Button>
      </Stack>

      {/* Anular. Apart from the document, under its own heading, and only for
          somebody who may: `settlements.void` is owner+admin server-side and
          `money.pay` is the matching action on this side. */}
      {!isVoid && can("money.pay") && (
        <Card variant="outlined" sx={{ mt: 4, borderColor: "error.light" }}>
          <CardContent>
            <Typography variant="h3" gutterBottom>
              Anular esta liquidación
            </Typography>
            <Typography color="text.secondary" sx={{ mb: 2 }}>
              Anular suelta las labores para que puedan volver a liquidarse y cancela lo
              que se había ganado con {CORRECCION_GLOSS} No borra nada y{" "}
              <strong>no se puede deshacer</strong>: una liquidación anulada no vuelve a
              quedar vigente.
            </Typography>
            <Button
              color="error"
              variant="outlined"
              startIcon={<BlockIcon />}
              onClick={() => setConfirming(true)}
            >
              Anular la liquidación
            </Button>
          </CardContent>
        </Card>
      )}

      <ConfirmDialog
        open={confirming}
        title="¿Anular la liquidación?"
        body={
          `Se van a soltar ${data.lines.length} ` +
          `${data.lines.length === 1 ? "labor" : "labores"} y se va a cancelar lo que ` +
          `${data.workerName} había ganado, con ${CORRECCION_GLOSS} Anular es ` +
          `definitivo: una liquidación anulada nunca vuelve a quedar vigente.`
        }
        confirmLabel="Sí, anular"
        busy={busy}
        destructive
        onCancel={() => setConfirming(false)}
        onConfirm={voidIt}
      />
    </Box>
  );
}
