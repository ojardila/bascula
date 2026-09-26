/**
 * One receipt from a worker's history, as it stood the day it was written,
 * with "Descargar PDF" for the paper copy. Reached from the history on the
 * worker's page; the route is money, so the weigher never gets here.
 */
import { useEffect, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { Alert, Box, Button, Stack, Typography } from "@mui/material";
import ArrowBackIcon from "@mui/icons-material/ArrowBack";
import PictureAsPdfIcon from "@mui/icons-material/PictureAsPdf";
import { PermissionDenied, Splash } from "../../components/Guards";
import { useAsync } from "../../lib/useAsync";
import { useAuth } from "../../auth/AuthContext";
import { ReceiptView } from "./ReceiptView";
import { downloadReceiptPdf } from "./receiptPdf";
import { HISTORY_KINDS, loadReceiptDoc, type HistoryKind } from "./loadReceipt";

export function ReceiptPage() {
  const { id = "", kind = "", entryId = "" } = useParams();
  const navigate = useNavigate();
  const { user } = useAuth();
  const [busy, setBusy] = useState(false);
  const [pdfError, setPdfError] = useState<string | null>(null);
  const validKind = (HISTORY_KINDS as string[]).includes(kind);
  // Opened from a long history: start at the top of the receipt, not at the
  // scroll position of the list it came from.
  useEffect(() => {
    window.scrollTo?.(0, 0);
  }, [kind, entryId]);

  const { data, error, denied } = useAsync(
    () =>
      validKind
        ? loadReceiptDoc({
            workerId: id,
            kind: kind as HistoryKind,
            entryId,
            farmName: user?.farm.name ?? "Finca",
            timezone: user?.farm.timezone ?? "America/Bogota",
          })
        : Promise.reject(new Error("Este recibo no existe.")),
    [id, kind, entryId],
  );

  const back = (
    <Button
      startIcon={<ArrowBackIcon />}
      onClick={() => navigate(`/empleados/${id}#historial`)}
      color="inherit"
      sx={{ mb: 1, fontSize: 17 }}
    >
      Volver al historial
    </Button>
  );

  if (denied) return <PermissionDenied moduleName="ver los recibos" />;
  if (error)
    return (
      <Box>
        {back}
        <Alert severity="error">{error}</Alert>
      </Box>
    );
  if (!data) return <Splash />;

  async function download() {
    if (!data) return;
    setBusy(true);
    setPdfError(null);
    const outcome = await downloadReceiptPdf(data);
    setBusy(false);
    if (outcome === "failed") setPdfError("No se pudo crear el PDF. Intente otra vez.");
  }

  return (
    <Box sx={{ maxWidth: 920 }}>
      {back}
      <Stack
        direction={{ xs: "column", sm: "row" }}
        justifyContent="space-between"
        alignItems={{ xs: "stretch", sm: "center" }}
        spacing={1.5}
        sx={{ mb: 2 }}
      >
        <Typography variant="h1" sx={{ fontSize: { xs: 26, sm: 32 } }}>
          {data.title}
        </Typography>
        <Button
          variant="contained"
          size="large"
          startIcon={<PictureAsPdfIcon />}
          onClick={() => void download()}
          disabled={busy}
          sx={{ fontSize: 18, py: 1.25 }}
        >
          {busy ? "Preparando…" : "Descargar PDF"}
        </Button>
      </Stack>
      {pdfError && (
        <Alert severity="error" sx={{ mb: 2 }}>
          {pdfError}
        </Alert>
      )}
      <ReceiptView doc={data} />
    </Box>
  );
}
