/**
 * RSP-007. One call, four blocks: who they are, what they are owed, what they
 * did, and every peso that ever moved.
 *
 * The two figures in the top right are different things and are shown apart on
 * purpose:
 *
 *   SALDO PENDIENTE — derived from the ledger, every time this page loads.
 *                     Never a stored total; a stored total is a total that one
 *                     day disagrees with its own rows.
 *   PENDIENTE DE LIQUIDAR — work already done that has not been settled, so it
 *                     is not written in the ledger yet and is not part of
 *                     the balance.
 *
 * Merging them into one number would be friendlier and wrong: it would show
 * money as owed before the document that owes it exists.
 */
import { useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import {
  Alert, Avatar, Box, Button, Card, CardContent, Chip, Divider, Grid, Stack,
  Table, TableBody, TableCell, TableHead, TableRow, Tooltip, Typography,
} from "@mui/material";
import ArrowBackIcon from "@mui/icons-material/ArrowBack";
import PaymentsIcon from "@mui/icons-material/Payments";
import NoteAddIcon from "@mui/icons-material/NoteAdd";
import RemoveCircleOutlineIcon from "@mui/icons-material/RemoveCircleOutline";
import { Money } from "../../components/Money";
import { Value } from "../harvest/Figures";
import { totalsOfRecords } from "../harvest/totals";
import { PermissionDenied } from "../../components/Guards";
import { useAsync } from "../../lib/useAsync";
import { api } from "../../api/endpoints";
import { useAuth } from "../../auth/AuthContext";
import { formatDate, formatDateRange } from "../../lib/dates";
import { formatQuantity } from "../../lib/money";
import { RegisterDebtDialog } from "./RegisterDebtDialog";
import { OwedFigure, owedDirection } from "./OwedFigure";
import { totalOwedCents, type Owed } from "./owed";
import { CORRECTION_GLOSS, LEDGER_KIND_LABEL, NOT_YET_EARNED } from "../../lib/vocab";

export function WorkerProfilePage() {
  const { id = "" } = useParams();
  const navigate = useNavigate();
  const { can } = useAuth();
  const [debtOpen, setDebtOpen] = useState(false);
  const { data, error, denied, reload } = useAsync(() => api.workerProfile(id), [id]);

  if (denied) return <PermissionDenied moduleName="ver el perfil de un empleado" />;
  if (error) return <Alert severity="error">{error}</Alert>;
  if (!data) return null;

  const { worker, balance, workRecords, pendingCents, ledger, notes } = data;
  /**
   * The project's only definition of "what they are owed", in `owed.ts`.
   * `pendingIsEstimate` comes out of the unsettled work items themselves: on
   * this farm nearly all of them are paid at the week's price, and a figure
   * that can still move must not look like one that cannot.
   */
  const owed: Owed = {
    balanceCents: balance.balanceCents,
    pendingCents,
    pendingIsEstimate: workRecords.some((r) => !r.settled && r.amountIsEstimate),
  };
  const inFavour = (totalOwedCents(owed) ?? balance.balanceCents) >= 0;

  return (
    <Box>
      <Button
        startIcon={<ArrowBackIcon />}
        onClick={() => navigate("/empleados")}
        color="inherit"
        sx={{ mb: 1 }}
      >
        Empleados
      </Button>

      <Grid container spacing={3} sx={{ mb: 1 }}>
        <Grid size={{ xs: 12, md: 7 }}>
          <Stack direction="row" spacing={2.5} alignItems="flex-start">
            <Avatar
              src={worker.photoUrl ?? undefined}
              sx={{ width: 88, height: 88, fontSize: 34 }}
            >
              {worker.name[0]}
            </Avatar>
            <Box>
              <Stack direction="row" spacing={1} alignItems="center">
                <Typography variant="h1">
                  {worker.name} {worker.lastName}
                </Typography>
                {worker.status === "inactive" && <Chip size="small" label="Inactivo" />}
              </Stack>
              <Typography color="text.secondary">
                {worker.documentType} {worker.documentNumber}
                {worker.phone ? ` · ${worker.phone}` : ""}
              </Typography>
              <Typography color="text.secondary">
                {[worker.city, worker.country].filter(Boolean).join(", ")}
              </Typography>
              {worker.startedAt && (
                <Typography color="text.secondary" variant="body2">
                  Trabaja desde {formatDate(worker.startedAt)}
                </Typography>
              )}

              <Stack direction="row" spacing={1} sx={{ mt: 2 }} flexWrap="wrap" useFlexGap>
                {can("money.pay") && (
                  <Button
                    variant="contained"
                    startIcon={<PaymentsIcon />}
                    onClick={() => navigate(`/empleados/${worker.id}/pagar`)}
                  >
                    Pagar empleado
                  </Button>
                )}
                {can("money.pay") && (
                  <Button
                    variant="outlined"
                    startIcon={<RemoveCircleOutlineIcon />}
                    onClick={() => setDebtOpen(true)}
                  >
                    Registrar deuda
                  </Button>
                )}
                {/* The button exists from Sprint 1; the section it writes into
                    is later work. Disabled and labelled beats absent — but the
                    label a user reads must not name our sprint numbers. */}
                <Tooltip title="Todavía no se pueden escribir anotaciones desde aquí.">

                  <span>
                    <Button variant="outlined" startIcon={<NoteAddIcon />} disabled>
                      Agregar anotación
                    </Button>
                  </span>
                </Tooltip>
              </Stack>
            </Box>
          </Stack>
        </Grid>

        <Grid size={{ xs: 12, md: 5 }}>
          {/* ── THE FIGURE THEY ASKED FOR ────────────────────────────────
              This used to shout the ledger balance —$184.500— with what was
              left to settle in small print below, so the answer to "how much
              do I owe them?" ($338.100) existed only inside the pay screen.
              Anybody who wanted to KNOW without PAYING never saw it, and the
              other three screens said three other things.

              Now the total goes on top and the two halves it comes out of go
              small underneath. `owed.ts` does the adding up, and it is the
              only place in the project where that sum is written. */}
          <Card sx={{ bgcolor: inFavour ? "#eaf3e8" : "#fdecea" }}>
            <CardContent>
              <Typography variant="overline" color="text.secondary">
                Lo que se le debe hoy
              </Typography>
              <OwedFigure owed={owed} variant="big" align="flex-start" />
              <Typography variant="body2" color="text.secondary">
                {owedDirection(owed) ?? "no se pudo establecer"}
              </Typography>

              <Divider sx={{ my: 1.5 }} />

              {/* The breakdown, using the two names the rest of the console
                  uses, so nobody has to guess which of the two halves is
                  "Pendiente de liquidar". */}
              <Stack spacing={0.5}>
                <Stack direction="row" justifyContent="space-between" alignItems="baseline">
                  <Typography variant="body2" color="text.secondary">
                    Ya liquidado (saldo del libro)
                  </Typography>
                  <Money cents={balance.balanceCents} variant="small" />
                </Stack>
                <Stack direction="row" justifyContent="space-between" alignItems="baseline">
                  <Typography variant="body2" color="text.secondary">
                    Pendiente de liquidar
                  </Typography>
                  {/* "—", not "$0". The figure comes from a request of its own,
                      and when it fails a zero says this person is square with
                      the farm — which is the one thing this line must never say
                      by accident. */}
                  {pendingCents === null ? (
                    <Tooltip title="No se pudo consultar lo pendiente de liquidar. No es cero.">
                      <Typography
                        variant="body2"
                        sx={{ color: "text.disabled", fontWeight: 600, cursor: "help" }}
                        aria-label="No se pudo consultar lo pendiente de liquidar. No es cero."
                      >
                        —
                      </Typography>
                    </Tooltip>
                  ) : (
                    <Money cents={pendingCents} variant="small" />
                  )}
                </Stack>
              </Stack>
              <Typography variant="caption" color="text.secondary" component="div" sx={{ mt: 0.5 }}>
                Lo pendiente es {NOT_YET_EARNED}. Se le entrega igual: liquidar es el
                papel, no la deuda.
              </Typography>
              {balance.lastMovementOn && (
                <Typography variant="caption" color="text.secondary" component="div" sx={{ mt: 1 }}>
                  Último movimiento: {formatDate(balance.lastMovementOn)}
                </Typography>
              )}
            </CardContent>
          </Card>
        </Grid>
      </Grid>

      <Card sx={{ mt: 2 }}>
        <CardContent>
          <Typography variant="h3" gutterBottom>
            Labores
          </Typography>
          <Table size="small">
            <TableHead>
              <TableRow>
                <TableCell>Actividad</TableCell>
                <TableCell>Fecha</TableCell>
                <TableCell>Lotes</TableCell>
                <TableCell align="right">Cantidad</TableCell>
                <TableCell align="right">Valor</TableCell>
                <TableCell />
              </TableRow>
            </TableHead>
            <TableBody>
              {workRecords.map((r) => (
                <TableRow key={r.id}>
                  <TableCell sx={{ fontWeight: 600 }}>{r.activityName}</TableCell>
                  <TableCell>{formatDateRange(r.dateFrom, r.dateTo)}</TableCell>
                  <TableCell>{r.plotNames.join(", ")}</TableCell>
                  <TableCell align="right">
                    {r.payMode === "contract"
                      ? "contrato"
                      : `${formatQuantity(r.quantity)} ${r.unitLabel ?? ""}`}
                  </TableCell>
                  <TableCell align="right">
                    {/* `<Value>` rather than a bare `<Money>`: on this farm
                        every unsettled row is priced by the week, and a figure
                        that can still move must not look like one that
                        cannot. `amountIsEstimate` is the server's own flag and
                        had no reader anywhere in the console. */}
                    <Value total={totalsOfRecords([r])} variant="small" />
                  </TableCell>
                  <TableCell>
                    {r.settled ? (
                      <Chip size="small" label="liquidada" />
                    ) : (
                      <Chip size="small" color="warning" variant="outlined" label="pendiente" />
                    )}
                  </TableCell>
                </TableRow>
              ))}
              {workRecords.length === 0 && (
                <TableRow>
                  <TableCell colSpan={6} sx={{ color: "text.secondary" }}>
                    Este empleado no tiene labores registradas.
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
          {/* `pendingCents > 0` also hid this whole block when the request had
              simply failed, because the fallback was 0. A failure gets its own
              line now and says so. */}
          {pendingCents === null ? (
            <Stack direction="row" justifyContent="flex-end" sx={{ mt: 1 }}>
              <Typography variant="body2" color="warning.dark">
                No se pudo consultar lo pendiente de liquidar. No es cero.
              </Typography>
            </Stack>
          ) : (
            pendingCents > 0 && (
              <Stack direction="row" justifyContent="flex-end" sx={{ mt: 1 }}>
                <Typography variant="body2" color="text.secondary">
                  Pendientes de liquidar: <Money cents={pendingCents} variant="small" />
                </Typography>
              </Stack>
            )
          )}
        </CardContent>
      </Card>

      <Card sx={{ mt: 3 }}>
        <CardContent>
          <Typography variant="h3" gutterBottom>
            Historial financiero
          </Typography>
          <Table size="small">
            <TableHead>
              <TableRow>
                <TableCell>Tipo</TableCell>
                <TableCell>Concepto</TableCell>
                <TableCell>Fecha</TableCell>
                <TableCell align="right">Monto</TableCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {ledger.map((l) => (
                <TableRow key={l.id}>
                  <TableCell>
                    <Chip
                      size="small"
                      variant="outlined"
                      label={LEDGER_KIND_LABEL[l.kind]}
                      color={l.amountCents >= 0 ? "success" : "default"}
                    />
                  </TableCell>
                  <TableCell>{l.concept}</TableCell>
                  <TableCell>{formatDate(l.date)}</TableCell>
                  <TableCell align="right">
                    <Money cents={l.amountCents} signed colored />
                  </TableCell>
                </TableRow>
              ))}
              {ledger.length === 0 && (
                <TableRow>
                  <TableCell colSpan={4} sx={{ color: "text.secondary" }}>
                    Todavía no se le ha pagado ni descontado nada.
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
          {/* ── THE TABLE CLAIMED TO BE EVERYTHING AND WAS ONE PAGE ───────
              "Historial financiero" is the last `ledgerLimit` entries: the
              server cuts it there and the response does not mention it.
              Somebody two seasons into the farm saw half their account under
              a title that promised the whole of it. We say so, with the
              number, and only when there really may be more — same as in
              `/cosecha`. */}
          {ledger.length >= data.ledgerLimit && (
            <Typography variant="caption" color="warning.dark" component="div" sx={{ mt: 1 }}>
              Se muestran los {data.ledgerLimit} movimientos más recientes. Puede haber
              más atrás.
            </Typography>
          )}
          <Alert severity="info" variant="outlined" sx={{ mt: 2 }}>
            Nada de esto se edita ni se borra. Un error se corrige con {CORRECTION_GLOSS}
          </Alert>
        </CardContent>
      </Card>

      <Card sx={{ mt: 3 }}>
        <CardContent>
          <Typography variant="h3" gutterBottom>
            Anotaciones
          </Typography>
          {notes.map((n) => (
            <Box key={n.id} sx={{ py: 1, borderBottom: 1, borderColor: "divider" }}>
              <Typography variant="body2">{n.text}</Typography>
              <Typography variant="caption" color="text.secondary">
                {formatDate(n.date)} · {n.authorName}
              </Typography>
            </Box>
          ))}
          {notes.length === 0 && (
            <Typography color="text.secondary" variant="body2">
              Sin anotaciones.
            </Typography>
          )}
          <Alert severity="info" variant="outlined" sx={{ mt: 2 }}>
            Las anotaciones <strong>no salen de esta finca</strong>. Nunca viajan a
            ninguna consulta entre fincas ni a ningún registro nacional.
          </Alert>
        </CardContent>
      </Card>

      <RegisterDebtDialog
        open={debtOpen}
        workerId={worker.id}
        onClose={() => setDebtOpen(false)}
        onSaved={() => {
          setDebtOpen(false);
          reload();
        }}
      />
    </Box>
  );
}
