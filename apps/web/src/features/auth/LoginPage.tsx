import { useState, type FormEvent } from "react";
import { Link as RouterLink, Navigate, useLocation, useNavigate } from "react-router-dom";
import {
  Alert, Box, Button, Divider, Link, Stack, TextField, Typography,
} from "@mui/material";
import { AuthLayout } from "./AuthLayout";
import { useAuth } from "../../auth/AuthContext";
import { messageFor } from "../../api/errors";

export function LoginPage() {
  const { status, login, landing } = useAuth();
  const navigate = useNavigate();
  const location = useLocation() as { state?: { from?: string } };
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  if (status === "authenticated") return <Navigate to={landing} replace />;

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      const res = await login(email, password);
      if ("choose" in res) {
        // A user with more than one farm re-authenticates against the other
        // membership; there is no token that is valid for two farms.
        setError("Su usuario pertenece a varias fincas. Elija una para continuar.");
        return;
      }
      navigate(location.state?.from ?? "/", { replace: true });
    } catch (err) {
      setError(messageFor(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <AuthLayout title="Entrar" subtitle="Escriba el correo y la contraseña de su finca.">
      <Box component="form" onSubmit={onSubmit} noValidate>
        <Stack spacing={2}>
          {error && <Alert severity="error">{error}</Alert>}
          <TextField
            label="Correo"
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            autoComplete="username"
            autoFocus
            fullWidth
            size="medium"
            required
          />
          <TextField
            label="Contraseña"
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete="current-password"
            fullWidth
            size="medium"
            required
          />
          <Button type="submit" variant="contained" size="large" disabled={busy} fullWidth>
            {busy ? "Entrando…" : "Entrar"}
          </Button>
          <Divider>o</Divider>
          <Button component={RouterLink} to="/registro" variant="outlined" fullWidth size="large">
            Registrar mi finca
          </Button>
        </Stack>
      </Box>

      {import.meta.env.VITE_USE_MOCKS === "true" && (
        <Box sx={{ mt: 3, p: 1.5, bgcolor: "#f2f5f0", borderRadius: 2 }}>
          <Typography variant="caption" color="text.secondary" component="div">
            <strong>Datos de prueba</strong> (finca simulada, sin API):
          </Typography>
          {[
            ["oscar@laesperanza.co", "dueño"],
            ["admin@laesperanza.co", "administrador"],
            ["pesador@laesperanza.co", "pesador"],
          ].map(([mail, role]) => (
            <Typography key={mail} variant="caption" component="div" color="text.secondary">
              <Link
                component="button"
                type="button"
                onClick={() => {
                  setEmail(mail);
                  setPassword("esperanza");
                }}
              >
                {mail}
              </Link>{" "}
              · {role} · clave <code>esperanza</code>
            </Typography>
          ))}
          <Typography variant="caption" component="div" color="text.secondary">
            <Link
              component="button"
              type="button"
              onClick={() => {
                setEmail("super@bascula.co");
                setPassword("bascula");
              }}
            >
              super@bascula.co
            </Link>{" "}
            · super-admin · clave <code>bascula</code>
          </Typography>
        </Box>
      )}
    </AuthLayout>
  );
}
