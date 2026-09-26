/**
 * The tour's globe, as in the approved mockups: a section in small green
 * capitals, a short title, one or two sentences, a progress bar with
 * «Paso X de 11», and «Saltar» · «Atrás» · «Continuar». Large type and
 * 48-pixel buttons, because it is read by people around fifty on a phone.
 *
 * The same card is used inside React Joyride (spotlight steps) and inline in
 * dialogs and forms (callout steps), so both look the same.
 */
import { useState } from "react";
import { Box, Button, IconButton, LinearProgress, Stack, Typography, type SxProps, type Theme } from "@mui/material";
import CloseIcon from "@mui/icons-material/Close";
import { useTour } from "./TourContext";
import { TOTALS, type TourName, type TourStepDef } from "./steps";

/** The yellow ring the mockups put around whatever a step is about. */
export const TOUR_RING: SxProps<Theme> = {
  outline: "4px solid #F2C94C",
  outlineOffset: "4px",
  borderRadius: 3,
};

export function TourCard({
  tour,
  def,
  onPrimary,
  elevated = true,
}: {
  tour: TourName;
  def: TourStepDef;
  /** Overrides the step's action: return true to move on. */
  onPrimary?: () => boolean | Promise<boolean>;
  elevated?: boolean;
}) {
  const t = useTour();
  const [busy, setBusy] = useState(false);
  const total = TOTALS[tour];

  async function primary() {
    if (busy) return;
    setBusy(true);
    try {
      const ok = onPrimary ? await onPrimary() : def.action ? await t.runAction(def.action) : true;
      if (!ok) return;
      if (def.next === "stay") return;
      if (def.next === "finish") t.finish();
      else t.goTo(typeof def.next === "number" ? def.next : def.n + 1);
    } finally {
      setBusy(false);
    }
  }

  const showBack = !def.noBack && def.n > 1;

  return (
    <Box
      role="dialog"
      aria-label={`Paso ${def.n} de ${total}: ${def.title}`}
      sx={{
        position: "relative",
        bgcolor: "background.paper",
        color: "text.primary",
        borderRadius: 4,
        boxShadow: elevated ? "0 12px 40px rgba(0,0,0,0.28)" : "none",
        border: elevated ? 0 : 2,
        borderColor: "primary.main",
        p: { xs: 2.25, sm: 2.75 },
        width: elevated ? "min(440px, calc(100vw - 24px))" : "auto",
        textAlign: "left",
      }}
    >
      {def.secondary && (
        <IconButton
          aria-label="Saltar el recorrido"
          onClick={t.later}
          size="small"
          sx={{ position: "absolute", top: 8, right: 8 }}
        >
          <CloseIcon />
        </IconButton>
      )}
      <Typography
        sx={{
          color: "primary.main",
          fontWeight: 800,
          fontSize: 14,
          letterSpacing: "0.08em",
          textTransform: "uppercase",
          mb: 0.5,
        }}
      >
        {def.section}
      </Typography>
      <Typography component="h2" sx={{ fontSize: { xs: 22, sm: 24 }, fontWeight: 800, lineHeight: 1.25, mb: 1 }}>
        {def.title}
      </Typography>
      <Typography component="div" sx={{ fontSize: { xs: 17, sm: 18 }, lineHeight: 1.5 }}>
        {def.body}
      </Typography>
      {def.alt && (
        <Button
          variant="text"
          onClick={() => (def.alt!.next === "finish" ? t.finish() : t.goTo(def.alt!.next as number))}
          sx={{ mt: 1, px: 0, fontSize: 16, fontWeight: 600, textDecoration: "underline", minHeight: 40 }}
        >
          {def.alt.label}
        </Button>
      )}
      <LinearProgress
        variant="determinate"
        value={(def.n / total) * 100}
        sx={{ mt: 2, height: 8, borderRadius: 4, bgcolor: "#e8ebe6" }}
        aria-hidden
      />
      <Typography sx={{ fontSize: 15, color: "text.secondary", mt: 0.75 }}>
        Paso {def.n} de {total}
      </Typography>
      <Stack direction="row" alignItems="center" spacing={1.25} sx={{ mt: 2 }}>
        {def.secondary ? (
          <Button
            variant="text"
            color="inherit"
            onClick={() => t.goTo(def.secondary!.next)}
            sx={{ fontSize: 16, fontWeight: 700, textDecoration: "underline", minHeight: 48, px: 0.5, lineHeight: 1.2, textAlign: "left" }}
          >
            {def.secondary.label}
          </Button>
        ) : (
          <Button
            variant="text"
            color="inherit"
            onClick={t.later}
            sx={{ fontSize: 17, fontWeight: 700, textDecoration: "underline", minHeight: 48, px: 0.5 }}
          >
            Saltar
          </Button>
        )}
        <Box sx={{ flex: 1 }} />
        {showBack && (
          <Button
            variant="outlined"
            onClick={() => t.goTo(def.n - 1 === 6 || def.n - 1 === 5 ? 4 : def.n - 1)}
            sx={{ borderRadius: 999, minHeight: 48, px: 2.5, fontSize: 17, fontWeight: 700, borderWidth: 2 }}
          >
            Atrás
          </Button>
        )}
        <Button
          variant="contained"
          onClick={primary}
          disabled={busy}
          sx={{ borderRadius: 999, minHeight: 48, px: 3, fontSize: 17, fontWeight: 700, lineHeight: 1.2 }}
        >
          {busy ? "Un momento…" : def.primary}
        </Button>
      </Stack>
    </Box>
  );
}
