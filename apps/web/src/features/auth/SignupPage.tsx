/**
 * Public farm registration — decision 2 in `docs/decisiones.md`.
 *
 * This is now the front door: the super-admin console is no longer where a
 * farm is created. Which also makes it the most exposed surface in the system,
 * so the copy is explicit that a verification mail has to be opened before
 * anything works, and the form asks for as little as it can get away with.
 * Everything else is asked for later, inside the app, by someone who has
 * already decided to stay.
 */
import { useState, type FormEvent } from "react";
import { Link as RouterLink, useNavigate } from "react-router-dom";
import {
  Alert, Box, Button, Grid, Link, MenuItem, Stack, TextField, Typography,
} from "@mui/material";
import MarkEmailUnreadIcon from "@mui/icons-material/MarkEmailUnread";
import { AuthLayout } from "./AuthLayout";
import { api } from "../../api/endpoints";
import { ApiError, messageFor } from "../../api/errors";

/** Coffee-growing departments first: it is who this is for. */
const DEPARTMENTS = [
  "Caldas", "Quindío", "Risaralda", "Antioquia", "Huila", "Tolima",
  "Nariño", "Cauca", "Santander", "Norte de Santander", "Cundinamarca",
  "Valle del Cauca", "Cesar", "Magdalena", "Boyacá", "Otro",
];

export function SignupPage() {
  const navigate = useNavigate();
  const [farmName, setFarmName] = useState("");
  const [department, setDepartment] = useState("Caldas");
  const [municipality, setMunicipality] = useState("");
  const [ownerName, setOwnerName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [fields, setFields] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [sentTo, setSentTo] = useState<string | null>(null);

  function localErrors(): Record<string, string> {
    const e: Record<string, string> = {};
    if (!farmName.trim()) e["farm.name"] = "Escriba el nombre de la finca.";
    if (!municipality.trim()) e["farm.municipality"] = "Escriba el municipio.";
    if (!ownerName.trim()) e["owner.name"] = "Escriba su nombre.";
    if (!email.trim()) e["owner.email"] = "Escriba su correo.";
    else if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
      e["owner.email"] = "Ese correo no parece válido.";
    }
    // Length, not a character-class rule: a farm owner typing on a phone is
    // better served by a long phrase than by a symbol they will write down.
    if (password.length < 8) e["owner.password"] = "Use al menos 8 caracteres.";
    return e;
  }

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    const local = localErrors();
    setFields(local);
    if (Object.keys(local).length) return;

    setBusy(true);
    try {
      const res = await api.signup({
        farm: {
          name: farmName.trim(),
          timezone: "America/Bogota",
          department,
          municipality: municipality.trim(),
        },
        owner: { email: email.trim(), name: ownerName.trim(), password },
      });
      setSentTo(res.verificationEmailSentTo);
    } catch (err) {
      if (err instanceof ApiError && Object.keys(err.fieldErrors).length) {
        setFields(err.fieldErrors);
      }
      setError(messageFor(err));
    } finally {
      setBusy(false);
    }
  }

  if (sentTo) {
    return (
      <AuthLayout title="Revise su correo" wide>
        <Stack spacing={2} alignItems="flex-start">
          <MarkEmailUnreadIcon color="primary" sx={{ fontSize: 48 }} />
          <Typography>
            Le enviamos un mensaje a <strong>{sentTo}</strong>. Abra el enlace que
            trae y su finca queda lista para usar.
          </Typography>
          <Typography color="text.secondary" variant="body2">
            Si no llega en unos minutos, revise la carpeta de correo no deseado.
          </Typography>
          {import.meta.env.VITE_USE_MOCKS === "true" && (
            <Alert severity="info" sx={{ width: "100%" }}>
              Datos simulados: no sale ningún correo de verdad.{" "}
              <Link
                component="button"
                type="button"
                onClick={async () => {
                  await api.verifyEmail("mock");
                  navigate("/entrar");
                }}
              >
                Confirmar y entrar
              </Link>
            </Alert>
          )}
          <Button component={RouterLink} to="/entrar" variant="outlined">
            Ir a entrar
          </Button>
        </Stack>
      </AuthLayout>
    );
  }

  return (
    <AuthLayout
      title="Registrar mi finca"
      subtitle="Cree la finca y su primer usuario. No hace falta que nadie la autorice."
      wide
    >
      <Box component="form" onSubmit={onSubmit} noValidate>
        <Stack spacing={2.5}>
          {error && <Alert severity="error">{error}</Alert>}

          <Typography variant="overline" color="text.secondary">
            La finca
          </Typography>
          <TextField
            label="Nombre de la finca"
            value={farmName}
            onChange={(e) => setFarmName(e.target.value)}
            error={!!fields["farm.name"]}
            helperText={fields["farm.name"]}
            size="medium"
            fullWidth
            autoFocus
            required
          />
          <Grid container spacing={2}>
            <Grid size={{ xs: 12, sm: 6 }}>
              <TextField
                select
                label="Departamento"
                value={department}
                onChange={(e) => setDepartment(e.target.value)}
                size="medium"
                fullWidth
              >
                {DEPARTMENTS.map((d) => (
                  <MenuItem key={d} value={d}>
                    {d}
                  </MenuItem>
                ))}
              </TextField>
            </Grid>
            <Grid size={{ xs: 12, sm: 6 }}>
              <TextField
                label="Municipio"
                value={municipality}
                onChange={(e) => setMunicipality(e.target.value)}
                error={!!fields["farm.municipality"]}
                helperText={fields["farm.municipality"]}
                size="medium"
                fullWidth
                required
              />
            </Grid>
          </Grid>

          <Typography variant="overline" color="text.secondary">
            Su usuario
          </Typography>
          <TextField
            label="Su nombre"
            value={ownerName}
            onChange={(e) => setOwnerName(e.target.value)}
            error={!!fields["owner.name"]}
            helperText={fields["owner.name"]}
            size="medium"
            fullWidth
            required
          />
          <TextField
            label="Correo"
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            error={!!fields["owner.email"]}
            helperText={fields["owner.email"] ?? "Le enviaremos un enlace de confirmación."}
            autoComplete="email"
            size="medium"
            fullWidth
            required
          />
          <TextField
            label="Contraseña"
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            error={!!fields["owner.password"]}
            helperText={fields["owner.password"] ?? "Mínimo 8 caracteres."}
            autoComplete="new-password"
            size="medium"
            fullWidth
            required
          />

          <Button type="submit" variant="contained" size="large" disabled={busy} fullWidth>
            {busy ? "Creando la finca…" : "Crear finca"}
          </Button>
          <Typography variant="body2" color="text.secondary" textAlign="center">
            ¿Ya tiene cuenta? <Link component={RouterLink} to="/entrar">Entrar</Link>
          </Typography>
        </Stack>
      </Box>
    </AuthLayout>
  );
}
