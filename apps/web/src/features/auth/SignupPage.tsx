/**
 * Public farm registration — decision 2 in `docs/decisiones.md`.
 *
 * This is now the front door: the super-admin console is no longer where a
 * farm is created. Which also makes it the most exposed surface in the system,
 * so the form asks for as little as it can get away with. There is no mailer
 * yet: the farm is usable as soon as they submit. When mail is wired, the
 * mailbox click becomes the gate again.
 * Everything else is asked for later, inside the app, by someone who has
 * already decided to stay.
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
import { parseMoneyInput } from "../../lib/money";
import { farmUrlForHere, isFarmSlug, slugifyFarmName } from "../../lib/farmHost";

export function SignupPage() {
  const navigate = useNavigate();
  const [farmName, setFarmName] = useState("");
  const [slug, setSlug] = useState("");
  const [slugTouched, setSlugTouched] = useState(false);
  const [price, setPrice] = useState("");
  const [ownerName, setOwnerName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [fields, setFields] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [sentTo, setSentTo] = useState<string | null>(null);
  /**
   * Only ever set in development, where the server has no mail sender and
   * echoes the verification token in the signup response instead. Holding it
   * is what lets the screen offer "confirmar y entrar" honestly, rather than
   * telling somebody to check a mailbox nothing was sent to.
   */
  const [devToken, setDevToken] = useState<string | null>(null);

  const priceCents = parseMoneyInput(price) ?? 0;

  function localErrors(): Record<string, string> {
    const e: Record<string, string> = {};
    if (!farmName.trim()) e["farm.name"] = "Escriba el nombre de la finca.";
    if (!isFarmSlug(slug)) {
      e["farm.slug"] = "Use letras minúsculas, números y guiones. Ej: fincasanjose";
    }
    // The server refuses a farm without a price: it seeds every new farm with
    // a "Recolección" activity priced from this, so there is no such thing as
    // a farm that has not decided what a kilo is worth.
    if (priceCents <= 0) e["farm.priceCents"] = "Escriba cuánto paga por kilo.";
    if (!ownerName.trim()) e["owner.name"] = "Escriba su nombre.";
    if (!email.trim()) e["owner.email"] = "Escriba su correo.";
    else if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
      e["owner.email"] = "Ese correo no parece válido.";
    }
    // Ten, because that is what the server enforces. Sprint 1 asked for eight
    // here and let the server reject the ninth character's absence with an
    // English sentence — the form has to agree with the rule it is fronting.
    // Length, not a character-class rule: a farm owner typing on a phone is
    // better served by a long phrase than by a symbol they will write down.
    if (password.length < 10) e["owner.password"] = "Use al menos 10 caracteres.";
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
          slug,
          timezone: "America/Bogota",
          currency: "COP",
          priceCents,
        },
        owner: { email: email.trim(), name: ownerName.trim(), password },
      });
      setDevToken(res.verificationToken);
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
    const url = slug ? farmUrlForHere(slug) : "";
    return (
      <AuthLayout title="Su finca está lista" wide>
        <Stack spacing={2} alignItems="flex-start">
          <Typography>
            Registramos <strong>{sentTo}</strong>
            {url ? (
              <>
                . Entre por{" "}
                <Box component="span" sx={{ fontFamily: "ui-monospace, monospace" }}>
                  {url}
                </Box>
              </>
            ) : (
              "."
            )}
          </Typography>
          <Typography color="text.secondary" variant="body2">
            Use el mismo correo y la clave que acaba de escribir.
          </Typography>
          {devToken && (
            <Alert severity="info" sx={{ width: "100%" }}>
              Puede confirmar el correo ahora, o entrar directo: el alta ya quedó verificada.
              {" "}
              <Link
                component="button"
                type="button"
                onClick={async () => {
                  try {
                    await api.verifyEmail(devToken);
                    navigate("/entrar");
                  } catch (err) {
                    setError(messageFor(err));
                  }
                }}
              >
                Confirmar correo
              </Link>
            </Alert>
          )}
          <Button component={RouterLink} to="/entrar" variant="contained">
            Entrar a mi finca
          </Button>
        </Stack>
      </AuthLayout>
    );
  }

  return (
    <AuthLayout
      title="Crear mi finca"
      subtitle="En un minuto tiene nombre, dueño y su propia dirección en internet."
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
            onChange={(e) => {
              const v = e.target.value;
              setFarmName(v);
              if (!slugTouched) setSlug(slugifyFarmName(v));
            }}
            error={!!fields["farm.name"]}
            helperText={fields["farm.name"]}
            size="medium"
            fullWidth
            autoFocus
            required
          />
          <TextField
            label="Identificador (URL)"
            value={slug}
            onChange={(e) => {
              setSlugTouched(true);
              setSlug(e.target.value.trim().toLowerCase());
            }}
            error={!!fields["farm.slug"]}
            helperText={
              fields["farm.slug"] ||
              (slug ? `Su finca: ${farmUrlForHere(slug)}` : "Ej: fincasanjose")
            }
            size="medium"
            fullWidth
            required
          />
          {/*
            The price of a kilo, and not the farm's address.

            Sprint 1 asked here for departamento and municipio, which the API
            has nowhere to put: a department and a municipality describe a
            PLOT, and the farm's own location is set later in Configuración.
            What the server does require is this, because it seeds the new farm
            with a "Recolección" activity priced from it — so this field is the
            difference between a farm that can weigh coffee on day one and one
            that cannot.
          */}
          <TextField
            label="Precio por kilo de café"
            value={price}
            onChange={(e) => setPrice(e.target.value)}
            error={!!fields["farm.priceCents"]}
            helperText={
              fields["farm.priceCents"] ??
              "Lo que paga hoy por kilo recogido. Lo puede cambiar cada semana."
            }
            size="medium"
            fullWidth
            required
            inputMode="numeric"
          />
          <Typography variant="caption" color="text.secondary" sx={{ mt: -1 }}>
            El municipio y el departamento se piden después, en cada lote.
          </Typography>

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
            type={showPassword ? "text" : "password"}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            error={!!fields["owner.password"]}
            helperText={fields["owner.password"] ?? "Mínimo 10 caracteres."}
            autoComplete="new-password"
            size="medium"
            fullWidth
            required
            slotProps={{
              input: {
                endAdornment: (
                  <InputAdornment position="end">
                    <IconButton
                      aria-label={showPassword ? "Ocultar contraseña" : "Ver contraseña"}
                      onClick={() => setShowPassword((v) => !v)}
                      edge="end"
                    >
                      {showPassword ? <VisibilityOff /> : <Visibility />}
                    </IconButton>
                  </InputAdornment>
                ),
              },
            }}
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
