import { useState } from "react";
import {
  Alert, Button, Dialog, DialogActions, DialogContent, DialogTitle, Stack, TextField,
} from "@mui/material";
import { api } from "../../api/endpoints";
import { messageFor } from "../../api/errors";
import { parseMoneyInput } from "../../lib/money";
import { uuidv7 } from "../../lib/uuid";
import { Money } from "../../components/Money";

/**
 * A debt the worker owes the farm: a `deduccion` in their ledger.
 *
 * Not to be confused with an "expense" (RSP-030), which is the farm's own
 * accounting and never touches anybody's pay. `arquitectura-api.md` is
 * emphatic that mixing them means logging the cost of a fumigation deducts it
 * from someone's wages.
 */
export function RegisterDebtDialog({
  open, workerId, onClose, onSaved,
}: {
  open: boolean;
  workerId: string;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [concept, setConcept] = useState("");
  const [amount, setAmount] = useState("");
  const [date, setDate] = useState(new Date().toISOString().slice(0, 10));
  const [error, setError] = useState<string | null>(null);
  const [fields, setFields] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);

  const cents = parseMoneyInput(amount);

  async function save() {
    const e: Record<string, string> = {};
    if (!concept.trim()) e.concept = "Escriba de qué es la deuda.";
    if (cents === null) e.amount = "Escriba un valor, por ejemplo 45.000.";
    else if (cents <= 0) e.amount = "El valor tiene que ser mayor que cero.";
    setFields(e);
    if (Object.keys(e).length) return;

    setBusy(true);
    setError(null);
    try {
      await api.createDeduction({
        id: uuidv7(),
        workerId,
        amountCents: cents as number,
        concept: concept.trim(),
        date,
      });
      setConcept("");
      setAmount("");
      onSaved();
    } catch (err) {
      setError(messageFor(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open={open} onClose={busy ? undefined : onClose} maxWidth="xs" fullWidth>
      <DialogTitle>Registrar deuda</DialogTitle>
      <DialogContent>
        <Stack spacing={2.5} sx={{ mt: 1 }}>
          {error && <Alert severity="error">{error}</Alert>}
          <TextField
            label="Concepto"
            value={concept}
            onChange={(e) => setConcept(e.target.value)}
            error={!!fields.concept}
            helperText={fields.concept ?? "Ejemplo: mercado adelantado, herramienta."}
            size="medium"
            fullWidth
            autoFocus
          />
          <TextField
            label="Valor"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            error={!!fields.amount}
            helperText={
              fields.amount ??
              (cents !== null && cents > 0 ? <>Se descontará <Money cents={cents} variant="small" /> del saldo.</> : "En pesos.")
            }
            size="medium"
            fullWidth
            inputMode="numeric"
          />
          <TextField
            label="Fecha"
            type="date"
            value={date}
            onChange={(e) => setDate(e.target.value)}
            size="medium"
            fullWidth
            slotProps={{ inputLabel: { shrink: true } }}
          />
        </Stack>
      </DialogContent>
      <DialogActions sx={{ px: 3, pb: 2 }}>
        <Button onClick={onClose} color="inherit" disabled={busy}>
          Cancelar
        </Button>
        <Button onClick={save} variant="contained" disabled={busy}>
          {busy ? "Guardando…" : "Registrar deuda"}
        </Button>
      </DialogActions>
    </Dialog>
  );
}
