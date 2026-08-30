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
 *
 * ── LO QUE SE FUE DE AQUÍ, Y POR QUÉ ─────────────────────────────────────
 *
 * Decía, en el techo de todas las páginas: «ponga VITE_USE_MOCKS=false en
 * .env.development». Eso es una instrucción para quien tiene el repositorio
 * clonado, y estaba escrita en la pantalla de un caficultor de 62 años que
 * usa WhatsApp y poco más. Junto con el aviso de sincronización se comían 520
 * de los primeros 844 píxeles de un celular.
 *
 * El hecho que sí es suyo —lo que ve aquí no es su finca, y no se guarda— se
 * queda, en una línea. La variable de entorno y el fichero están en el README
 * y en la consola del navegador, que es donde vive quien los necesita: nadie
 * edita un `.env` desde el teléfono con el que está mirando esta pantalla.
 */
import { useEffect } from "react";
import { Alert, Box } from "@mui/material";
import ScienceIcon from "@mui/icons-material/Science";
import { apiMode } from "../api/mode";

export function ApiModeBanner() {
  const mode = apiMode();

  // Para quien SÍ lo necesita, y donde lo va a mirar. Una vez por carga.
  useEffect(() => {
    if (mode.mocks) {
      console.info(
        "[báscula] Datos simulados. Para hablar con el servidor real, " +
          "ponga VITE_USE_MOCKS=false en .env.development y reinicie `npm run dev`.",
      );
    }
  }, [mode.mocks]);

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
        "& .MuiAlert-icon": { py: 0.75 },
      }}
    >
      <Box component="span" sx={{ fontWeight: 700 }}>
        Datos de prueba.
      </Box>{" "}
      Ésta no es su finca: nada de lo que registre aquí se guarda.
    </Alert>
  );
}
