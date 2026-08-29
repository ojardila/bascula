import type { ReactNode } from "react";
import { Box, Container, Paper, Stack, Typography } from "@mui/material";
import { GREEN, GREEN_DARK } from "../../theme";

/** The public frame: no sidebar, no farm, nothing that assumes a tenant. */
export function AuthLayout({
  title,
  subtitle,
  children,
  wide,
}: {
  title: string;
  subtitle?: string;
  children: ReactNode;
  wide?: boolean;
}) {
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
      <Container maxWidth={wide ? "sm" : "xs"} disableGutters>
        <Stack alignItems="center" sx={{ mb: 2.5 }}>
          <Typography
            sx={{ color: "#fff", fontWeight: 800, fontSize: 30, letterSpacing: "-0.02em" }}
          >
            BÁSCULA
          </Typography>
          <Typography sx={{ color: "rgba(255,255,255,.85)", fontSize: 14 }}>
            Administración de finca cafetera
          </Typography>
        </Stack>
        <Paper sx={{ p: { xs: 2.5, sm: 4 } }} elevation={3}>
          <Typography variant="h2" gutterBottom>
            {title}
          </Typography>
          {subtitle && (
            <Typography color="text.secondary" sx={{ mb: 3 }}>
              {subtitle}
            </Typography>
          )}
          {children}
        </Paper>
      </Container>
    </Box>
  );
}
