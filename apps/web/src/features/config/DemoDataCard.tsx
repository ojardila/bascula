import { useState } from "react";
import { Alert, Button, Card, CardContent, LinearProgress, Typography } from "@mui/material";
import ScienceIcon from "@mui/icons-material/Science";
import { messageFor } from "../../api/errors";
import { useAuth } from "../../auth/AuthContext";
import { todayInFarm } from "../../lib/dates";
import { useAsync } from "../../lib/useAsync";
import { ConfirmDialog } from "../../components/ConfirmDialog";
import { farmIsEmpty, loadDemoData, type DemoProgress } from "./demoData";

export function DemoDataCard() {
  const { user } = useAuth();
  const { data: empty, reload } = useAsync(() => farmIsEmpty(), []);
  const [asking, setAsking] = useState(false);
  const [progress, setProgress] = useState<DemoProgress | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);

  async function load() {
    setAsking(false);
    setError(null);
    setProgress({ done: 0, total: 1 });
    try {
      const r = await loadDemoData(todayInFarm(user?.farm?.timezone ?? "America/Bogota"), setProgress);
      setDone(`Listo: ${r.workers} empleados y ${r.weighings} pesadas de las últimas cuatro semanas.`);
      reload();
    } catch (e) {
      setError(messageFor(e));
    } finally {
      setProgress(null);
    }
  }

  // Nothing to offer on a farm that is already in use, or before we know.
  if (!done && empty !== true) return null;

  return (
    <Card>
      <CardContent>
        <Typography variant="h3" gutterBottom>
          Datos de demostración
        </Typography>
        <Typography color="text.secondary" sx={{ mb: 2 }}>
          Para probar Báscula antes de empezar: seis empleados, dos lotes y cuatro semanas de pesadas.
          Solo se puede en una finca vacía.
        </Typography>
        {error && <Alert severity="error" sx={{ mb: 2 }} onClose={() => setError(null)}>{error}</Alert>}
        {done && <Alert severity="success" sx={{ mb: 2 }}>{done}</Alert>}
        {progress ? (
          <>
            <LinearProgress variant="determinate" value={(100 * progress.done) / Math.max(progress.total, 1)} sx={{ height: 10, borderRadius: 5, mb: 1 }} />
            <Typography color="text.secondary">
              Cargando… {progress.done} de {progress.total}
            </Typography>
          </>
        ) : (
          !done && (
            <Button variant="outlined" startIcon={<ScienceIcon />} onClick={() => setAsking(true)}>
              Cargar datos de demostración
            </Button>
          )
        )}
      </CardContent>
      <ConfirmDialog
        open={asking}
        title="¿Cargar datos de demostración?"
        body="Se crean seis empleados de ejemplo, dos lotes y sus pesadas. Úselo solo para probar: no mezcle estos datos con los de su finca."
        confirmLabel="Cargar"
        onConfirm={() => void load()}
        onCancel={() => setAsking(false)}
      />
    </Card>
  );
}
