/**
 * RSP-015, the wireframe of `docs/diagramas/web.md` §8.2, in three numbered
 * blocks: what work, who and where, how much and when.
 *
 * The read-only grey card under the activity is required by RSP-015 and does
 * real work: it is where the person finds out that this activity is paid by
 * the week and therefore gets one day, before they type anything.
 *
 * Validation lives in ./validation.ts, not here, and the tests walk it. What
 * is left in this file is layout and state.
 */
import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import {
  Alert, Autocomplete, Box, Button, Card, CardContent, Chip, Grid, MenuItem,
  Stack, TextField, Typography,
} from "@mui/material";
import ArrowBackIcon from "@mui/icons-material/ArrowBack";
import InfoOutlinedIcon from "@mui/icons-material/InfoOutlined";
import { Money } from "../../components/Money";
import { PermissionDenied } from "../../components/Guards";
import { api } from "../../api/endpoints";
import { ApiError, messageFor } from "../../api/errors";
import { useAuth } from "../../auth/AuthContext";
import { useWriteOnce } from "../../lib/writeOnce";
import { formatMonday, mondayOf, todayInFarm } from "../../lib/dates";
import { parseMoneyInput } from "../../lib/money";
import {
  emptyDraft, estimateCents, forcesSingleDay, needsQuantity, needsRateField,
  parseQuantity, quantityLabel, validateWorkRecord,
  type FieldErrors, type WorkRecordDraft,
} from "./validation";
import { PAY_MODE_LABEL } from "../../lib/vocab";
import type { Activity, Plot, Worker } from "../../api/types";
import { DateField } from "../../components/DateField";

export function WorkRecordFormPage() {
  const navigate = useNavigate();
  const { can, user } = useAuth();
  const timezone = user?.farm?.timezone ?? "America/Bogota";
  const today = todayInFarm(timezone);

  const [activities, setActivities] = useState<Activity[]>([]);
  const [workers, setWorkers] = useState<Worker[]>([]);
  const [plots, setPlots] = useState<Plot[]>([]);
  const [weekPriceCents, setWeekPriceCents] = useState<number | null>(null);

  const [category, setCategory] = useState<string>("");
  const [draft, setDraft] = useState<WorkRecordDraft>(() => emptyDraft(today));
  const [rateText, setRateText] = useState("");
  const [errors, setErrors] = useState<FieldErrors>({});
  const [error, setError] = useState<string | null>(null);
  const { busy, run: runOnce } = useWriteOnce();
  const [saved, setSaved] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [denied, setDenied] = useState(false);

  useEffect(() => {
    Promise.all([
      api.listActivities({ status: "active" }),
      api.listWorkers({ status: "active" }),
      api.listPlots({ status: "active" }),
    ])
      .then(([a, w, p]) => {
        setActivities(a);
        setWorkers(w);
        setPlots(p);
      })
      .catch((e) => {
        if (e instanceof ApiError && e.isPermissionDenied) setDenied(true);
        else setLoadError(messageFor(e));
      });
  }, []);

  const activity = useMemo(
    () => activities.find((a) => a.id === draft.activityId) ?? null,
    [activities, draft.activityId],
  );

  // The weekly price is fetched for the Monday of the chosen date, because it
  // is what the record will actually be worth — it is not the activity's.
  useEffect(() => {
    if (!activity || activity.rateSource !== "weekly_price" || !draft.dateFrom) {
      setWeekPriceCents(null);
      return;
    }
    let cancelled = false;
    api
      .weekPrice(mondayOf(draft.dateFrom))
      .then((p) => {
        if (!cancelled) setWeekPriceCents(p.costPerUnitCents);
      })
      .catch(() => {
        if (!cancelled) setWeekPriceCents(null);
      });
    return () => {
      cancelled = true;
    };
  }, [activity, draft.dateFrom]);

  // Selecting an activity resets the price field to the activity's default.
  useEffect(() => {
    if (!activity) return;
    if (needsRateField(activity)) {
      const d = activity.defaultRateCents;
      setRateText(d === undefined ? "" : String(Math.round(d / 100)));
      setDraft((v) => ({ ...v, rateCents: d ?? null }));
    } else {
      setRateText("");
      setDraft((v) => ({ ...v, rateCents: null }));
    }
  }, [activity]);

  const categories = useMemo(
    () => [...new Set(activities.map((a) => a.category))],
    [activities],
  );

  const shown = activities.filter((a) => !category || a.category === category);
  const selectedPlots = plots.filter((p) => draft.plotIds.includes(p.id));
  const availableCrops = selectedPlots.flatMap((p) =>
    p.crops.map((c) => ({
      ...c,
      label: `${p.name} · ${[c.cropTypeName, c.varietyName].filter(Boolean).join(" ")}`,
    })),
  );

  const effectiveRate =
    activity && !needsRateField(activity) ? weekPriceCents : draft.rateCents;
  const estimate = activity
    ? estimateCents(activity, parseQuantity(draft.quantity), effectiveRate)
    : null;

  async function submit(andAnother: boolean) {
    setError(null);
    setSaved(null);
    /**
     * The id used to be minted here, fresh on every press. A double click
     * therefore registered the SAME work twice under two ids — two labores to
     * pay for one afternoon's picking — and the server, seeing two different
     * ids, was right to accept both. `useWriteOnce` mints it once per version
     * of this form and lets a retry be a retry. See `lib/writeOnce.ts`.
     */
    const intent = ["labor", draft.workerId, draft.activityId, draft.quantity,
                    draft.dateFrom, draft.dateTo, draft.rateCents,
                    [...draft.plotIds].sort().join("+"),
                    [...draft.plotCropIds].sort().join("+")].join("|");

    const outcome = await runOnce(intent, async (mint) => {
      const result = validateWorkRecord(draft, activity, mint());
      setErrors(result.errors);
      if (!result.valid || !result.input) return null;
      return api.createWorkRecord(result.input);
    }).catch((e: unknown) => {
      if (e instanceof ApiError && Object.keys(e.fieldErrors).length) {
        setErrors(e.fieldErrors as FieldErrors);
      }
      setError(messageFor(e));
      return { ran: false } as const;
    });

    // `value === null` is a form that did not validate: no request left the
    // browser, so there is nothing to report and nothing to keep.
    if (!outcome.ran || outcome.value === null) return;
    if (andAnother) {
      // Keep activity, plots, crops and date: a picker registers ten of these
      // in a row, and only the worker and the quantity change.
      setDraft((v) => ({ ...v, workerId: "", quantity: "", note: "" }));
      setSaved("Labor guardada. Puede registrar la siguiente.");
    } else {
      navigate("/labores");
    }
  }

  if (denied || !can("workRecords.write")) {
    return <PermissionDenied moduleName="registrar labores" />;
  }

  return (
    <Box>
      <Button
        startIcon={<ArrowBackIcon />}
        onClick={() => navigate("/labores")}
        color="inherit"
        sx={{ mb: 1 }}
      >
        Labores
      </Button>
      <Typography variant="h1" gutterBottom>
        Registrar labor
      </Typography>

      {loadError && <Alert severity="error" sx={{ mb: 2 }}>{loadError}</Alert>}
      {error && <Alert severity="error" sx={{ mb: 2 }}>{error}</Alert>}
      {saved && <Alert severity="success" sx={{ mb: 2 }}>{saved}</Alert>}

      <Card sx={{ mb: 3 }}>
        <CardContent>
          <Typography variant="overline" color="text.secondary">
            1 · Actividad
          </Typography>
          <Grid container spacing={2} sx={{ mt: 0.5 }}>
            <Grid size={{ xs: 12, sm: 5 }}>
              <TextField
                select
                label="Categoría"
                value={category}
                onChange={(e) => {
                  setCategory(e.target.value);
                  setDraft((v) => ({ ...v, activityId: "" }));
                }}
                size="medium"
                fullWidth
              >
                <MenuItem value="">Todas</MenuItem>
                {categories.map((c) => (
                  <MenuItem key={c} value={c}>
                    {c[0].toUpperCase() + c.slice(1)}
                  </MenuItem>
                ))}
              </TextField>
            </Grid>
            <Grid size={{ xs: 12, sm: 7 }}>
              <TextField
                select
                label="Actividad"
                value={draft.activityId}
                onChange={(e) => setDraft((v) => ({ ...v, activityId: e.target.value }))}
                error={!!errors.activityId}
                helperText={errors.activityId}
                size="medium"
                fullWidth
                required
              >
                {shown.map((a) => (
                  <MenuItem key={a.id} value={a.id}>
                    {a.name}
                  </MenuItem>
                ))}
              </TextField>
            </Grid>
          </Grid>

          {activity && (
            <Box sx={{ mt: 2, p: 2, bgcolor: "#f2f5f0", borderRadius: 2 }}>
              <Stack direction="row" spacing={1} alignItems="center" flexWrap="wrap" useFlexGap>
                <Typography sx={{ fontWeight: 700 }}>{activity.name}</Typography>
                <Chip
                  size="small"
                  /* This used to read "pago por unidad de trabajo", which is
                     a column name. See `lib/vocab.ts`. */
                  label={
                    activity.payMode === "work_unit"
                      ? `${PAY_MODE_LABEL.work_unit} · ${activity.workUnit}`
                      : activity.payMode === "time_unit"
                        ? `${PAY_MODE_LABEL.time_unit} · ${activity.timeUnit}`
                        : PAY_MODE_LABEL.contract
                  }
                />
              </Stack>
              {activity.rateSource === "weekly_price" ? (
                <>
                  <Typography variant="body2" sx={{ mt: 1 }}>
                    Precio de la semana del {formatMonday(mondayOf(draft.dateFrom || today))}:{" "}
                    {weekPriceCents === null ? (
                      "—"
                    ) : (
                      <Money cents={weekPriceCents} variant="small" />
                    )}{" "}
                    / {activity.workUnit}
                  </Typography>
                  <Stack direction="row" spacing={1} sx={{ mt: 1 }} alignItems="flex-start">
                    <InfoOutlinedIcon fontSize="small" color="warning" />
                    <Typography variant="body2" color="text.secondary">
                      Esta actividad usa <strong>precio semanal</strong>: se registra por
                      día y el valor se congela al liquidar, no ahora.
                    </Typography>
                  </Stack>
                </>
              ) : (
                <Typography variant="body2" color="text.secondary" sx={{ mt: 1 }}>
                  El precio queda congelado en la labor al guardarla.
                </Typography>
              )}
            </Box>
          )}
        </CardContent>
      </Card>

      <Card sx={{ mb: 3 }}>
        <CardContent>
          <Typography variant="overline" color="text.secondary">
            2 · Quién y dónde
          </Typography>
          <Stack spacing={2.5} sx={{ mt: 1.5 }}>
            <Autocomplete
              options={workers}
              getOptionLabel={(w) =>
                `${w.name} ${w.lastName}${w.documentNumber ? ` · ${w.documentType} ${w.documentNumber}` : ""}`
              }
              value={workers.find((w) => w.id === draft.workerId) ?? null}
              onChange={(_, v) => setDraft((d) => ({ ...d, workerId: v?.id ?? "" }))}
              renderInput={(params) => (
                <TextField
                  {...params}
                  label="Empleado"
                  size="medium"
                  required
                  error={!!errors.workerId}
                  helperText={errors.workerId}
                />
              )}
            />
            <Autocomplete
              multiple
              options={plots}
              getOptionLabel={(p) => p.name}
              value={selectedPlots}
              onChange={(_, v) =>
                setDraft((d) => {
                  const ids = v.map((p) => p.id);
                  const stillValid = v.flatMap((p) => p.crops.map((c) => c.id));
                  return {
                    ...d,
                    plotIds: ids,
                    // Dropping a plot has to drop its crops, or the record
                    // ends up pointing at a crop of a plot it does not touch.
                    plotCropIds: d.plotCropIds.filter((c) => stillValid.includes(c)),
                  };
                })
              }
              renderInput={(params) => (
                <TextField
                  {...params}
                  label="Lotes"
                  size="medium"
                  required
                  error={!!errors.plotIds}
                  helperText={errors.plotIds}
                />
              )}
            />
            <Autocomplete
              multiple
              disabled={selectedPlots.length === 0}
              options={availableCrops}
              getOptionLabel={(c) => c.label}
              isOptionEqualToValue={(a, b) => a.id === b.id}
              value={availableCrops.filter((c) => draft.plotCropIds.includes(c.id))}
              onChange={(_, v) =>
                setDraft((d) => ({ ...d, plotCropIds: v.map((c) => c.id) }))
              }
              renderInput={(params) => (
                <TextField
                  {...params}
                  label="Cultivos"
                  size="medium"
                  required
                  error={!!errors.plotCropIds}
                  helperText={
                    errors.plotCropIds ??
                    (selectedPlots.length === 0 ? "Elija primero los lotes." : undefined)
                  }
                />
              )}
            />
          </Stack>
        </CardContent>
      </Card>

      <Card>
        <CardContent>
          <Typography variant="overline" color="text.secondary">
            3 · Cuánto y cuándo
          </Typography>
          <Grid container spacing={2} sx={{ mt: 0.5 }}>
            {activity && needsQuantity(activity) && (
              <Grid size={{ xs: 12, sm: 3 }}>
                <TextField
                  label={`Cantidad (${quantityLabel(activity)})`}
                  value={draft.quantity}
                  onChange={(e) => setDraft((d) => ({ ...d, quantity: e.target.value }))}
                  error={!!errors.quantity}
                  helperText={errors.quantity}
                  size="medium"
                  fullWidth
                  required
                  inputMode="decimal"
                />
              </Grid>
            )}
            {activity && needsRateField(activity) && (
              <Grid size={{ xs: 12, sm: 3 }}>
                <TextField
                  label={activity.payMode === "contract" ? "Valor del contrato" : "Precio"}
                  value={rateText}
                  onChange={(e) => {
                    setRateText(e.target.value);
                    setDraft((d) => ({ ...d, rateCents: parseMoneyInput(e.target.value) }));
                  }}
                  error={!!errors.rateCents}
                  helperText={
                    errors.rateCents ??
                    (can("activities.setRate")
                      ? "Por defecto, el de la actividad."
                      : "Solo el dueño puede cambiarlo.")
                  }
                  disabled={!can("activities.setRate")}
                  size="medium"
                  fullWidth
                  inputMode="numeric"
                />
              </Grid>
            )}
            <Grid size={{ xs: 12, sm: 3 }}>
              <DateField
                label="Fecha"
                value={draft.dateFrom}
                onChange={(iso) =>
                  setDraft((d) => ({
                    ...d,
                    dateFrom: iso,
                    dateTo:
                      activity && forcesSingleDay(activity)
                        ? iso
                        : d.dateTo < iso
                          ? iso
                          : d.dateTo,
                  }))
                }
                error={!!errors.dateFrom}
                helperText={errors.dateFrom}
                required
              />
            </Grid>
            <Grid size={{ xs: 12, sm: 3 }}>
              <DateField
                label="Hasta"
                value={activity && forcesSingleDay(activity) ? draft.dateFrom : draft.dateTo}
                onChange={(iso) => setDraft((d) => ({ ...d, dateTo: iso }))}
                disabled={!activity || forcesSingleDay(activity)}
                error={!!errors.dateTo}
                helperText={
                  errors.dateTo ??
                  (activity && forcesSingleDay(activity)
                    ? "Un solo día: precio semanal."
                    : undefined)
                }
                min={draft.dateFrom || undefined}
              />
            </Grid>
            <Grid size={12}>
              <TextField
                label="Nota"
                value={draft.note}
                onChange={(e) => setDraft((d) => ({ ...d, note: e.target.value }))}
                size="medium"
                fullWidth
              />
            </Grid>
          </Grid>

          {can("money.read") && estimate !== null && (
            <Box sx={{ mt: 2.5, p: 2, borderRadius: 2, border: 1, borderColor: "divider" }}>
              <Typography variant="body2" color="text.secondary">
                Valor provisional
              </Typography>
              <Money cents={estimate} variant="big" />
              {activity && !needsRateField(activity) && (
                <Typography variant="caption" color="text.secondary" component="div">
                  Todavía no está liquidado: se escribe en el libro al liquidar, con el
                  precio de esa semana.
                </Typography>
              )}
            </Box>
          )}
        </CardContent>
      </Card>

      <Stack direction="row" spacing={2} sx={{ mt: 3 }} justifyContent="flex-end">
        <Button color="inherit" onClick={() => navigate("/labores")}>
          Cancelar
        </Button>
        <Button variant="outlined" disabled={busy} onClick={() => submit(true)}>
          Guardar y registrar otra
        </Button>
        <Button variant="contained" disabled={busy} onClick={() => submit(false)}>
          {busy ? "Guardando…" : "Guardar"}
        </Button>
      </Stack>
    </Box>
  );
}
