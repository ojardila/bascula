/**
 * One-screen harvest weighing: employee, plot, day, kilos.
 *
 * The generic labor form still exists for odd jobs. This page is the
 * day-to-day path for coffee pickers — four fields, large controls, and
 * the weekly-price harvest activity chosen automatically.
 */
import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import {
  Alert,
  Autocomplete,
  Box,
  Button,
  Card,
  CardContent,
  MenuItem,
  Stack,
  TextField,
  Typography,
} from "@mui/material";
import ArrowBackIcon from "@mui/icons-material/ArrowBack";
import { PermissionDenied } from "../../components/Guards";
import { DateField } from "../../components/DateField";
import { api } from "../../api/endpoints";
import { ApiError, messageFor } from "../../api/errors";
import { useAuth } from "../../auth/AuthContext";
import { useWriteOnce } from "../../lib/writeOnce";
import { todayInFarm } from "../../lib/dates";
import type { Activity, Plot, Worker } from "../../api/types";
import {
  emptyDraft,
  parseQuantity,
  quantityLabel,
  validateWorkRecord,
  type FieldErrors,
  type WorkRecordDraft,
} from "./validation";

export function pickHarvestActivity(activities: Activity[]): Activity | null {
  const weekly = activities.filter((a) => a.rateSource === "weekly_price");
  if (weekly.length === 0) return null;
  const named = weekly.find((a) => /recolecci[oó]n/i.test(a.name));
  return named ?? weekly[0];
}

export function RecoleccionFormPage() {
  const navigate = useNavigate();
  const { can, user } = useAuth();
  const timezone = user?.farm?.timezone ?? "America/Bogota";
  const today = todayInFarm(timezone);

  const [workers, setWorkers] = useState<Worker[]>([]);
  const [plots, setPlots] = useState<Plot[]>([]);
  const [activity, setActivity] = useState<Activity | null>(null);
  const [draft, setDraft] = useState<WorkRecordDraft>(() => emptyDraft(today));
  const [errors, setErrors] = useState<FieldErrors>({});
  const [loadError, setLoadError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState<string | null>(null);
  const [denied, setDenied] = useState(false);
  const { busy, run: runOnce } = useWriteOnce();

  useEffect(() => {
    Promise.all([
      api.listWorkers({ status: "active" }),
      api.listPlots({ status: "active" }),
      api.listActivities({ status: "active" }),
    ])
      .then(([w, p, a]) => {
        setWorkers(w);
        setPlots(p);
        const harvest = pickHarvestActivity(a);
        setActivity(harvest);
        setDraft((d) => {
          let next = harvest ? { ...d, activityId: harvest.id } : d;
          if (p.length === 1) {
            const only = p[0];
            next = {
              ...next,
              plotIds: [only.id],
              plotCropIds: only.crops.map((c) => c.id),
            };
          }
          return next;
        });
      })
      .catch((e) => {
        if (e instanceof ApiError && e.isPermissionDenied) setDenied(true);
        else setLoadError(messageFor(e));
      });
  }, []);

  const selectedPlot = useMemo(
    () => plots.find((p) => p.id === draft.plotIds[0]) ?? null,
    [plots, draft.plotIds],
  );

  function selectPlot(plot: Plot | null) {
    if (!plot) {
      setDraft((d) => ({ ...d, plotIds: [], plotCropIds: [] }));
      return;
    }
    setDraft((d) => ({
      ...d,
      plotIds: [plot.id],
      plotCropIds: plot.crops.map((c) => c.id),
    }));
  }

  async function submit(andAnother: boolean) {
    setError(null);
    setSaved(null);
    if (!activity) {
      setError(
        "No hay una actividad de recolección con precio de la semana. Créela en Configuración.",
      );
      return;
    }

    const intent = [
      "recoleccion",
      draft.workerId,
      draft.activityId,
      draft.quantity,
      draft.dateFrom,
      draft.plotIds.join("+"),
      draft.plotCropIds.join("+"),
    ].join("|");

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

    if (!outcome.ran || outcome.value === null) return;
    if (andAnother) {
      setDraft((v) => ({ ...v, workerId: "", quantity: "", note: "" }));
      setSaved("Pesada guardada. Puede registrar la siguiente.");
    } else {
      navigate("/cosecha/revision");
    }
  }

  if (denied || !can("workRecords.write")) {
    return <PermissionDenied moduleName="registrar recolección" />;
  }

  const qtyLabel = activity ? quantityLabel(activity) : "kg";
  const parsedQty = parseQuantity(draft.quantity);

  return (
    <Box sx={{ maxWidth: 560, mx: "auto" }}>
      <Button
        startIcon={<ArrowBackIcon />}
        onClick={() => navigate("/cosecha")}
        color="inherit"
        sx={{ mb: 1 }}
      >
        Cosecha
      </Button>
      <Typography variant="h1" gutterBottom>
        Registrar recolección
      </Typography>
      <Typography variant="body1" color="text.secondary" sx={{ mb: 2 }}>
        Empleado, lote, día y kilos. Una pesada a la vez.
      </Typography>

      {loadError && (
        <Alert severity="error" sx={{ mb: 2 }}>
          {loadError}
        </Alert>
      )}
      {error && (
        <Alert severity="error" sx={{ mb: 2 }}>
          {error}
        </Alert>
      )}
      {saved && (
        <Alert severity="success" sx={{ mb: 2 }}>
          {saved}
        </Alert>
      )}
      {!loadError && !activity && (
        <Alert severity="warning" sx={{ mb: 2 }}>
          No hay actividad de recolección con precio semanal. Configure una en
          actividades antes de pesar.
        </Alert>
      )}

      <Card>
        <CardContent>
          <Stack spacing={2.5}>
            <Autocomplete
              options={workers}
              getOptionLabel={(w) => w.name}
              value={workers.find((w) => w.id === draft.workerId) ?? null}
              onChange={(_, v) => setDraft((d) => ({ ...d, workerId: v?.id ?? "" }))}
              renderInput={(params) => (
                <TextField
                  {...params}
                  label="Empleado"
                  required
                  error={!!errors.workerId}
                  helperText={errors.workerId}
                />
              )}
            />

            <TextField
              select
              label="Lote"
              required
              value={draft.plotIds[0] ?? ""}
              onChange={(e) => {
                const plot = plots.find((p) => p.id === e.target.value) ?? null;
                selectPlot(plot);
              }}
              error={!!errors.plotIds || !!errors.plotCropIds}
              helperText={
                errors.plotIds ||
                errors.plotCropIds ||
                (selectedPlot && selectedPlot.crops.length === 0
                  ? "Este lote no tiene cultivo. Agréguele uno en Lotes."
                  : undefined)
              }
            >
              {plots.map((p) => (
                <MenuItem key={p.id} value={p.id}>
                  {p.name}
                </MenuItem>
              ))}
            </TextField>

            <DateField
              label="Día"
              value={draft.dateFrom}
              onChange={(iso) =>
                setDraft((d) => ({
                  ...d,
                  dateFrom: iso,
                  dateTo: iso,
                }))
              }
              error={!!errors.dateFrom}
              helperText={errors.dateFrom}
              max={today}
              required
            />

            <TextField
              label={`Kilos (${qtyLabel})`}
              required
              value={draft.quantity}
              onChange={(e) => setDraft((d) => ({ ...d, quantity: e.target.value }))}
              error={!!errors.quantity}
              helperText={
                errors.quantity ||
                (parsedQty !== null ? `${parsedQty} ${qtyLabel}` : "Cuántos kilos pesó")
              }
              inputProps={{ inputMode: "decimal", style: { fontSize: "1.25rem" } }}
            />

            <Stack direction={{ xs: "column", sm: "row" }} spacing={1.5} sx={{ pt: 1 }}>
              <Button
                variant="contained"
                size="large"
                disabled={busy || !activity}
                onClick={() => void submit(false)}
                sx={{ flex: 1, py: 1.5, fontSize: "1.1rem" }}
              >
                {busy ? "Guardando…" : "Guardar"}
              </Button>
              <Button
                variant="outlined"
                size="large"
                disabled={busy || !activity}
                onClick={() => void submit(true)}
                sx={{ flex: 1, py: 1.5, fontSize: "1.05rem" }}
              >
                Guardar y otra
              </Button>
            </Stack>
          </Stack>
        </CardContent>
      </Card>
    </Box>
  );
}
