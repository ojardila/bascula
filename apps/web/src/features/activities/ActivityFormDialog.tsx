/**
 * RSP-011. The form changes shape with the pay mode, because the three modes
 * genuinely need different data:
 *
 *   a destajo    -> a unit (kg, arroba, canasta) and a price per unit
 *   al jornal    -> a period (jornal, semanal, ...) and a price per period
 *   por contrato -> a single total, and no unit at all
 *
 * The price field is the owner's alone (sync-and-roles.md): an administrator
 * can create the activity and cannot decide what it pays.
 */
import { useEffect, useState } from "react";
import { Link as RouterLink } from "react-router-dom";
import {
  Alert, Autocomplete, Box, Button, Dialog, DialogActions, DialogContent, DialogTitle,
  Link, MenuItem, Stack, TextField, ToggleButton, ToggleButtonGroup, Typography,
} from "@mui/material";
import { api } from "../../api/endpoints";
import { messageFor } from "../../api/errors";
import { moneyInputValue, parseMoneyInput } from "../../lib/money";
import { useWriteOnce } from "../../lib/writeOnce";
import { SEED_ACTIVITY_CATEGORIES } from "../../api/types";
import { PAY_MODE_CHOICE, TIME_UNIT_LABEL } from "../../lib/vocab";
import type { Activity, ActivityCategory, PayMode, TimeUnit } from "../../api/types";
import { DateField } from "../../components/DateField";

const WORK_UNITS = ["kg", "arroba", "canasta", "bulto", "caja"];
const TIME_UNITS: Array<{ value: TimeUnit; label: string }> = (
  ["jornal", "semanal", "quincenal", "mensual"] as const
).map((value) => ({ value, label: TIME_UNIT_LABEL[value] }));

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
      // The same silent rounding as in expenses, and here it lands on an
      // activity's price: opening and saving shifted the cents of everything
      // settled afterwards. See `lib/money.ts`.
      setRate(
        activity.defaultRateCents === undefined
          ? ""
          : moneyInputValue(activity.defaultRateCents),
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
  /**
   * On an activity that already exists, the pay mode and the price source are
   * not touched. That is not this screen's decision: the server rejects them
   * and `api.updateActivity` does not even send them, because the work items
   * already written are nailed to (activityId, payScheme) by a composite key.
   * What was here before was worse than a lock: two switches that moved on
   * screen and changed nothing on the server.
   */
  const locked = activity !== null;

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
      if (activity) {
        await api.updateActivity(activity.id, body);
        /**
         * ── THE PRICE THAT WAS WRITTEN INTO THIN AIR ────────────────────
         *
         * `updateActivity` only sends `name` and `category` — deliberately:
         * the pay scheme is nailed to the work items already written. But the
         * price box stayed editable and its helper text promised "changing it
         * saves a new effective period", and none was saved: you typed a
         * number, hit Save, nothing failed and nothing changed.
         *
         * The price CAN be changed, through its own call, which opens a new
         * effective period and leaves earlier work items on the price of
         * their own date. That is the call that was missing.
         */
        const changed = !useWeekly && rateCents !== null && rateCents !== activity.defaultRateCents;
        if (changed && canSetRate) await api.setActivityRate(activity.id, rateCents, validFrom);
      } else {
        await api.createActivity(body);
      }
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
              Cómo se paga este trabajo
            </Typography>
            {/* The two buttons that decide HOW PEOPLE GET PAID used to be
                called "Unidad de trabajo" and "Unidad de tiempo", which are
                database column names. The words live in `lib/vocab.ts`; the
                values that get stored do not change. */}
            <ToggleButtonGroup
              exclusive
              value={payMode}
              onChange={(_, v) => v && setPayMode(v as PayMode)}
              size="small"
              disabled={locked}
              sx={{ mt: 0.5, flexWrap: "wrap" }}
            >
              <ToggleButton value="work_unit">{PAY_MODE_CHOICE.work_unit}</ToggleButton>
              <ToggleButton value="time_unit">{PAY_MODE_CHOICE.time_unit}</ToggleButton>
              <ToggleButton value="contract">{PAY_MODE_CHOICE.contract}</ToggleButton>
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
            <div>
              <Typography variant="overline" color="text.secondary" component="div">
                De dónde sale el precio
              </Typography>
              <ToggleButtonGroup
                exclusive
                size="small"
                value={weekly ? "weekly" : "fixed"}
                onChange={(_, v) => v && setWeekly(v === "weekly")}
                disabled={locked}
                sx={{ mt: 0.5, flexWrap: "wrap" }}
              >
                <ToggleButton value="weekly">Lo pone el precio de la semana</ToggleButton>
                <ToggleButton value="fixed">Precio fijo de esta actividad</ToggleButton>
              </ToggleButtonGroup>
            </div>
          )}

          {/* ── THE TRAP, SHUT ────────────────────────────────────────────
              Anyone hunting for where to raise the week's price per kilo
              landed here, hit "Precio fijo" — because that is where a price
              box does appear — typed 900 and saved, believing they had raised
              the week's price. What they did was change the PAY MODE for all
              of the farm's coffee picking and cut it loose from the weekly
              price the phone still uses. Nothing warned them.

              Two things shut it. One: on an activity that already exists the
              switch cannot be moved, because the server will not have it
              either — `updateActivity` only sends name and category, and the
              work items already written are nailed to (activityId, payScheme)
              by a composite key. Before, the switch moved on screen and
              nothing happened, which is worse than not letting it move: the
              person walks away believing they changed something. And two: the
              warning says, with the link right there, where the week's price
              per kilo actually lives. */}
          {locked && (
            <Alert severity="info" variant="outlined">
              La forma de pago y el origen del precio <strong>no se cambian</strong> en una
              actividad que ya existe: las labores ya registradas quedaron pagadas con
              esas reglas y reescribirlas cambiaría plata del pasado. Si esta actividad
              debe pagarse de otra forma, cree una actividad nueva y dé de baja ésta.
            </Alert>
          )}

          {/* And the serious warning on the other side of the switch: on a
              NEW activity you can choose, and choosing a fixed price for
              coffee picking is exactly what cuts the farm loose from the
              weekly price. Say it before saving, not after. */}
          {!locked && canBeWeekly && !weekly && (
            <Alert severity="warning">
              <strong>Este precio no es el del kilo de la semana.</strong> Con precio fijo,
              esta actividad se paga siempre a lo que usted escriba abajo y{" "}
              <strong>deja de seguir el precio semanal</strong> que usa el teléfono. Para
              la recolección de café eso casi nunca es lo que se quiere: el kilo de la
              semana se pone en{" "}
              <Link component={RouterLink} to="/precio-semana" sx={{ fontWeight: 700 }}>
                Precio del kilo
              </Link>
              .
            </Alert>
          )}

          {weekly && canBeWeekly ? (
            <Alert severity="info">
              El precio lo pone la semana, igual que en el teléfono. Se congela al
              liquidar, no al registrar la labor, y por eso una labor de esta
              actividad tiene que ser de <strong>un solo día</strong>.
              <Box sx={{ mt: 1 }}>
                <strong>Aquí no se cambia el precio del kilo.</strong> Ese se pone semana
                por semana en{" "}
                <Link component={RouterLink} to="/precio-semana" sx={{ fontWeight: 700 }}>
                  Precio del kilo
                </Link>
                .
              </Box>
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
            <DateField
              label="Precio vigente desde"
              value={validFrom}
              onChange={setValidFrom}
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
