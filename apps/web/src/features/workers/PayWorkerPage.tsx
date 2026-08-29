/**
 * RSP-008. Everything owed on one screen, and two ways to pay it.
 *
 * The parts that are easy to get wrong:
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
import { Money } from "../../components/Money";
import { PermissionDenied } from "../../components/Guards";
import { useAsync } from "../../lib/useAsync";
import { api } from "../../api/endpoints";
import { ApiError, messageFor } from "../../api/errors";
import { formatDateRange } from "../../lib/dates";
import { formatMoney, formatQuantity, parseMoneyInput } from "../../lib/money";
import { uuidv7 } from "../../lib/uuid";
import type { PayMethod, Payment } from "../../api/types";

export function PayWorkerPage() {
  const { id = "" } = useParams();
  const navigate = useNavigate();

  const { data, error, denied, reload } = useAsync(
    () => Promise.all([api.getWorker(id), api.workerPayables(id), api.workerBalance(id)]),
    [id],
  );

  const [selected, setSelected] = useState<Set<string> | null>(null);
  const [method, setMethod] = useState<PayMethod>("efectivo");
  const [partial, setPartial] = useState("");
  const [busy, setBusy] = useState(false);
  const [payError, setPayError] = useState<string | null>(null);
  const [receipt, setReceipt] = useState<Payment | null>(null);
  const [excess, setExcess] = useState<{ amount: number; balance: number } | null>(null);

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
    try {
      const result = await api.createPayment({
        id: uuidv7(),
        workerId: id,
        amountCents,
        method,
        payableIds: [...checked],
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
      setReceipt(result);
      setSelected(new Set());
      setPartial("");
      reload();
    } catch (e) {
      if (e instanceof ApiError && e.code === "AMOUNT_EXCEEDS_BALANCE") {
        const serverBalance = Number(e.details.balanceCents ?? 0);
        setExcess({ amount: amountCents, balance: serverBalance });
      } else {
        setPayError(messageFor(e));
      }
    } finally {
      setBusy(false);
    }
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
                      <TableCell sx={{ fontWeight: 600 }}>{w.activityName}</TableCell>
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
                disabled={busy || toPayCents <= 0}
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
                  disabled={busy || partialCents === null || partialCents <= 0}
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
            <Chip label={`Recibo #${receipt?.receiptNumber}`} sx={{ alignSelf: "flex-start" }} />
            <Stack direction="row" justifyContent="space-between">
              <Typography color="text.secondary">Pagado</Typography>
              <Money cents={receipt?.amountCents ?? 0} />
            </Stack>
            <Stack direction="row" justifyContent="space-between">
              <Typography color="text.secondary">Saldo antes</Typography>
              <Money cents={receipt?.balanceBeforeCents ?? 0} variant="small" />
            </Stack>
            <Stack direction="row" justifyContent="space-between">
              <Typography color="text.secondary">Saldo después</Typography>
              <Money cents={receipt?.balanceAfterCents ?? 0} variant="small" />
            </Stack>
          </Stack>
        </DialogContent>
        <DialogActions sx={{ px: 3, pb: 2 }}>
          <Button onClick={() => setReceipt(null)} color="inherit">
            Seguir aquí
          </Button>
          <Button variant="contained" onClick={() => navigate(`/empleados/${id}`)}>
            Ver el perfil
          </Button>
        </DialogActions>
      </Dialog>
    </Box>
  );
}
