/**
 * The line at the top of every screen that says what the signal means today.
 *
 *  - No signal: weighings still work and are kept on this phone; reports,
 *    payments and payroll need internet. Said once, plainly, instead of every
 *    screen failing with its own error.
 *  - «N pesadas por subir»: visible until they are up, with a button to try
 *    now and a link to see them.
 */
import { Link as RouterLink } from "react-router-dom";
import { Alert, Button, Stack } from "@mui/material";
import CloudOffIcon from "@mui/icons-material/CloudOff";
import CloudUploadIcon from "@mui/icons-material/CloudUpload";
import { useOffline } from "./OfflineContext";

export function pendingLabel(n: number): string {
  return n === 1 ? "1 pesada por subir" : `${n} pesadas por subir`;
}

export function OfflineBar() {
  const { online, pending, syncing, flush } = useOffline();
  const waiting = pending.filter((p) => !p.error).length;
  const refused = pending.length - waiting;

  return (
    <Stack spacing={1} sx={{ mb: online && pending.length === 0 ? 0 : 2 }}>
      {!online && (
        <Alert severity="warning" icon={<CloudOffIcon />} sx={{ fontSize: "1.05rem" }}>
          <strong>Sin señal.</strong> Puede seguir registrando pesadas: se guardan en este teléfono y
          se suben solas cuando vuelva la señal. Informes, pagos y nómina necesitan internet.
        </Alert>
      )}
      {waiting > 0 && (
        <Alert
          severity="info"
          icon={<CloudUploadIcon />}
          sx={{ fontSize: "1.05rem", alignItems: "center" }}
          action={
            <Stack direction="row" spacing={1}>
              {online && (
                <Button color="inherit" size="small" disabled={syncing} onClick={() => void flush()}>
                  {syncing ? "Subiendo…" : "Subir ahora"}
                </Button>
              )}
              <Button color="inherit" size="small" component={RouterLink} to="/cosecha/recoleccion?quien=uno">
                Ver
              </Button>
            </Stack>
          }
        >
          {pendingLabel(waiting)}
        </Alert>
      )}
      {refused > 0 && (
        <Alert
          severity="error"
          sx={{ fontSize: "1.05rem", alignItems: "center" }}
          action={
            <Button color="inherit" size="small" component={RouterLink} to="/cosecha/recoleccion?quien=uno">
              Revisar
            </Button>
          }
        >
          {refused === 1 ? "1 pesada no se pudo subir." : `${refused} pesadas no se pudieron subir.`}
        </Alert>
      )}
    </Stack>
  );
}
