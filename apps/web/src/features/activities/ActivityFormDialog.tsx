/**
 * RSP-011. The form changes shape with the pay mode, because the three modes
 * genuinely need different data:
 *
 *   unidad de trabajo -> a unit (kg, arroba, canasta) and a price per unit
 *   unidad de tiempo  -> a period (jornal, semanal, ...) and a price per period
 *   contrato          -> a single total, and no unit at all
 *
 * The price field is the owner's alone (sync-and-roles.md): an administrator
 * can create the activity and cannot decide what it pays.
 */
import { useEffect, useState } from "react";
import {
  Alert, Autocomplete, Button, Dialog, DialogActions, DialogContent, DialogTitle,
  MenuItem, Stack, TextField, ToggleButton, ToggleButtonGroup, Typography,
} from "@mui/material";
import { api } from "../../api/endpoints";
import { messageFor } from "../../api/errors";
import { parseMoneyInput } from "../../lib/money";
import { useWriteOnce } from "../../lib/writeOnce";
import { SEED_ACTIVITY_CATEGORIES } from "../../api/types";
import type { Activity, ActivityCategory, PayMode, TimeUnit } from "../../api/types";

const WORK_UNITS = ["kg", "arroba", "canasta", "bulto", "caja"];
const TIME_UNITS: Array<{ value: TimeUnit; label: string }> = [
  { value: "jornal", label: "Jornal (día)" },
  { value: "semanal", label: "Semanal" },
  { value: "quincenal", label: "Quincenal" },
  { value: "mensual", label: "Mensual" },
];

export function ActivityFormDialog({
  open, activity, canSetRate, knownCategories = [], onClose, onSaved,
}: {
  open: boolean;
  activity: Activity | null;
  canSetRate: boolean;
  /** Categories already in use in this farm, merged with the seed. */
  knownCategories?: string[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const [name, setName] = useState("");
  const [category, setCategory] = useState<ActivityCategory>("cosecha");
  const [payMode, setPayMode] = useState<PayMode>("work_unit");
  const [workUnit, setWorkUnit] = useState("kg");
  const [timeUnit, setTimeUnit] = useState<TimeUnit>("jornal");
  const [weekly, setWeekly] = useState(false);
  const [rate, setRate] = useState("");
  const [validFrom, setValidFrom] = useState(new Date().toISOString().slice(0, 10));
  const [fields, setFields] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const { busy, run: runOnce } = useWriteOnce();

  useEffect(() => {
    if (!open) return;
    setError(null);
    setFields({});
    if (activity) {
      setName(activity.name);
      setCategory(activity.category);
      setPayMode(activity.payMode);
      setWorkUnit(activity.workUnit ?? "kg");
      setTimeUnit(activity.timeUnit ?? "jornal");
      setWeekly(activity.rateSource === "weekly_price");
      setRate(
        activity.defaultRateCents === undefined
          ? ""
          : String(Math.round(activity.defaultRateCents / 100)),
      );
    } else {
      setName("");
      setCategory("cosecha");
      setPayMode("work_unit");
      setWorkUnit("kg");
      setTimeUnit("jornal");
      setWeekly(false);
      setRate("");
    }
  }, [open, activity]);

  const categoryOptions = [...new Set([...SEED_ACTIVITY_CATEGORIES, ...knownCategories])];
  const rateCents = parseMoneyInput(rate);
  // Only work_unit can take its price from the week; a jornal has no week.
  const canBeWeekly = payMode === "work_unit";

  async function save() {
    const e: Record<string, string> = {};
    if (!name.trim()) e.name = "Escriba el nombre de la actividad.";
    if (!category.trim()) e.category = "Elija o escriba una categoría.";
    if (!weekly || !canBeWeekly) {
      if (rateCents === null) e.rate = "Escriba el precio.";
      else if (rateCents <= 0) e.rate = "El precio tiene que ser mayor que cero.";
    }
    setFields(e);
    if (Object.keys(e).length) return;

    // A new activity used to mint its id inside the call, so a double click
    // created the same activity twice — and every labor priced afterwards had
    // two rows to choose from. See `lib/writeOnce.ts`.
    const intent = ["actividad", activity?.id ?? "nueva", name.trim(), category.trim(),
                    payMode, rateCents, validFrom].join("|");
    const outcome = await runOnce(intent, async (mint) => {
      setError(null);
      const useWeekly = weekly && canBeWeekly;
      const body = {
        id: activity?.id ?? mint(),
        name: name.trim(),
        category: category.trim(),
        payMode,
        workUnit: payMode === "work_unit" ? workUnit : null,
        timeUnit: payMode === "time_unit" ? timeUnit : null,
        rateSource: useWeekly ? ("weekly_price" as const) : ("fixed" as const),
        defaultRateCents: useWeekly ? null : rateCents,
        validFrom,
      };
      if (activity) await api.updateActivity(activity.id, body);
      else await api.createActivity(body);
    }).catch((err: unknown) => {
      setError(messageFor(err));
      return { ran: false } as const;
    });
    if (!outcome.ran) return;
    onSaved();
  }

  return (
    <Dialog open={open} onClose={busy ? undefined : onClose} maxWidth="sm" fullWidth>
      <DialogTitle>{activity ? "Modificar actividad" : "Nueva actividad"}</DialogTitle>
      <DialogContent>
        <Stack spacing={2.5} sx={{ mt: 1 }}>
          {error && <Alert severity="error">{error}</Alert>}
          <TextField
            label="Nombre"
            value={name}
            onChange={(e) => setName(e.target.value)}
            error={!!fields.name}
            helperText={fields.name}
            size="medium"
            fullWidth
            autoFocus
          />
          {/* Free text over a seeded list, not a closed select: categories are
              a per-farm catalogue and RSP-011 asks for "crear una nueva". */}
          <Autocomplete
            freeSolo
            options={categoryOptions}
            value={category}
            onInputChange={(_, v) => setCategory(v)}
            renderInput={(params) => (
              <TextField
                {...params}
                label="Categoría"
                size="medium"
                helperText="Si no está en la lista, escríbala y se agrega al catálogo de la finca."
              />
            )}
          />

          <div>
            <Typography variant="overline" color="text.secondary" component="div">
              Forma de pago
            </Typography>
            <ToggleButtonGroup
              exclusive
              value={payMode}
              onChange={(_, v) => v && setPayMode(v as PayMode)}
              size="small"
              sx={{ mt: 0.5, flexWrap: "wrap" }}
            >
              <ToggleButton value="work_unit">Unidad de trabajo</ToggleButton>
              <ToggleButton value="time_unit">Unidad de tiempo</ToggleButton>
              <ToggleButton value="contract">Contrato</ToggleButton>
            </ToggleButtonGroup>
          </div>

          {payMode === "work_unit" && (
            <TextField
              select
              label="Unidad"
              value={workUnit}
              onChange={(e) => setWorkUnit(e.target.value)}
              size="medium"
              fullWidth
            >
              {WORK_UNITS.map((u) => (
                <MenuItem key={u} value={u}>
                  {u}
                </MenuItem>
              ))}
            </TextField>
          )}

          {payMode === "time_unit" && (
            <TextField
              select
              label="Período"
              value={timeUnit}
              onChange={(e) => setTimeUnit(e.target.value as TimeUnit)}
              size="medium"
              fullWidth
            >
              {TIME_UNITS.map((u) => (
                <MenuItem key={u.value} value={u.value}>
                  {u.label}
                </MenuItem>
              ))}
            </TextField>
          )}

          {canBeWeekly && (
            <ToggleButtonGroup
              exclusive
              size="small"
              value={weekly ? "weekly" : "fixed"}
              onChange={(_, v) => v && setWeekly(v === "weekly")}
            >
              <ToggleButton value="fixed">Precio fijo</ToggleButton>
              <ToggleButton value="weekly">Precio de la semana</ToggleButton>
            </ToggleButtonGroup>
          )}

          {weekly && canBeWeekly ? (
            <Alert severity="info">
              El precio lo pone la semana, igual que en el teléfono. Se congela al
              liquidar, no al registrar la labor, y por eso una labor de esta
              actividad tiene que ser de <strong>un solo día</strong>.
            </Alert>
          ) : (
            <TextField
              label={
                payMode === "contract"
                  ? "Valor del contrato"
                  : payMode === "time_unit"
                    ? `Precio por ${timeUnit}`
                    : `Precio por ${workUnit}`
              }
              value={rate}
              onChange={(e) => setRate(e.target.value)}
              error={!!fields.rate}
              helperText={
                fields.rate ??
                (canSetRate
                  ? "En pesos. Al cambiarlo se guarda una vigencia nueva."
                  : "Solo el dueño puede fijar precios.")
              }
              disabled={!canSetRate}
              size="medium"
              fullWidth
              inputMode="numeric"
            />
          )}

          {canSetRate && !(weekly && canBeWeekly) && (
            <TextField
              label="Precio vigente desde"
              type="date"
              value={validFrom}
              onChange={(e) => setValidFrom(e.target.value)}
              size="medium"
              fullWidth
              slotProps={{ inputLabel: { shrink: true } }}
              helperText="Las labores anteriores conservan el precio de su fecha."
            />
          )}
        </Stack>
      </DialogContent>
      <DialogActions sx={{ px: 3, pb: 2 }}>
        <Button onClick={onClose} color="inherit" disabled={busy}>
          Cancelar
        </Button>
        <Button onClick={save} variant="contained" disabled={busy}>
          {busy ? "Guardando…" : "Guardar"}
        </Button>
      </DialogActions>
    </Dialog>
  );
}
