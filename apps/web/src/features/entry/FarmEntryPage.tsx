/**
 * `/` on a farm's own address ({slug}.bascula.engp.io) and on the general
 * demo: not the marketing landing, just the door. On a farm: enter, and what
 * to do about a forgotten password — nothing else. A farm never offers to
 * register another farm; only the demo (a main domain) adds "Registrar".
 * People already signed in never see it (HomeRoute sends them to /tablero).
 */
import { Link as RouterLink } from "react-router-dom";
import { Box, Button, Container, Link, Paper, Stack, Typography } from "@mui/material";
import { GREEN, GREEN_DARK } from "../../theme";
import { farmGreeting, farmSlugFromHost, offersSignup } from "../../lib/farmHost";
import { useFarmDisplayName } from "../../lib/useFarmDisplayName";

export function FarmEntryPage({ hostname }: { hostname?: string }) {
  const host = hostname ?? window.location.hostname;
  const slug = farmSlugFromHost(host);
  // "Finca San José", not the DNS label. The slug is only the fallback when
  // the name cannot be had, and nothing shows until the answer is in, so the
  // label does not flash from one to the other.
  const { name, settled } = useFarmDisplayName(slug);
  const label = slug ? (name ? farmGreeting(name) : settled ? farmGreeting(slug) : null) : null;
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
                <Typography
                  data-testid="farm-entry-name"
                  sx={{
                    fontSize: "1.3rem", mt: 1, color: "primary.main", fontWeight: 700,
                    overflowWrap: "anywhere", visibility: label ? "visible" : "hidden",
                  }}
                >
                  {label ?? "\u00a0"}
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
            {offersSignup(host) && (
              <Button
                component={RouterLink}
                to="/empezar"
                variant="outlined"
                size="large"
                sx={{ minHeight: 56, fontSize: "1.15rem", borderRadius: 999 }}
              >
                Registrar
              </Button>
            )}
            <Link component={RouterLink} to="/olvide-mi-clave" sx={{ fontSize: "1.1rem" }}>
              ¿Olvidó su clave o su usuario?
            </Link>
          </Stack>
        </Paper>
      </Container>
    </Box>
  );
}
