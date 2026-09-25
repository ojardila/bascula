/**
 * The farm's data, out, as files Excel opens: the weighings, every money
 * movement, and each person's balance. Three files and not one, because they
 * answer three different questions and have three different shapes.
 */
import { useState } from "react";
import { Alert, Button, Card, CardContent, Stack, Typography } from "@mui/material";
import DownloadIcon from "@mui/icons-material/Download";
import { api } from "../../api/endpoints";
import { messageFor } from "../../api/errors";
import { useAuth } from "../../auth/AuthContext";
import { downloadCsv, pesos, toCsv } from "../../lib/csv";
import { LEDGER_KIND_LABEL } from "../../lib/vocab";
import type { Worker } from "../../api/types";

type Kind = "pesadas" | "movimientos" | "saldos";

const METHOD: Record<string, string> = { efectivo: "Efectivo", transferencia: "Transferencia", otro: "Otro" };

const fullName = (w: Pick<Worker, "name" | "lastName">) => `${w.name} ${w.lastName}`.trim();

export async function weighingsCsv(): Promise<string> {
  const records = await api.listWorkRecords({ status: "active" });
  const rows = records
    .filter((r) => r.unitLabel !== null)
    .sort((a, b) => (a.dateFrom < b.dateFrom ? -1 : a.dateFrom > b.dateFrom ? 1 : 0))
    .map((r) => [
      r.dateFrom,
      r.workerName,
      r.activityName,
      r.plotNames.join(", "),
      r.quantity,
      r.unitLabel,
      pesos(r.rateCents),
      pesos(r.estimatedAmountCents),
      r.amountIsEstimate === null ? null : r.amountIsEstimate ? "Provisional" : "Fijo",
    ]);
  return toCsv(["Fecha", "Empleado", "Actividad", "Lotes", "Cantidad", "Unidad", "Precio", "Valor", "Precio del valor"], rows);
}

export async function movementsCsv(): Promise<string> {
  const workers = await api.listWorkers({ status: "all" });
  const rows: (string | number | null)[][] = [];
  for (const w of workers) {
    const ledger = await api.workerLedger(w.id);
    for (const e of ledger) {
      rows.push([e.date, fullName(w), LEDGER_KIND_LABEL[e.kind] ?? e.kind, e.concept, pesos(e.amountCents), e.method ? METHOD[e.method] ?? e.method : null]);
    }
  }
  rows.sort((a, b) => String(a[0]).localeCompare(String(b[0])));
  return toCsv(["Fecha", "Empleado", "Movimiento", "Concepto", "Valor", "Medio de pago"], rows);
}

export async function balancesCsv(): Promise<string> {
  const [balances, workers] = await Promise.all([api.listBalances(), api.listWorkers({ status: "all" })]);
  const names = new Map(workers.map((w) => [w.id, fullName(w)]));
  const rows = balances
    .map((b) => [
      names.get(b.workerId) ?? "—",
      pesos(b.earnedCents),
      pesos(b.paidCents),
      pesos(b.deductedCents),
      pesos(b.balanceCents),
      b.lastMovementOn,
    ])
    .sort((a, b) => String(a[0]).localeCompare(String(b[0]), "es"));
  return toCsv(["Empleado", "Ganado", "Pagado", "Descontado", "Saldo", "Último movimiento"], rows);
}

const BUILD: Record<Kind, () => Promise<string>> = {
  pesadas: weighingsCsv,
  movimientos: movementsCsv,
  saldos: balancesCsv,
};

export function ExportCard() {
  const { can, user } = useAuth();
  const [busy, setBusy] = useState<Kind | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);

  async function run(kind: Kind) {
    setError(null);
    setDone(null);
    setBusy(kind);
    try {
      const csv = await BUILD[kind]();
      const slug = user?.farm.slug ?? "finca";
      const day = new Date().toISOString().slice(0, 10);
      const file = `bascula-${slug}-${kind}-${day}.csv`;
      if (downloadCsv(file, csv)) setDone(`Se descargó ${file}.`);
      else setError("El navegador no permitió descargar el archivo.");
    } catch (e) {
      setError(messageFor(e));
    } finally {
      setBusy(null);
    }
  }

  const money = can("money.read");
  return (
    <Card>
      <CardContent>
        <Typography variant="h3" gutterBottom>
          Descargar datos
        </Typography>
        <Typography color="text.secondary" sx={{ mb: 2 }}>
          Archivos CSV que se abren en Excel. Sirven de copia y para revisar las cuentas por fuera.
        </Typography>
        {error && <Alert severity="error" sx={{ mb: 2 }} onClose={() => setError(null)}>{error}</Alert>}
        {done && <Alert severity="success" sx={{ mb: 2 }} onClose={() => setDone(null)}>{done}</Alert>}
        <Stack spacing={1.5} alignItems="flex-start">
          {can("workRecords.readAll") && (
            <Button variant="outlined" startIcon={<DownloadIcon />} disabled={busy !== null} onClick={() => void run("pesadas")}>
              {busy === "pesadas" ? "Preparando…" : "Pesadas"}
            </Button>
          )}
          {money && (
            <Button variant="outlined" startIcon={<DownloadIcon />} disabled={busy !== null} onClick={() => void run("movimientos")}>
              {busy === "movimientos" ? "Preparando…" : "Movimientos de dinero"}
            </Button>
          )}
          {money && (
            <Button variant="outlined" startIcon={<DownloadIcon />} disabled={busy !== null} onClick={() => void run("saldos")}>
              {busy === "saldos" ? "Preparando…" : "Saldos por empleado"}
            </Button>
          )}
        </Stack>
      </CardContent>
    </Card>
  );
}
