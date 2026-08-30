/**
 * RSP-031, and the one rule the schema will not bend on:
 *
 *     CONSTRAINT expense_target CHECK (
 *       (activity_id IS NOT NULL)::int
 *       + (COALESCE(plot_id, plot_crop_id) IS NOT NULL)::int = 1)
 *
 * **A un gasto se le carga UNA cosa: o una actividad, o un lote. Ni las dos, ni
 * ninguna.** Neither is worse than it sounds — an expense charged to nothing
 * shows up in the total and in no breakdown, and in March the difference
 * between the total and the sum of the parts is a number nobody can explain.
 * Both is worse still: it is counted twice.
 *
 * The form makes both of those UNREACHABLE rather than punished. "Tipo de
 * gasto" is a radio with no empty option, and the fields below it are the ones
 * belonging to the chosen type — the others are not disabled, they are not
 * rendered, so there is nothing left holding a value that could travel. On the
 * way out, `ExpenseInput` is a discriminated union, so even a bug in this file
 * cannot construct a body with both.
 *
 * The one thing that is optional is the crop inside a lot: a lot may have
 * coffee and plantain, and a fence repair is honestly for the whole lot. So the
 * crop select has a "todo el lote" option, and it maps to a null `plotCropId`,
 * which `COALESCE(plot_id, plot_crop_id)` accepts.
 *
 * AND: this is not RSP-007's "gasto". That one is a debt a worker owes, it
 * belongs in the ledger, and it is `POST /v1/deductions`. Wiring the two
 * together — the same word in the same document meaning two things — would
 * make recording the cost of a spraying take money out of somebody's wages.
 * The note at the top of `internal/store/expenses.go` says the same from the
 * other side.
 */
import { useState } from "react";
import {
  Alert, Button, Dialog, DialogActions, DialogContent, DialogTitle,
  FormControl, FormControlLabel, FormLabel, MenuItem, Radio, RadioGroup,
  Stack, TextField, Typography,
} from "@mui/material";
import { api } from "../../api/endpoints";
import { messageFor } from "../../api/errors";
import { useWriteOnce } from "../../lib/writeOnce";
import { moneyInputValue, parseMoneyInput } from "../../lib/money";
import { todayInFarm } from "../../lib/dates";
import { useAuth } from "../../auth/AuthContext";
import type { Activity, Expense, ExpenseInput, ExpenseTarget, Plot } from "../../api/types";
import { DateField } from "../../components/DateField";

export interface ExpenseFormDialogProps {
  open: boolean;
  /** Null to create. */
  expense: Expense | null;
  activities: Activity[];
  plots: Plot[];
  onClose: () => void;
  onSaved: (e: Expense) => void;
}

export function ExpenseFormDialog({
  open, expense, activities, plots, onClose, onSaved,
}: ExpenseFormDialogProps) {
  const { user } = useAuth();
  const today = todayInFarm(user?.farm.timezone ?? "America/Bogota");

  const [concept, setConcept] = useState(expense?.concept ?? "");
  // `moneyInputValue` y no `Math.round(.../100)`: abrir un gasto de $125,50
  // para cambiarle la nota y guardar le subía el valor a $126 sin que nadie
  // tocara la casilla. Ver la nota de `lib/money.ts`.
  const [amount, setAmount] = useState(expense ? moneyInputValue(expense.amountCents) : "");
  const [date, setDate] = useState(expense?.date ?? today);
  const [target, setTarget] = useState<ExpenseTarget>(expense?.target ?? "activity");
  const [activityId, setActivityId] = useState(expense?.activityId ?? "");
  const [plotId, setPlotId] = useState(expense?.plotId ?? "");
  const [plotCropId, setPlotCropId] = useState(expense?.plotCropId ?? "");
  const [note, setNote] = useState(expense?.note ?? "");
  const [fields, setFields] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const { busy, run: runOnce } = useWriteOnce();

  const amountCents = parseMoneyInput(amount);
  const plot = plots.find((p) => p.id === plotId) ?? null;

  function validate(): boolean {
    const e: Record<string, string> = {};
    if (!concept.trim()) e.concept = "Escriba en qué se gastó.";
    if (!amount.trim()) e.amount = "Escriba el valor.";
    else if (amountCents === null) e.amount = "Escriba un número, por ejemplo 250.000.";
    else if (amountCents <= 0) e.amount = "Tiene que ser mayor que cero.";
    // One of the two, and which one depends on the radio. There is no state of
    // this form in which both are asked for.
    if (target === "activity" && !activityId) {
      e.activity = "Elija a qué actividad se carga este gasto.";
    }
    if (target === "plot" && !plotId) {
      e.plot = "Elija a qué lote se carga este gasto.";
    }
    setFields(e);
    return Object.keys(e).length === 0;
  }

  async function save() {
    if (!validate() || amountCents === null) return;
    // An edit already has a stable id; a NEW expense used to mint one inside
    // the call, so a double click wrote the same cost twice and neither the
    // server's idempotency nor `disabled={busy}` could tell. See
    // `lib/writeOnce.ts`.
    const intent = ["gasto", expense?.id ?? "nuevo", target, concept.trim(),
                    amountCents, date, activityId, plotId, plotCropId].join("|");
    const outcome = await runOnce(intent, async (mint) => {
      setError(null);
      const id = expense?.id ?? mint();
      const common = { id, concept: concept.trim(), amountCents, date, note: note.trim() || null };
      const body: ExpenseInput =
        target === "activity"
          ? { ...common, target: "activity", activityId }
          : { ...common, target: "plot", plotId, plotCropId: plotCropId || null };
      return expense ? api.updateExpense(expense.id, body) : api.createExpense(body);
    }).catch((e: unknown) => {
      setError(messageFor(e));
      return { ran: false } as const;
    });
    if (!outcome.ran) return;
    onSaved(outcome.value);
  }

  return (
    <Dialog open={open} onClose={busy ? undefined : onClose} maxWidth="sm" fullWidth>
      <DialogTitle>{expense ? "Modificar gasto" : "Registrar gasto"}</DialogTitle>
      <DialogContent>
        {error && (
          <Alert severity="error" sx={{ mb: 2 }}>
            {error}
          </Alert>
        )}
        <Stack spacing={2.5} sx={{ mt: 1 }}>
          <TextField
            label="En qué se gastó"
            value={concept}
            onChange={(e) => setConcept(e.target.value)}
            error={!!fields.concept}
            helperText={fields.concept ?? "Fungicida, transporte, arriendo de la despulpadora…"}
            fullWidth
            required
            autoFocus
          />

          <Stack direction={{ xs: "column", sm: "row" }} spacing={2}>
            <TextField
              label="Valor"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              error={!!fields.amount}
              helperText={fields.amount}
              inputMode="decimal"
              fullWidth
              required
            />
            <DateField label="Fecha" value={date} onChange={setDate} />
          </Stack>

          <FormControl>
            <FormLabel id="tipo-de-gasto">Tipo de gasto</FormLabel>
            <RadioGroup
              row
              aria-labelledby="tipo-de-gasto"
              value={target}
              onChange={(e) => setTarget(e.target.value as ExpenseTarget)}
            >
              <FormControlLabel value="activity" control={<Radio />} label="Actividad" />
              <FormControlLabel value="plot" control={<Radio />} label="Lote / cultivo" />
            </RadioGroup>
            <Typography variant="caption" color="text.secondary">
              Un gasto se carga a una actividad o a un lote, nunca a las dos cosas ni a
              ninguna: si no, el total no cuadra con la suma de las partes.
            </Typography>
          </FormControl>

          {/* Only the fields of the chosen type exist. Not disabled — absent —
              so there is nothing left holding a value that could travel. */}
          {target === "activity" ? (
            <TextField
              select
              label="Actividad"
              value={activityId}
              onChange={(e) => setActivityId(e.target.value)}
              error={!!fields.activity}
              helperText={fields.activity}
              fullWidth
              required
            >
              {activities.map((a) => (
                <MenuItem key={a.id} value={a.id}>
                  {a.name}
                  {a.category ? ` · ${a.category}` : ""}
                </MenuItem>
              ))}
            </TextField>
          ) : (
            <Stack direction={{ xs: "column", sm: "row" }} spacing={2}>
              <TextField
                select
                label="Lote"
                value={plotId}
                onChange={(e) => {
                  setPlotId(e.target.value);
                  setPlotCropId("");
                }}
                error={!!fields.plot}
                helperText={fields.plot}
                fullWidth
                required
              >
                {plots.map((p) => (
                  <MenuItem key={p.id} value={p.id}>
                    {p.name}
                  </MenuItem>
                ))}
              </TextField>
              <TextField
                select
                label="Cultivo"
                value={plotCropId}
                onChange={(e) => setPlotCropId(e.target.value)}
                disabled={!plot}
                helperText="Opcional: un arreglo de cerca es de todo el lote."
                fullWidth
              >
                <MenuItem value="">Todo el lote</MenuItem>
                {(plot?.crops ?? []).map((c) => (
                  <MenuItem key={c.id} value={c.id}>
                    {c.cropTypeName}
                    {c.varietyName ? ` · ${c.varietyName}` : ""}
                  </MenuItem>
                ))}
              </TextField>
            </Stack>
          )}

          <TextField
            label="Nota (opcional)"
            value={note}
            onChange={(e) => setNote(e.target.value)}
            fullWidth
          />

          <Typography variant="caption" color="text.secondary">
            Esto es un gasto de la finca. Si lo que quiere es descontarle algo a un
            empleado, eso se registra como deuda en su perfil y sí toca su saldo.
          </Typography>
        </Stack>
      </DialogContent>
      <DialogActions sx={{ px: 3, pb: 2 }}>
        <Button color="inherit" onClick={onClose} disabled={busy}>
          Cancelar
        </Button>
        <Button variant="contained" onClick={save} disabled={busy}>
          {busy ? "Guardando…" : "Guardar gasto"}
        </Button>
      </DialogActions>
    </Dialog>
  );
}
