/**
 * Two ways to weigh: everyone on the lote (masiva) or one person at a time.
 */
import { useEffect, useState } from "react";
import { Link as RouterLink, useSearchParams } from "react-router-dom";
import {
  Alert, Autocomplete, Box, Button, Card, CardContent, MenuItem, Stack, Tab, Tabs,
  TextField, Typography,
} from "@mui/material";
import ArrowBackIcon from "@mui/icons-material/ArrowBack";
import { DateField } from "../../components/DateField";
import { PermissionDenied } from "../../components/Guards";
import { api } from "../../api/endpoints";
import { ApiError, messageFor } from "../../api/errors";
import { useAuth } from "../../auth/AuthContext";
import { useWriteOnce } from "../../lib/writeOnce";
import { todayInFarm } from "../../lib/dates";
import { uuidv7 } from "../../lib/uuid";
import { PLOT } from "../../lib/vocab";
import type { Activity, Plot, Worker } from "../../api/types";
import { parseQuantity } from "./validation";
import { pickHarvestActivity, workerLabel } from "./planilla";
import { PlanillaPage } from "./PlanillaPage";

export { pickHarvestActivity } from "./planilla";

export function RecoleccionFormPage() {
  const { can } = useAuth();
  const [params, setParams] = useSearchParams();
  const quien = params.get("quien") === "uno" ? "uno" : "todos";

  if (!can("workRecords.write")) {
    return <PermissionDenied moduleName="registrar recolección" />;
  }

  return (
    <Box>
      <Button
        component={RouterLink}
        to="/cosecha"
        startIcon={<ArrowBackIcon />}
        size="small"
        sx={{ mb: 2 }}
      >
        Volver a la cosecha
      </Button>
      <Typography variant="h1" gutterBottom>
        Registrar recolección
      </Typography>
      <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
        Masiva: todos los de un lote, un día. Una persona: una pesada y sigue.
      </Typography>
      <Tabs
        value={quien}
        onChange={(_, v: "todos" | "uno") => {
          setParams((prev) => {
            const n = new URLSearchParams(prev);
            if (v === "uno") n.set("quien", "uno");
            else n.delete("quien");
            return n;
          });
        }}
        sx={{ mb: 2 }}
      >
        <Tab value="todos" label="Masiva" />
        <Tab value="uno" label="Una persona" />
      </Tabs>
      {quien === "uno" ? <UnaPersona /> : <PlanillaPage lockedMode="dia" hideChrome />}
    </Box>
  );
}

function UnaPersona() {
  const { user } = useAuth();
  const today = todayInFarm(user?.farm?.timezone ?? "America/Bogota");
  const { busy, run } = useWriteOnce();
  const [workers, setWorkers] = useState<Worker[] | null>(null);
  const [plots, setPlots] = useState<Plot[] | null>(null);
  const [activity, setActivity] = useState<Activity | null>(null);
  const [worker, setWorker] = useState<Worker | null>(null);
  const [plotId, setPlotId] = useState("");
  const [day, setDay] = useState(today);
  const [kg, setKg] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState<string | null>(null);

  useEffect(() => {
    Promise.all([
      api.listWorkers({ status: "active" }),
      api.listPlots({ status: "active" }),
      api.listActivities({ status: "active" }),
    ])
      .then(([w, p, a]) => {
        setWorkers(w);
        setPlots(p);
        setActivity(pickHarvestActivity(a));
        if (p.length === 1) setPlotId(p[0].id);
      })
      .catch((e) => setError(messageFor(e)));
  }, []);

  async function save() {
    setError(null);
    setSaved(null);
    if (!worker) {
      setError("Elija a la persona.");
      return;
    }
    if (!plotId) {
      setError("Elija el lote.");
      return;
    }
    const qty = parseQuantity(kg);
    if (qty === null || qty <= 0) {
      setError("Escriba los kilos.");
      return;
    }
    if (!activity) {
      setError("No hay actividad de recolección.");
      return;
    }
    const plot = plots?.find((p) => p.id === plotId);
    const outcome = await run(`uno|${worker.id}|${plotId}|${day}|${qty}`, async () => {
      await api.createWorkRecord({
        id: uuidv7(),
        activityId: activity.id,
        workerId: worker.id,
        quantity: qty,
        dateFrom: day,
        dateTo: day,
        plotIds: [plotId],
        plotCropIds: plot?.crops.map((c) => c.id) ?? [],
      });
      return qty;
    }).catch((e: unknown) => {
      if (e instanceof ApiError) setError(messageFor(e));
      else setError(messageFor(e));
      return { ran: false } as const;
    });
    if (!outcome.ran) return;
    setSaved(`${workerLabel(worker)}: ${qty} kg`);
    setKg("");
  }

  return (
    <Card>
      <CardContent>
        <Stack spacing={2.5} sx={{ maxWidth: 480 }}>
          {error && <Alert severity="error" onClose={() => setError(null)}>{error}</Alert>}
          {saved && <Alert severity="success" onClose={() => setSaved(null)}>{saved}</Alert>}
          <Autocomplete
            options={workers ?? []}
            getOptionLabel={(w) => workerLabel(w)}
            value={worker}
            onChange={(_, v) => setWorker(v)}
            loading={!workers}
            renderInput={(p) => <TextField {...p} label="Persona" required />}
          />
          <TextField
            select
            label={PLOT.One}
            value={plotId}
            onChange={(e) => setPlotId(e.target.value)}
            required
          >
            <MenuItem value="" disabled>Elija un lote</MenuItem>
            {(plots ?? []).map((p) => (
              <MenuItem key={p.id} value={p.id}>{p.name}</MenuItem>
            ))}
          </TextField>
          <DateField label="Día" value={day} onChange={setDay} max={today} />
          <TextField
            label="Kilos"
            value={kg}
            onChange={(e) => setKg(e.target.value)}
            inputProps={{ inputMode: "decimal", "aria-label": "Kilos" }}
            sx={{ "& input": { fontSize: 28, py: 1.5 } }}
            required
          />
          <Button variant="contained" size="large" onClick={() => void save()} disabled={busy}>
            Guardar pesada
          </Button>
        </Stack>
      </CardContent>
    </Card>
  );
}
