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
 * ── WHAT LEFT THIS BANNER, AND WHY ───────────────────────────────────────
 *
 * It used to say, across the top of every page: "ponga VITE_USE_MOCKS=false en
 * .env.development". That is an instruction for somebody with the repository
 * checked out, and it was written on the screen of a 62-year-old coffee farmer
 * who uses WhatsApp and not much else. Together with the sync warning the two
 * of them ate 520 of a phone's first 844 pixels.
 *
 * The fact that IS his —what he is looking at is not his farm, and nothing is
 * saved— stays, in one line. The environment variable and the file are in the
 * README and in the browser console, which is where whoever needs them lives:
 * nobody edits a `.env` from the phone they are reading this screen on.
 */
import { useEffect } from "react";
import { Alert, Box } from "@mui/material";
import ScienceIcon from "@mui/icons-material/Science";
import { apiMode } from "../api/mode";

export function ApiModeBanner() {
  const mode = apiMode();

  // For whoever DOES need it, where they will actually look. Once per load.
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
