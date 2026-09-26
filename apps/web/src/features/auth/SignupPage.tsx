/**
 * Public farm registration — decision 2 in `docs/decisiones.md`, and the
 * landing's main button ("Cree su finca gratis").
 *
 * Five fields and one button: the farm's name, its web address (filled from
 * the name, editable, checked while they type), the owner's name, email and
 * password. Everything else is asked for later, inside the app, by someone who
 * has already decided to stay. There is no mailer yet: the farm is usable as
 * soon as they submit, and the next screen is the waiting page that follows
 * the farm's own address until it answers.
 */
import { useState, type FormEvent } from "react";
import { Link as RouterLink, useNavigate } from "react-router-dom";
import {
  Alert, Box, Button, IconButton, InputAdornment, Link, Stack, TextField, Typography,
} from "@mui/material";
import Visibility from "@mui/icons-material/Visibility";
import VisibilityOff from "@mui/icons-material/VisibilityOff";
import { AuthLayout } from "./AuthLayout";
import { api } from "../../api/endpoints";
import { ApiError, messageFor } from "../../api/errors";
import { farmSlugProblem } from "../../lib/farmHost";
import {
  FarmUrlField, slugErrorFromApi, useFarmUrl, useSlugCheck,
} from "../../components/FarmUrlField";

const BIG = { "& .MuiInputBase-input": { fontSize: "1.2rem" }, "& .MuiInputLabel-root": { fontSize: "1.1rem" } };

export function SignupPage() {
  const navigate = useNavigate();
  const [farmName, setFarmName] = useState("");
  const url = useFarmUrl();
  const check = useSlugCheck(url.slug);
  const [ownerName, setOwnerName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [fields, setFields] = useState<Record<string, string>>({});
  const [slugError, setSlugError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [existingAccount, setExistingAccount] = useState<string | null>(null);

  function localErrors(): Record<string, string> {
    const e: Record<string, string> = {};
    if (!farmName.trim()) e["farm.name"] = "Escriba el nombre de la finca.";
    const slugProblem = farmSlugProblem(url.slug);
    if (slugProblem) e["farm.slug"] = slugProblem;
    else if (check === "taken") e["farm.slug"] = "Esa dirección ya la tiene otra finca. Escriba otra.";
    if (!ownerName.trim()) e["owner.name"] = "Escriba su nombre.";
    if (!email.trim()) e["owner.email"] = "Escriba su correo.";
    else if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email.trim())) {
      e["owner.email"] = "Ese correo no parece válido. Revíselo.";
    }
    // Ten, because that is what the server enforces. Length, not a
    // character-class rule: a long phrase beats a symbol written on paper.
    if (password.length < 10) e["owner.password"] = "La clave debe tener al menos 10 letras o números.";
    return e;
  }

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setSlugError(null);
    const local = localErrors();
    setFields(local);
    if (local["farm.slug"]) setSlugError(local["farm.slug"]);
    if (Object.keys(local).length) return;

    setBusy(true);
    try {
      const res = await api.signup({
        farm: { name: farmName.trim(), slug: url.slug, timezone: "America/Bogota", currency: "COP" },
        owner: { email: email.trim(), name: ownerName.trim(), password },
      });
      if (res.verificationRequired) {
        setExistingAccount(email.trim());
        return;
      }
      navigate(`/preparando/${url.slug}`);
    } catch (err) {
      const slugMsg = slugErrorFromApi(err);
      if (slugMsg) {
        setSlugError(slugMsg);
      } else {
        if (err instanceof ApiError && Object.keys(err.fieldErrors).length) {
          setFields(err.fieldErrors);
        }
        setError(messageFor(err));
      }
    } finally {
      setBusy(false);
    }
  }

  if (existingAccount) {
    return (
      <AuthLayout title="Ese correo ya tiene cuenta" wide>
        <Stack spacing={3}>
          <Typography sx={{ fontSize: "1.2rem" }}>
            Ya existe una cuenta con <strong>{existingAccount}</strong>. No creamos nada nuevo.
          </Typography>
          <Typography sx={{ fontSize: "1.1rem" }}>
            Entre con su clave de siempre.
          </Typography>
          <Button component={RouterLink} to="/entrar" variant="contained" size="large" sx={{ minHeight: 60, fontSize: "1.2rem" }}>
            Entrar
          </Button>
        </Stack>
      </AuthLayout>
    );
  }

  return (
    <AuthLayout
      title="Cree su finca"
      subtitle="Es gratis. En unos minutos tiene su finca con su propia dirección en internet."
      wide
    >
      <Box component="form" onSubmit={onSubmit} noValidate>
        <Stack spacing={3}>
          {error && <Alert severity="error" sx={{ fontSize: "1.05rem" }}>{error}</Alert>}

          <TextField
            label="Nombre de la finca"
            value={farmName}
            onChange={(e) => {
              setFarmName(e.target.value);
              url.followName(e.target.value);
              setSlugError(null);
            }}
            error={!!fields["farm.name"]}
            helperText={fields["farm.name"] ?? "Ejemplo: La Palma"}
            fullWidth
            autoFocus
            required
            sx={BIG}
          />
          <FarmUrlField
            slug={url.slug}
            onChange={(v) => {
              url.setSlug(v);
              setSlugError(null);
            }}
            check={check}
            serverError={slugError}
          />
          <TextField
            label="Su nombre"
            value={ownerName}
            onChange={(e) => setOwnerName(e.target.value)}
            error={!!fields["owner.name"]}
            helperText={fields["owner.name"]}
            autoComplete="name"
            fullWidth
            required
            sx={BIG}
          />
          <TextField
            label="Correo"
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            error={!!fields["owner.email"]}
            helperText={fields["owner.email"] ?? "Con este correo va a entrar a su finca."}
            autoComplete="email"
            fullWidth
            required
            sx={BIG}
          />
          <TextField
            label="Clave"
            type={showPassword ? "text" : "password"}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            error={!!fields["owner.password"]}
            helperText={fields["owner.password"] ?? "Mínimo 10 letras o números. Una frase corta sirve."}
            autoComplete="new-password"
            fullWidth
            required
            sx={BIG}
            slotProps={{
              input: {
                endAdornment: (
                  <InputAdornment position="end">
                    <IconButton
                      aria-label={showPassword ? "Ocultar clave" : "Ver clave"}
                      onClick={() => setShowPassword((v) => !v)}
                      edge="end"
                      size="large"
                    >
                      {showPassword ? <VisibilityOff /> : <Visibility />}
                    </IconButton>
                  </InputAdornment>
                ),
              },
            }}
          />

          <Button
            type="submit"
            variant="contained"
            size="large"
            disabled={busy}
            fullWidth
            sx={{ minHeight: 64, fontSize: "1.25rem", borderRadius: 999 }}
          >
            {busy ? "Creando su finca…" : "Crear mi finca"}
          </Button>
          <Typography sx={{ fontSize: "1.05rem" }} color="text.secondary" textAlign="center">
            ¿Ya tiene cuenta? <Link component={RouterLink} to="/entrar">Entrar</Link>
          </Typography>
        </Stack>
      </Box>
    </AuthLayout>
  );
}
