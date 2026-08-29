/**
 * "What you are looking at is not real."
 *
 * Sprint 1 shipped with the mock on by default and nothing on screen said so.
 * That is survivable for a week and a genuine hazard for a month: sooner or
 * later somebody demonstrates the product to a farmer using a farm that will
 * vanish on reload, or files a bug against behaviour that exists only in
 * `handlers.ts` and sends the API pair looking for it in Go.
 *
 * So mock mode is now visible. Deliberately NOT dismissible, for the same
 * reason the sync warning is not: a banner a person can make disappear is a
 * banner that is absent exactly when it matters.
 *
 * It renders nothing at all in real mode. A permanent "you are talking to the
 * real server" strip would be noise, and noise is what teaches people to stop
 * reading strips.
 */
import { Alert, Box } from "@mui/material";
import ScienceIcon from "@mui/icons-material/Science";
import { apiMode } from "../api/mode";

export function ApiModeBanner() {
  const mode = apiMode();
  if (!mode.mocks) return null;

  return (
    <Alert
      severity="info"
      icon={<ScienceIcon fontSize="small" />}
      variant="outlined"
      role="status"
      sx={{
        borderRadius: 0,
        borderInline: 0,
        borderTop: 0,
        bgcolor: "#eef4ff",
        py: 0.25,
        "& .MuiAlert-message": { py: 0.5 },
      }}
    >
      <Box component="span" sx={{ fontWeight: 700 }}>
        Datos simulados.
      </Box>{" "}
      Nada de lo que registre aquí llega al servidor y todo se pierde al recargar.
      Para usar la finca de verdad, ponga <code>VITE_USE_MOCKS=false</code> en{" "}
      <code>.env.development</code>.
    </Alert>
  );
}
