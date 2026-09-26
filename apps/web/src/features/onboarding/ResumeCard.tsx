/**
 * «Termine de preparar su finca» on Cosecha, for an owner who left the tour
 * half way («Saltar» or «Ahora no, más tarde»). It shows how far they got in
 * the three parts the welcome promised and takes them back to the saved step.
 * The × hides it for good; the tour stays in «Ayuda y recorrido».
 */
import { Box, Button, IconButton, LinearProgress, Stack, Typography } from "@mui/material";
import CloseIcon from "@mui/icons-material/Close";
import CheckIcon from "@mui/icons-material/Check";
import RadioButtonUncheckedIcon from "@mui/icons-material/RadioButtonUnchecked";
import { useTour } from "./TourContext";
import { ownerPartsDone } from "./steps";

const PARTS = ["Precio del kilo", "Invitar a su gente (dueños y equipo)", "Crear sus lotes"];

export function ResumeCard() {
  const t = useTour();
  const s = t.saved.owner;
  if (t.available !== "owner" || t.current || !s) return null;
  if (s.status !== "later" && s.status !== "active") return null;
  const done = ownerPartsDone(s.step);
  if (done >= 3) return null;

  return (
    <Box
      data-tour="resume-card"
      sx={{ position: "relative", p: { xs: 2.25, sm: 2.75 }, borderRadius: 4, border: 2, borderColor: "#b9d7b3", bgcolor: "#f5faf3" }}
    >
      <IconButton
        aria-label="No mostrar más"
        onClick={() => t.dismiss("owner")}
        sx={{ position: "absolute", top: 8, right: 8 }}
      >
        <CloseIcon />
      </IconButton>
      <Typography component="h2" sx={{ fontSize: 21, fontWeight: 800, pr: 5 }}>
        Termine de preparar su finca
      </Typography>
      <LinearProgress
        variant="determinate"
        value={(done / 3) * 100}
        sx={{ mt: 1.5, height: 8, borderRadius: 4, bgcolor: "#e2e8df" }}
        aria-hidden
      />
      <Typography sx={{ fontSize: 16, color: "text.secondary", mt: 0.75 }}>Lleva {done} de 3</Typography>
      <Stack spacing={0.75} sx={{ mt: 1.5 }}>
        {PARTS.map((p, i) => (
          <Stack key={p} direction="row" spacing={1} alignItems="center">
            {i < done ? (
              <CheckIcon color="primary" fontSize="small" />
            ) : (
              <RadioButtonUncheckedIcon fontSize="small" sx={{ color: "text.secondary" }} />
            )}
            <Typography sx={{ fontSize: 17, fontWeight: i === done ? 700 : 400 }}>{p}</Typography>
          </Stack>
        ))}
      </Stack>
      <Button
        fullWidth
        variant="contained"
        onClick={() => t.resume("owner")}
        sx={{ mt: 2, borderRadius: 999, minHeight: 52, fontSize: 18, fontWeight: 700 }}
      >
        Seguir donde iba
      </Button>
    </Box>
  );
}
