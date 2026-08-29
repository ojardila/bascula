import { useState, type FormEvent } from "react";
import { Link as RouterLink, Navigate, useLocation, useNavigate } from "react-router-dom";
import {
  Alert, Box, Button, Divider, Link, Stack, TextField, Typography,
} from "@mui/material";
import { AuthLayout } from "./AuthLayout";
import { useAuth } from "../../auth/AuthContext";
import { messageFor } from "../../api/errors";
import type { Membership, Role } from "../../api/types";

const ROLE_LABEL: Record<Role, string> = {
  owner: "Dueño",
  administrator: "Administrador",
  weigher: "Pesador",
};

export function LoginPage() {
  const { status, login, landing } = useAuth();
  const navigate = useNavigate();
  const location = useLocation() as { state?: { from?: string } };
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  /**
   * Set when the address belongs to more than one farm. The server answers
   * that case with a 400 carrying the list, because there is no access token
   * valid for two farms — the farm is a claim inside it. So choosing one is a
   * second login that names the farm, not a switch inside this session.
   */
  const [choices, setChoices] = useState<Membership[] | null>(null);

  if (status === "authenticated") return <Navigate to={landing} replace />;

  async function attempt(farmId?: string) {
    setError(null);
    setBusy(true);
    try {
      const res = await login(email, password, farmId);
      if ("choose" in res) {
        setChoices(res.memberships);
        return;
      }
      navigate(location.state?.from ?? "/", { replace: true });
    } catch (err) {
      setError(messageFor(err));
    } finally {
      setBusy(false);
    }
  }

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    await attempt();
  }

  if (choices) {
    return (
      <AuthLayout title="¿A cuál finca entra?" subtitle="Su correo trabaja en varias.">
        <Stack spacing={1.5}>
          {error && <Alert severity="error">{error}</Alert>}
          {choices.map((m) => (
            <Button
              key={m.farmId}
              variant="outlined"
              size="large"
              disabled={busy}
              onClick={() => attempt(m.farmId)}
              sx={{ justifyContent: "space-between" }}
            >
              {m.farmName}
              <Typography variant="caption" color="text.secondary">
                {ROLE_LABEL[m.role]}
              </Typography>
            </Button>
          ))}
          <Button color="inherit" onClick={() => setChoices(null)} disabled={busy}>
            Volver
          </Button>
        </Stack>
      </AuthLayout>
    );
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
