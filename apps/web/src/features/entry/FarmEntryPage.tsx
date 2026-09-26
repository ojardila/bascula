/**
 * `/` on a farm's own address ({slug}.bascula.engp.io) and on the general
 * demo: not the marketing landing, just the door. Three things, big: enter,
 * register a farm, and what to do about a forgotten password. People already
 * signed in never see it (HomeRoute sends them to /tablero).
 */
import { Link as RouterLink } from "react-router-dom";
import { Box, Button, Container, Link, Paper, Stack, Typography } from "@mui/material";
import { GREEN, GREEN_DARK } from "../../theme";
import { farmSlugFromHost, signupUrlForHere } from "../../lib/farmHost";

export function FarmEntryPage({ hostname }: { hostname?: string }) {
  const host = hostname ?? window.location.hostname;
  const slug = farmSlugFromHost(host);
  return (
    <Box
      sx={{
        minHeight: "100dvh",
        display: "grid",
        placeItems: "center",
        p: 2,
        background: `linear-gradient(160deg, ${GREEN_DARK} 0%, ${GREEN} 45%, #f6f7f4 45.2%)`,
      }}
    >
      <Container maxWidth="xs" disableGutters>
        <Stack alignItems="center" sx={{ mb: 2.5 }}>
          <Typography sx={{ color: "#fff", fontWeight: 800, fontSize: 34, letterSpacing: "-0.02em" }}>
            BÁSCULA
          </Typography>
          <Typography sx={{ color: "rgba(255,255,255,.9)", fontSize: 16 }}>
            Administración de finca cafetera
          </Typography>
        </Stack>
        <Paper sx={{ p: { xs: 3, sm: 4 } }} elevation={3}>
          <Stack spacing={3} alignItems="stretch" textAlign="center" data-testid="farm-entry">
            <Box>
              <Typography component="h1" sx={{ fontSize: "2rem", fontWeight: 800 }}>
                Bienvenido
              </Typography>
              {slug && (
                <Typography sx={{ fontSize: "1.3rem", mt: 1, color: "primary.main", fontWeight: 700, wordBreak: "break-all" }}>
                  Finca {slug}
                </Typography>
              )}
            </Box>
            <Button
              component={RouterLink}
              to="/entrar"
              variant="contained"
              size="large"
              sx={{ minHeight: 64, fontSize: "1.35rem", borderRadius: 999 }}
            >
              Entrar
            </Button>
            <Button
              href={signupUrlForHere(host)}
              variant="outlined"
              size="large"
              sx={{ minHeight: 56, fontSize: "1.15rem", borderRadius: 999 }}
            >
              Registrar
            </Button>
            <Link component={RouterLink} to="/olvide-mi-clave" sx={{ fontSize: "1.1rem" }}>
              ¿Olvidó su clave o su usuario?
            </Link>
          </Stack>
        </Paper>
      </Container>
    </Box>
  );
}
