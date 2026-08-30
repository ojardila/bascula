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
      // El mismo redondeo callado que el de los gastos, y aquí sobre el
      // precio de una actividad: abrir y guardar movía los centavos de todo lo
      // que se liquide después. Ver `lib/money.ts`.
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
   * En una actividad que ya existe, la forma de pago y el origen del precio no
   * se tocan. No es una decisión de esta pantalla: el servidor los rechaza y
   * `api.updateActivity` ni siquiera los manda, porque las labores escritas
   * están clavadas a (activityId, payScheme) por una clave compuesta. Lo que
   * había antes era peor que un candado: dos interruptores que se movían en
   * pantalla y no cambiaban nada en el servidor.
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
         * ── EL PRECIO QUE SE ESCRIBÍA EN EL AIRE ────────────────────────
         *
         * `updateActivity` sólo manda `name` y `category` — a propósito: el
         * esquema de pago está clavado a las labores ya escritas. Pero la
         * casilla de precio seguía editable y su ayuda prometía «al cambiarlo
         * se guarda una vigencia nueva», y no se guardaba ninguna: se escribía
         * un número, se pulsaba Guardar, no fallaba nada y no cambiaba nada.
         *
         * El precio SÍ se puede cambiar, por su propia ruta, que abre una
         * vigencia nueva y deja las labores anteriores con el precio de su
         * fecha. Es la llamada que faltaba.
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
            {/* Los dos botones que deciden CÓMO SE LE PAGA A LA GENTE se
                llamaban «Unidad de trabajo» y «Unidad de tiempo», que son
                nombres de columna de base de datos. Las palabras están en
                `lib/vocab.ts`; los valores que se guardan no cambian. */}
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

          {/* ── LA TRAMPA, CERRADA ────────────────────────────────────────
              Quien buscaba dónde subir el kilo de la semana llegaba aquí,
              pulsaba «Precio fijo» —porque ahí sí sale una casilla de
              precio—, escribía 900 y guardaba, creyendo que había subido el
              precio de la semana. Lo que hacía era cambiar la FORMA DE PAGO
              de toda la recolección de la finca y desconectarla del precio
              semanal que el teléfono sigue usando. Nada lo avisaba.

              Dos cosas lo cierran. Una: en una actividad que ya existe el
              interruptor no se toca, porque el servidor tampoco lo deja —
              `updateActivity` sólo manda nombre y categoría, y las labores ya
              escritas están clavadas a (activityId, payScheme) por una clave
              compuesta. Antes el interruptor se movía en pantalla y no pasaba
              nada, que es peor que no dejarlo mover: la persona se va creyendo
              que cambió algo. Y dos: el aviso dice, con el enlace puesto,
              dónde está de verdad el precio del kilo de la semana. */}
          {locked && (
            <Alert severity="info" variant="outlined">
              La forma de pago y el origen del precio <strong>no se cambian</strong> en una
              actividad que ya existe: las labores ya registradas quedaron pagadas con
              esas reglas y reescribirlas cambiaría plata del pasado. Si esta actividad
              debe pagarse de otra forma, cree una actividad nueva y dé de baja ésta.
            </Alert>
          )}

          {/* Y el aviso serio en el otro lado del interruptor: en una
              actividad NUEVA sí se puede elegir, y elegir «precio fijo» para
              la recolección es exactamente lo que desconecta la finca del
              precio semanal. Se dice antes de guardar, no después. */}
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
