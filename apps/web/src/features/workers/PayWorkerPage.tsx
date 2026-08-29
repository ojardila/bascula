/**
 * RSP-008. Everything owed on one screen, and two ways to pay it.
 *
 * The parts that are easy to get wrong:
 *
 * - **The gross on screen can stop being true while somebody looks at it.**
 *   This is the one that costs real money. A late pickup arrives, or the
 *   week's price is changed, and the settlement writes a `devengo` for a
 *   figure the approver never read. So every settle carries the figure that
 *   WAS approved (`expectedGrossCents`), and when it no longer matches, this
 *   screen does not show an error — it shows the DIFFERENCE, says what moved,
 *   and offers exactly one way out: look again. There is deliberately no
 *   "reintentar", because a retry that skips the check is the same bug with an
 *   extra click in front of it. See `api/grossChange.ts`.
 *
 * - **Pago total re-reads the balance.** It pays exactly what the balance is
 *   at the moment of writing, not the number that was on screen when the page
 *   loaded. Reading before and posting after is how two people paying at once
 *   pay more than is owed.
 *
 * - **Paying more than the balance is not an error to swallow.** RSP-008
 *   forbids it; the ledger would happily accept it. So the excess is offered
 *   as an `anticipo` — a separate entry, correctly named — and the user
 *   decides. Silently capping it would lose money the farm actually handed
 *   over; silently allowing it would leave a payment nobody can explain.
 *
 * - **Settling is what creates the devengo.** Selecting the pending work
 *   records and paying freezes them into a settlement; the labor was only ever
 *   the fact that work happened.
 */
import { useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import {
  Alert, Box, Button, Card, CardContent, Checkbox, Chip, Dialog, DialogActions,
  DialogContent, DialogContentText, DialogTitle, Divider, Grid, MenuItem, Stack,
  Table, TableBody, TableCell, TableHead, TableRow, TextField, Typography,
} from "@mui/material";
import ArrowBackIcon from "@mui/icons-material/ArrowBack";
import PrintIcon from "@mui/icons-material/Print";
import ChangeCircleIcon from "@mui/icons-material/ChangeCircle";
import { Money } from "../../components/Money";
import { PermissionDenied } from "../../components/Guards";
import { useAsync } from "../../lib/useAsync";
import { api } from "../../api/endpoints";
import { ApiError, messageFor } from "../../api/errors";
import { formatDateRange, formatDayLong } from "../../lib/dates";
import { formatMoney, formatQuantity, parseMoneyInput } from "../../lib/money";
import { uuidv7 } from "../../lib/uuid";
import { useAuth } from "../../auth/AuthContext";
import { grossChangeOf } from "../../api/endpoints";
import { sentenceFor, type GrossChange } from "../../api/grossChange";

/**
 * How the difference dialog writes figures and dates. Passed in rather than
 * imported by `grossChange.ts`, which stays free of the formatting layer so
 * its arithmetic can be tested on plain numbers.
 */
const FMT = { money: formatMoney, week: formatDayLong };
import { paymentReceiptHtml } from "../documents/documents";
import { printDocument } from "../documents/print";
import type { PayableLine, PayMethod, Payment } from "../../api/types";

export function PayWorkerPage() {
  const { id = "" } = useParams();
  const navigate = useNavigate();
  const { user } = useAuth();

  const { data, error, denied, reload } = useAsync(
    () => Promise.all([api.getWorker(id), api.workerPayables(id), api.workerBalance(id)]),
    [id],
  );

  const [selected, setSelected] = useState<Set<string> | null>(null);
  const [method, setMethod] = useState<PayMethod>("efectivo");
  const [partial, setPartial] = useState("");
  const [busy, setBusy] = useState(false);
  const [payError, setPayError] = useState<string | null>(null);
  const [receipt, setReceipt] = useState<{ payment: Payment; lines: PayableLine[] } | null>(null);
  const [excess, setExcess] = useState<{ amount: number; balance: number } | null>(null);
  /**
   * The figure moved under the person's hands. Non-null means the screen is
   * BLOCKED: no payment can be made from this state, and the only control
   * offered reloads what is owed.
   */
  const [changed, setChanged] = useState<GrossChange | null>(null);

  if (denied) return <PermissionDenied moduleName="pagar a un empleado" />;
  if (error) return <Alert severity="error">{error}</Alert>;
  if (!data) return null;

  const [worker, payables, balance] = data;
  // All pending records are ticked by default: paying part of a week is the
  // exception, and an empty selection with a total at the bottom reads broken.
  const checked = selected ?? new Set(payables.workRecords.map((w) => w.id));
  const selectedCents = payables.workRecords
    .filter((w) => checked.has(w.id))
    .reduce((a, w) => a + w.amountCents, 0);
  const toPayCents = balance.balanceCents + selectedCents;

  function toggle(recordId: string) {
    const next = new Set(checked);
    if (next.has(recordId)) next.delete(recordId);
    else next.add(recordId);
    setSelected(next);
  }

  async function pay(amountCents: number, alsoAdvance = 0) {
    setBusy(true);
    setPayError(null);
    // The lines behind the figure, captured at the moment of approval. They go
    // with the request so that a refusal can say WHAT moved and not just that
    // something did.
    const approved = payables.workRecords.filter((w) => checked.has(w.id));
    try {
      const result = await api.createPayment({
        id: uuidv7(),
        workerId: id,
        amountCents,
        method,
        payableIds: [...checked],
        expectedGrossCents: selectedCents,
        expectedLines: approved,
      });
      if (alsoAdvance > 0) {
        await api.createAdvance({
          id: uuidv7(),
          workerId: id,
          amountCents: alsoAdvance,
          method,
          note: "Excedente del pago, registrado como anticipo",
        });
      }
      setReceipt({ payment: result, lines: approved });
      setSelected(new Set());
      setPartial("");
      reload();
    } catch (e) {
      const change = grossChangeOf(e);
      if (change) {
        // Nothing was written — `api.settle` refuses before posting — so the
        // screen has only to stop and explain.
        setChanged(change);
      } else if (e instanceof ApiError && e.code === "AMOUNT_EXCEEDS_BALANCE") {
        const serverBalance = Number(e.details.balanceCents ?? 0);
        setExcess({ amount: amountCents, balance: serverBalance });
      } else {
        setPayError(messageFor(e));
      }
    } finally {
      setBusy(false);
    }
  }

  /**
   * The ONLY exit from the difference dialog. It throws away the selection and
   * reloads what is owed, so the next figure the person approves is one they
   * have actually read. Deliberately not a "reintentar": that button would
   * re-send the stale approval, which is the thing this whole screen is built
   * to prevent.
   */
  function reviewAgain() {
    setChanged(null);
    setSelected(null);
    setPartial("");
    reload();
  }

  function printReceipt() {
    if (!receipt) return;
    const ok = printDocument(
      paymentReceiptHtml({
        farmName: user?.farm.name ?? "Finca",
        worker,
        payment: receipt.payment,
        lines: receipt.lines,
      }),
    );
    if (!ok) setPayError("No se pudo abrir la impresión. Revise el navegador.");
  }

  const partialCents = parseMoneyInput(partial);
  const nothingToDo = toPayCents <= 0 && payables.workRecords.length === 0;

  return (
    <Box>
      <Button
        startIcon={<ArrowBackIcon />}
        onClick={() => navigate(`/empleados/${id}`)}
        color="inherit"
        sx={{ mb: 1 }}
      >
        Perfil de {worker.name}
      </Button>
      <Typography variant="h1" gutterBottom>
        Pagar a {worker.name} {worker.lastName}
      </Typography>

      {payError && (
        <Alert severity="error" sx={{ mb: 2 }} onClose={() => setPayError(null)}>
          {payError}
        </Alert>
      )}

      {nothingToDo && (
        <Alert severity="info" sx={{ mb: 2 }}>
          No hay nada que pagar: no hay labores pendientes ni saldo a favor.{" "}
          <Button size="small" onClick={() => navigate("/labores/nueva")}>
            Registrar una labor
          </Button>
        </Alert>
      )}

      <Grid container spacing={3}>
        <Grid size={{ xs: 12, md: 8 }}>
          <Card sx={{ mb: 3 }}>
            <CardContent>
              <Typography variant="h3" gutterBottom>
                Labores pendientes de liquidar
              </Typography>
              <Table size="small">
                <TableHead>
                  <TableRow>
                    <TableCell padding="checkbox" />
                    <TableCell>Actividad</TableCell>
                    <TableCell>Fecha</TableCell>
                    <TableCell>Lotes</TableCell>
                    <TableCell align="right">Cantidad</TableCell>
                    <TableCell align="right">Valor</TableCell>
                  </TableRow>
                </TableHead>
                <TableBody>
                  {payables.workRecords.map((w) => (
                    <TableRow key={w.id} hover onClick={() => toggle(w.id)} sx={{ cursor: "pointer" }}>
                      <TableCell padding="checkbox">
                        <Checkbox
                          checked={checked.has(w.id)}
                          inputProps={{ "aria-label": `Incluir ${w.activityName}` }}
                        />
                      </TableCell>
                      <TableCell sx={{ fontWeight: 600 }}>
                        {w.activityName}
                        {/* Estimado no es definitivo. This row is priced by the
                            week's price, which is not fixed until the week
                            closes — so what is next to it is what it WOULD be
                            worth, not what is owed. It is also exactly the row
                            that can move under an open payment screen. */}
                        {w.rateSource === "weekly_price" && (
                          <Chip
                            size="small"
                            color="warning"
                            variant="outlined"
                            label="provisional"
                            sx={{ ml: 1, height: 20, fontSize: "0.68rem" }}
                          />
                        )}
                      </TableCell>
                      <TableCell>{formatDateRange(w.dateFrom, w.dateTo)}</TableCell>
                      <TableCell>{w.plotNames.join(", ")}</TableCell>
                      <TableCell align="right">
                        {w.unitLabel ? `${formatQuantity(w.quantity)} ${w.unitLabel}` : "contrato"}
                      </TableCell>
                      <TableCell align="right">
                        <Money cents={w.amountCents} variant="small" />
                      </TableCell>
                    </TableRow>
                  ))}
                  {payables.workRecords.length === 0 && (
                    <TableRow>
                      <TableCell colSpan={6} sx={{ color: "text.secondary" }}>
                        No hay labores pendientes.
                      </TableCell>
                    </TableRow>
                  )}
                </TableBody>
              </Table>
              {payables.workRecords.some((w) => w.rateSource === "weekly_price") && (
                <Alert severity="warning" variant="outlined" sx={{ mt: 2 }}>
                  Las labores marcadas <strong>provisional</strong> se pagan al precio de
                  la semana, que se fija al cerrar la semana. Si ese precio cambia antes
                  de que usted liquide, el total cambia — y esta pantalla se lo dirá
                  antes de registrar nada.
                </Alert>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardContent>
              <Typography variant="h3" gutterBottom>
                Deudas y anticipos
              </Typography>
              <Table size="small">
                <TableHead>
                  <TableRow>
                    <TableCell>Concepto</TableCell>
                    <TableCell>Fecha</TableCell>
                    <TableCell align="right">Valor</TableCell>
                  </TableRow>
                </TableHead>
                <TableBody>
                  {payables.debts.map((d) => (
                    <TableRow key={d.id}>
                      <TableCell>{d.concept}</TableCell>
                      <TableCell>{d.date}</TableCell>
                      <TableCell align="right">
                        <Money cents={-d.amountCents} signed colored />
                      </TableCell>
                    </TableRow>
                  ))}
                  {payables.debts.length === 0 && (
                    <TableRow>
                      <TableCell colSpan={3} sx={{ color: "text.secondary" }}>
                        Sin deudas ni anticipos.
                      </TableCell>
                    </TableRow>
                  )}
                </TableBody>
              </Table>
            </CardContent>
          </Card>
        </Grid>

        <Grid size={{ xs: 12, md: 4 }}>
          <Card sx={{ position: { md: "sticky" }, top: 88 }}>
            <CardContent>
              <Typography variant="overline" color="text.secondary">
                Total a pagar
              </Typography>
              <Money cents={toPayCents} variant="big" />
              <Stack spacing={0.5} sx={{ mt: 1.5 }}>
                <Stack direction="row" justifyContent="space-between">
                  <Typography variant="body2" color="text.secondary">
                    Saldo actual
                  </Typography>
                  <Money cents={balance.balanceCents} variant="small" />
                </Stack>
                <Stack direction="row" justifyContent="space-between">
                  <Typography variant="body2" color="text.secondary">
                    Labores seleccionadas
                  </Typography>
                  <Money cents={selectedCents} variant="small" />
                </Stack>
              </Stack>

              <Divider sx={{ my: 2 }} />

              <TextField
                select
                label="Forma de pago"
                value={method}
                onChange={(e) => setMethod(e.target.value as PayMethod)}
                fullWidth
                size="medium"
                sx={{ mb: 2 }}
              >
                <MenuItem value="efectivo">Efectivo</MenuItem>
                <MenuItem value="transferencia">Transferencia</MenuItem>
                <MenuItem value="otro">Otro</MenuItem>
              </TextField>

              <Button
                variant="contained"
                fullWidth
                size="large"
                disabled={busy || !!changed || toPayCents <= 0}
                onClick={() => pay(toPayCents)}
                sx={{ mb: 2 }}
              >
                Pago total · {formatMoney(toPayCents)}
              </Button>

              <Typography variant="overline" color="text.secondary">
                Pago parcial
              </Typography>
              <Stack direction="row" spacing={1} sx={{ mt: 1 }}>
                <TextField
                  label="Valor"
                  value={partial}
                  onChange={(e) => setPartial(e.target.value)}
                  size="medium"
                  fullWidth
                  inputMode="numeric"
                  helperText={
                    partialCents !== null && partialCents > toPayCents && toPayCents > 0
                      ? "Es más que el total. Se le preguntará qué hacer con el excedente."
                      : " "
                  }
                />
                <Button
                  variant="outlined"
                  disabled={busy || !!changed || partialCents === null || partialCents <= 0}
                  onClick={() => pay(partialCents as number)}
                  sx={{ height: 56 }}
                >
                  Pagar
                </Button>
              </Stack>

              <Alert severity="info" variant="outlined" sx={{ mt: 2 }}>
                El pago se registra en el libro y no se edita. Si queda mal, se corrige
                con un reverso.
              </Alert>
            </CardContent>
          </Card>
        </Grid>
      </Grid>

      {/* ── THE FIGURE MOVED ──────────────────────────────────────────────
          Not an error box. An error box says "something went wrong" and offers
          a retry; what actually happened is that the farm now owes a different
          amount, and the person has to see the new one before approving it.

          `onClose` is not wired and the escape key is disabled on purpose:
          every way out of this dialog goes through `reviewAgain`, which throws
          the stale approval away and reloads. There is no path from here to a
          write. */}
      <Dialog open={!!changed} disableEscapeKeyDown maxWidth="sm" fullWidth>
        <DialogTitle sx={{ display: "flex", alignItems: "center", gap: 1 }}>
          <ChangeCircleIcon color="warning" />
          El total cambió mientras revisaba
        </DialogTitle>
        <DialogContent>
          {changed && (
            <>
              <DialogContentText component="div" sx={{ fontSize: "1.05rem" }}>
                {sentenceFor(changed, FMT)}
              </DialogContentText>

              <Stack
                direction="row"
                spacing={2}
                sx={{ mt: 2.5, mb: 1 }}
                divider={<Divider orientation="vertical" flexItem />}
              >
                <Box>
                  <Typography variant="overline" color="text.secondary">
                    Lo que usted aprobó
                  </Typography>
                  <Money cents={changed.beforeCents} />
                </Box>
                <Box>
                  <Typography variant="overline" color="text.secondary">
                    Lo que se registraría ahora
                  </Typography>
                  <Money cents={changed.afterCents} variant="big" />
                </Box>
                <Box>
                  <Typography variant="overline" color="text.secondary">
                    Diferencia
                  </Typography>
                  <Money cents={changed.deltaCents} signed colored />
                </Box>
              </Stack>

              {/* The rows themselves, so the sentence above can be checked. */}
              {(changed.added.length > 0 || changed.removed.length > 0) && (
                <Table size="small" sx={{ mt: 1 }}>
                  <TableHead>
                    <TableRow>
                      <TableCell>Qué cambió</TableCell>
                      <TableCell>Actividad</TableCell>
                      <TableCell>Fecha</TableCell>
                      <TableCell align="right">Valor</TableCell>
                    </TableRow>
                  </TableHead>
                  <TableBody>
                    {changed.added.map((l) => (
                      <TableRow key={`a-${l.id}`}>
                        <TableCell>
                          <Chip size="small" color="warning" label="Entró" />
                        </TableCell>
                        <TableCell>{l.activityName}</TableCell>
                        <TableCell>{formatDateRange(l.dateFrom, l.dateTo)}</TableCell>
                        <TableCell align="right">
                          <Money cents={l.amountCents} variant="small" />
                        </TableCell>
                      </TableRow>
                    ))}
                    {changed.removed.map((l) => (
                      <TableRow key={`r-${l.id}`}>
                        <TableCell>
                          <Chip size="small" variant="outlined" label="Salió" />
                        </TableCell>
                        <TableCell>{l.activityName}</TableCell>
                        <TableCell>{formatDateRange(l.dateFrom, l.dateTo)}</TableCell>
                        <TableCell align="right">
                          <Money cents={-l.amountCents} signed variant="small" />
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              )}

              {changed.repriced.length > 0 && (
                <Alert severity="info" variant="outlined" sx={{ mt: 2 }}>
                  {changed.repriced.length === 1
                    ? "Una labor"
                    : `${changed.repriced.length} labores`}{" "}
                  se pagan al precio de la semana, y ese precio cambió: de{" "}
                  <strong>{formatMoney(changed.repriced[0].fromRateCents)}</strong> a{" "}
                  <strong>{formatMoney(changed.repriced[0].toRateCents)}</strong> por unidad.
                </Alert>
              )}

              <Alert severity="warning" variant="outlined" sx={{ mt: 2 }}>
                No se registró ningún pago ni ninguna liquidación. Vuelva a mirar el
                detalle y apruebe la cifra nueva.
              </Alert>
            </>
          )}
        </DialogContent>
        <DialogActions sx={{ px: 3, pb: 2 }}>
          <Button variant="contained" onClick={reviewAgain} autoFocus>
            Volver a revisar
          </Button>
        </DialogActions>
      </Dialog>

      {/* Paying more than the balance: RSP-008 forbids it, the ledger allows
          it, so the person decides — and the excess is named correctly. */}
      <Dialog open={!!excess} onClose={() => setExcess(null)} maxWidth="xs" fullWidth>
        <DialogTitle>El valor supera el saldo</DialogTitle>
        <DialogContent>
          <DialogContentText component="div">
            Está pagando <strong>{formatMoney(excess?.amount ?? 0)}</strong> y el saldo
            pendiente es <strong>{formatMoney(excess?.balance ?? 0)}</strong>.
            <Box sx={{ mt: 2 }}>
              Puede corregir el valor, o pagar de más y registrar la diferencia de{" "}
              <strong>{formatMoney((excess?.amount ?? 0) - (excess?.balance ?? 0))}</strong>{" "}
              como <strong>anticipo</strong>, que es lo que realmente es: plata
              entregada a cuenta de trabajo futuro.
            </Box>
          </DialogContentText>
        </DialogContent>
        <DialogActions sx={{ px: 3, pb: 2 }}>
          <Button color="inherit" onClick={() => setExcess(null)}>
            Corregir el valor
          </Button>
          <Button
            variant="contained"
            onClick={() => {
              const e = excess;
              setExcess(null);
              if (e) pay(e.balance, e.amount - e.balance);
            }}
          >
            Pagar y registrar anticipo
          </Button>
        </DialogActions>
      </Dialog>

      <Dialog open={!!receipt} onClose={() => setReceipt(null)} maxWidth="xs" fullWidth>
        <DialogTitle>Pago registrado</DialogTitle>
        <DialogContent>
          <Stack spacing={1.5} sx={{ mt: 1 }}>
            <Chip label={`Recibo #${receipt?.payment.receiptNumber}`} sx={{ alignSelf: "flex-start" }} />
            <Stack direction="row" justifyContent="space-between">
              <Typography color="text.secondary">Pagado</Typography>
              <Money cents={receipt?.payment.amountCents ?? 0} />
            </Stack>
            <Stack direction="row" justifyContent="space-between">
              <Typography color="text.secondary">Saldo antes</Typography>
              <Money cents={receipt?.payment.balanceBeforeCents ?? 0} variant="small" />
            </Stack>
            <Stack direction="row" justifyContent="space-between">
              <Typography color="text.secondary">Saldo después</Typography>
              <Money cents={receipt?.payment.balanceAfterCents ?? 0} variant="small" />
            </Stack>
          </Stack>
        </DialogContent>
        <DialogActions sx={{ px: 3, pb: 2 }}>
          <Button onClick={() => setReceipt(null)} color="inherit">
            Seguir aquí
          </Button>
          <Button onClick={() => navigate(`/empleados/${id}`)} color="inherit">
            Ver el perfil
          </Button>
          {/* RSP-008: "el sistema genera el recibo de pago". It is the primary
              action, because a payment the worker has no paper for is a
              payment they cannot check. */}
          <Button variant="contained" startIcon={<PrintIcon />} onClick={printReceipt}>
            Imprimir recibo
          </Button>
        </DialogActions>
      </Dialog>
    </Box>
  );
}
