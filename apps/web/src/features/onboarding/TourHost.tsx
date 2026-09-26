/**
 * Draws whatever the current tour step needs: the welcome and closing
 * dialogs, or — lazily — React Joyride for a spotlight step. Callout steps
 * are drawn by their own pages. Also walks the person to the step's page.
 */
import { lazy, Suspense, useEffect, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import {
  Box, Button, Dialog, DialogContent, Stack, Typography,
} from "@mui/material";
import CheckCircleIcon from "@mui/icons-material/CheckCircle";
import { useAuth } from "../../auth/AuthContext";
import { api } from "../../api/endpoints";
import { formatMoney } from "../../lib/money";
import { useTour } from "./TourContext";
import { TourCard } from "./TourCard";
import { OWNER_DONE } from "./steps";

const JoyrideTour = lazy(() => import("./JoyrideTour"));

export function TourHost() {
  const t = useTour();
  const location = useLocation();
  const navigate = useNavigate();
  const [missing, setMissing] = useState<string | null>(null);
  const cur = t.current;
  const stepKey = cur ? `${cur.tour}-${cur.n}` : null;

  // Walk to the step's page.
  useEffect(() => {
    if (!cur || t.paused) return;
    const route = cur.def.route;
    if (route && location.pathname !== route) navigate(route);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stepKey, t.paused]);

  useEffect(() => setMissing(null), [stepKey]);

  if (!cur || t.paused) return null;
  const { tour, def } = cur;

  if (tour === "owner" && def.n === 0) return <WelcomeDialog />;
  if (tour === "owner" && def.n === OWNER_DONE) return <DoneDialog />;
  if (def.kind !== "spot") return null;
  if (def.route && location.pathname !== def.route) return null;

  // The element never showed up (a slow page, a permission that hides it):
  // the same card, centred, so the tour never gets stuck.
  if (missing === stepKey) {
    return (
      <Box
        sx={{
          position: "fixed", inset: 0, zIndex: 1250, display: "flex", alignItems: "flex-end",
          justifyContent: "center", p: 1.5, bgcolor: "rgba(20,24,20,0.45)",
        }}
      >
        <TourCard tour={tour} def={def} />
      </Box>
    );
  }

  return (
    <Suspense fallback={null}>
      <JoyrideTour tour={tour} def={def} onMissing={() => setMissing(stepKey)} />
    </Suspense>
  );
}

function WelcomeDialog() {
  const t = useTour();
  const { user } = useAuth();
  const first = (user?.name ?? "").trim().split(/\s+/)[0];
  const items: [string, string | null][] = [
    ["Poner el precio del kilo", null],
    ["Invitar a su gente", "Otros dueños, administradores y pesadores"],
    ["Crear sus lotes", null],
  ];
  return (
    <Dialog open maxWidth="xs" fullWidth onClose={t.later} slotProps={{ paper: { sx: { borderRadius: 5 } } }}>
      <DialogContent sx={{ p: { xs: 3, sm: 4 } }}>
        <Typography sx={{ fontSize: 44, lineHeight: 1 }} aria-hidden>
          👋
        </Typography>
        <Typography component="h2" sx={{ fontSize: 26, fontWeight: 800, lineHeight: 1.25, mt: 1.5 }}>
          ¡Bienvenido a {user?.farm.name}{first ? `, ${first}` : ""}!
        </Typography>
        <Typography sx={{ fontSize: 18, mt: 1.5 }}>
          Le mostramos en unos 4 minutos cómo dejar lista su finca. Son tres cosas:
        </Typography>
        <Stack spacing={2} sx={{ my: 2.5 }}>
          {items.map(([title, hint], i) => (
            <Stack key={title} direction="row" spacing={2} alignItems="flex-start">
              <Box
                sx={{
                  width: 36, height: 36, borderRadius: "50%", bgcolor: "#e6f0e4", color: "primary.dark",
                  display: "flex", alignItems: "center", justifyContent: "center", fontWeight: 800,
                  flexShrink: 0, fontSize: 18,
                }}
              >
                {i + 1}
              </Box>
              <Box>
                <Typography sx={{ fontSize: 19, fontWeight: 700, lineHeight: 1.3, pt: 0.5 }}>{title}</Typography>
                {hint && <Typography sx={{ fontSize: 16, color: "text.secondary" }}>{hint}</Typography>}
              </Box>
            </Stack>
          ))}
        </Stack>
        <Typography sx={{ fontSize: 16, color: "text.secondary" }}>
          Todo lo que haga aquí queda guardado de verdad. Puede parar cuando quiera y seguir
          después.
        </Typography>
        <Button
          fullWidth
          variant="contained"
          onClick={() => t.goTo(1)}
          sx={{ mt: 3, borderRadius: 999, minHeight: 56, fontSize: 19, fontWeight: 700 }}
        >
          Empezar
        </Button>
        <Button
          fullWidth
          color="inherit"
          onClick={t.later}
          sx={{ mt: 1, minHeight: 48, fontSize: 17, fontWeight: 600, textDecoration: "underline" }}
        >
          Ahora no, más tarde
        </Button>
      </DialogContent>
    </Dialog>
  );
}

function DoneDialog() {
  const t = useTour();
  const navigate = useNavigate();
  const [price, setPrice] = useState<number | null>(t.summary.priceCents);

  useEffect(() => {
    if (price !== null) return;
    api.getBasePrice().then((p) => setPrice(p.currentCents)).catch(() => {});
  }, [price]);

  const { owners, people, plot } = t.summary;
  const done: string[] = [];
  if (price !== null) done.push(`Precio del kilo: ${formatMoney(price)}`);
  if (owners + people > 0) {
    const parts: string[] = [];
    if (owners) parts.push(`${owners} ${owners === 1 ? "socio" : "socios"}`);
    if (people) parts.push(`${people} ${people === 1 ? "persona" : "personas"}`);
    done.push(`Invitó a ${parts.join(" y ")}`);
  }
  if (plot) done.push(`Creó el lote «${plot}»`);

  const go = (to: string) => {
    t.finish();
    navigate(to);
  };

  return (
    <Dialog open maxWidth="xs" fullWidth onClose={t.finish} slotProps={{ paper: { sx: { borderRadius: 5 } } }}>
      <DialogContent sx={{ p: { xs: 3, sm: 4 }, textAlign: "center" }}>
        <Typography sx={{ fontSize: 52, lineHeight: 1 }} aria-hidden>
          🎉
        </Typography>
        <Typography component="h2" sx={{ fontSize: 27, fontWeight: 800, mt: 1.5 }}>
          ¡Su finca quedó lista!
        </Typography>
        <Typography sx={{ fontSize: 18, color: "text.secondary" }}>Ya puede empezar a anotar kilos.</Typography>
        {done.length > 0 && (
          <Stack
            spacing={1.5}
            sx={{ mt: 2.5, p: 2, borderRadius: 3, border: 1, borderColor: "divider", textAlign: "left" }}
          >
            {done.map((d) => (
              <Stack key={d} direction="row" spacing={1.5} alignItems="center">
                <CheckCircleIcon color="primary" />
                <Typography sx={{ fontSize: 18 }}>{d}</Typography>
              </Stack>
            ))}
          </Stack>
        )}
        <Typography sx={{ fontSize: 18, fontWeight: 700, mt: 3, mb: 1.5, textAlign: "left" }}>
          ¿Qué sigue?
        </Typography>
        <Stack spacing={1.5}>
          <Button variant="contained" onClick={() => go("/cosecha/recoleccion")} sx={bigBtn}>
            Registrar una recolección
          </Button>
          <Button variant="outlined" onClick={() => go("/cosecha/registro-masivo")} sx={bigBtn}>
            Registro de recolección masivo
          </Button>
          <Button variant="outlined" onClick={() => go("/empleados/nuevo")} sx={bigBtn}>
            Agregar empleados
          </Button>
        </Stack>
        <Typography sx={{ fontSize: 15, color: "text.secondary", mt: 2.5 }}>
          ¿Quiere ver este recorrido otra vez? Está en el menú, en «<strong>Ayuda y recorrido</strong>».
        </Typography>
      </DialogContent>
    </Dialog>
  );
}

const bigBtn = {
  borderRadius: 999,
  minHeight: 56,
  fontSize: 18,
  fontWeight: 700,
  justifyContent: "flex-start",
  px: 3,
  borderWidth: 2,
  "&:hover": { borderWidth: 2 },
} as const;
