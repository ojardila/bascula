/**
 * Route guards.
 *
 * `RequirePermission` implements the convention every use case repeats: "al
 * entrar a cualquier módulo sin privilegios, el sistema notifica la carencia y
 * saca al usuario del módulo". It notifies first and then leaves — a silent
 * redirect looks like a broken link, and the person never learns that what
 * they need is a role change, not a different button.
 */
import { useEffect, useState, type ReactNode } from "react";
import { Navigate, useLocation, useNavigate } from "react-router-dom";
import { Box, Button, CircularProgress, Container, Paper, Stack, Typography } from "@mui/material";
import LockPersonIcon from "@mui/icons-material/LockPerson";
import { useAuth } from "../auth/AuthContext";
import type { Action } from "../auth/permissions";

export function Splash() {
  return (
    <Box sx={{ display: "grid", placeItems: "center", minHeight: "100dvh" }}>
      <Stack alignItems="center" spacing={2}>
        <CircularProgress />
        <Typography color="text.secondary">Cargando…</Typography>
      </Stack>
    </Box>
  );
}

export function RequireAuth({ children }: { children: ReactNode }) {
  const { status } = useAuth();
  const location = useLocation();
  if (status === "loading") return <Splash />;
  if (status === "anonymous") {
    // Remember where they were going, so the login lands them there.
    return <Navigate to="/entrar" replace state={{ from: location.pathname }} />;
  }
  return <>{children}</>;
}

export function RequireSuperAdmin({ children }: { children: ReactNode }) {
  const { status, user } = useAuth();
  if (status === "loading") return <Splash />;
  if (status === "anonymous") return <Navigate to="/entrar" replace />;
  if (!user?.isSuperAdmin) return <Navigate to="/" replace />;
  return <>{children}</>;
}

/**
 * Shown for a few seconds and then the user is taken out of the module.
 *
 * Note the wording: this says the *account* lacks the privilege, not that the
 * page is missing, and it names who can grant it.
 */
export function PermissionDenied({ moduleName }: { moduleName: string }) {
  const navigate = useNavigate();
  const { landing } = useAuth();
  const [seconds, setSeconds] = useState(6);

  useEffect(() => {
    const t = setInterval(() => setSeconds((s) => s - 1), 1000);
    const out = setTimeout(() => navigate(landing, { replace: true }), 6000);
    return () => {
      clearInterval(t);
      clearTimeout(out);
    };
  }, [navigate, landing]);

  return (
    <Container maxWidth="sm" sx={{ py: 8 }}>
      <Paper sx={{ p: 4, textAlign: "center" }} variant="outlined">
        <LockPersonIcon color="warning" sx={{ fontSize: 48, mb: 1 }} />
        <Typography variant="h2" gutterBottom>
          No tiene permiso para {moduleName}
        </Typography>
        <Typography color="text.secondary" sx={{ mb: 3 }}>
          Su usuario no tiene el privilegio necesario para esta parte del sistema.
          Si lo necesita para trabajar, pídaselo al dueño de la finca.
        </Typography>
        <Button variant="contained" onClick={() => navigate(landing, { replace: true })}>
          Salir del módulo {seconds > 0 ? `(${seconds})` : ""}
        </Button>
      </Paper>
    </Container>
  );
}

export function RequirePermission({
  action,
  moduleName,
  children,
}: {
  action: Action;
  moduleName: string;
  children: ReactNode;
}) {
  const { can } = useAuth();
  if (!can(action)) return <PermissionDenied moduleName={moduleName} />;
  return <>{children}</>;
}
