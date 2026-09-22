/**
 * The public door: Báscula as an opportunity for a coffee farm, not a login box.
 *
 * Creating a farm still goes through /empezar (signup). This page is the
 * pitch, and it names the URL they will get: {slug}.bascula.engp.io.
 */
import { Link as RouterLink } from "react-router-dom";
import { Box, Button, Container, Stack, Typography } from "@mui/material";
import { GREEN, GREEN_DARK } from "../../theme";
import { useAuth } from "../../auth/AuthContext";

const PITCHES = [
  {
    title: "La planilla, en el celular",
    body: "Un lote, un día, los kilos de cada persona. Sin cuaderno que se moja y sin pasar a Excel el sábado.",
  },
  {
    title: "Liquidación que cuadra",
    body: "Semana actual, saldo anterior, descuentos por concepto y el pago. El recibo suma, y el trabajador lo firma.",
  },
  {
    title: "Pregúntele a ChatGPT",
    body: "Conecte la finca a un asistente. Pregunte por la cosecha o por un recibo sin abrirle el libro a nadie más.",
  },
];

export function LandingPage() {
  const { status, landing } = useAuth();
  const signedIn = status === "authenticated";

  return (
    <Box sx={{ minHeight: "100dvh", bgcolor: "#f6f7f4" }}>
      <Box
        sx={{
          background: `linear-gradient(165deg, ${GREEN_DARK} 0%, ${GREEN} 70%)`,
          color: "#fff",
          pb: { xs: 8, md: 12 },
          pt: { xs: 3, md: 4 },
        }}
      >
        <Container maxWidth="md">
          <Stack direction="row" justifyContent="space-between" alignItems="center" sx={{ mb: 6 }}>
            <Typography sx={{ fontWeight: 800, letterSpacing: "-0.03em", fontSize: 22 }}>
              BÁSCULA
            </Typography>
            {signedIn ? (
              <Button component={RouterLink} to={landing} variant="outlined" sx={{ color: "#fff", borderColor: "rgba(255,255,255,.6)" }}>
                Ir a mi finca
              </Button>
            ) : (
              <Button component={RouterLink} to="/entrar" variant="outlined" sx={{ color: "#fff", borderColor: "rgba(255,255,255,.6)" }}>
                Entrar
              </Button>
            )}
          </Stack>

          <Typography
            component="h1"
            sx={{
              fontWeight: 800,
              letterSpacing: "-0.03em",
              fontSize: { xs: "2.1rem", md: "3.1rem" },
              lineHeight: 1.15,
              maxWidth: 720,
              mb: 2,
            }}
          >
            La báscula de su finca, en el bolsillo y en la oficina.
          </Typography>
          <Typography sx={{ fontSize: { xs: "1.15rem", md: "1.35rem" }, opacity: 0.92, maxWidth: 560, mb: 4 }}>
            Recolección, liquidación y recibos para café de finca. Usted elige el
            nombre — <strong>fincasanjose</strong> — y queda en su propia URL,
            con su gente y su plata.
          </Typography>
          {!signedIn && (
            <Button
              component={RouterLink}
              to="/empezar"
              variant="contained"
              size="large"
              sx={{
                bgcolor: "#fff",
                color: GREEN_DARK,
                px: 4,
                "&:hover": { bgcolor: "#f3f6f1" },
              }}
            >
              Crear mi finca
            </Button>
          )}
        </Container>
      </Box>

      <Container maxWidth="md" sx={{ py: { xs: 5, md: 8 } }}>
        <Stack spacing={3}>
          {PITCHES.map((p) => (
            <Box
              key={p.title}
              sx={{
                p: 3,
                bgcolor: "#fff",
                borderRadius: 3,
                border: "1px solid",
                borderColor: "divider",
              }}
            >
              <Typography variant="h3" gutterBottom>
                {p.title}
              </Typography>
              <Typography color="text.secondary">{p.body}</Typography>
            </Box>
          ))}
        </Stack>

        <Box sx={{ mt: 6, p: { xs: 3, md: 4 }, bgcolor: GREEN_DARK, color: "#fff", borderRadius: 3 }}>
          <Typography variant="h2" sx={{ color: "#fff", mb: 1 }}>
            Su finca, su dirección
          </Typography>
          <Typography sx={{ opacity: 0.9, mb: 2 }}>
            Si registra <strong>fincasanjose</strong>, entra por{" "}
            <Box component="span" sx={{ fontFamily: "ui-monospace, monospace" }}>
              fincasanjose.bascula.engp.io
            </Box>
            . La pesada, la planilla y ChatGPT quedan en esa casa.
          </Typography>
          {!signedIn && (
            <Button
              component={RouterLink}
              to="/empezar"
              variant="contained"
              sx={{ bgcolor: "#fff", color: GREEN_DARK, "&:hover": { bgcolor: "#f3f6f1" } }}
            >
              Empezar ahora
            </Button>
          )}
        </Box>
      </Container>
    </Box>
  );
}
