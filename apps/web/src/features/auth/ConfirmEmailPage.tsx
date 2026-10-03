/**
 * `/confirmar-correo#<secreto>`: the link signup mails when this deployment
 * sends email.
 *
 * The link alone does not confirm: the page also asks for the password chosen
 * at signup. A link that reached this mailbox because somebody else registered
 * the address must not hand them the account, and they have no mailbox to
 * open it. The secret is read from the fragment (never sent to a server or in
 * a Referer) and wiped from the address bar at once.
 *
 * Confirming starts building the farm's own address, so the page goes on to
 * the waiting screen for that farm.
 */
import { useState, type SubmitEvent, type ReactNode } from "react";
import { Link as RouterLink, useNavigate } from "react-router-dom";
import { Alert, Button, Stack, TextField, Typography } from "@mui/material";
import { AuthLayout } from "./AuthLayout";
import { api } from "../../api/endpoints";
import { ApiError, messageFor } from "../../api/errors";

const TEXT = { fontSize: "1.15rem" } as const;
const BIG = { minHeight: 56, fontSize: "1.15rem" } as const;

function readSecret(): string {
  const raw = window.location.hash.replace(/^#/, "");
  const secret = raw.startsWith("token=") ? raw.slice("token=".length) : raw;
  if (raw) window.history.replaceState(null, "", window.location.pathname + window.location.search);
  return secret;
}

export function ConfirmEmailPage() {
  const navigate = useNavigate();
  const [secret] = useState(readSecret);
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [expired, setExpired] = useState(!secret);
  const [done, setDone] = useState(false);

  async function onSubmit(e: SubmitEvent) {
    e.preventDefault();
    if (!password) {
      setError("Escriba la clave que eligió al registrarse.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const res = await api.verifyEmail(secret, password);
      if (res.slug) {
        navigate(`/preparando/${res.slug}`, { replace: true });
        return;
      }
      setDone(true);
    } catch (err) {
      if (err instanceof ApiError && err.status === 400) setExpired(true);
      else if (err instanceof ApiError && err.status === 401)
        setError("Esa no es la clave que se eligió al registrar la finca. Si no la recuerda, use «¿Olvidó su clave?» en la pantalla de entrada.");
      else setError(messageFor(err));
    } finally {
      setBusy(false);
    }
  }

  let content: ReactNode;
  if (done) {
    content = (
      <Stack spacing={2.5}>
        <Alert severity="success" sx={{ fontSize: "1.1rem" }}>
          Listo, su correo quedó confirmado.
        </Alert>
        <Button component={RouterLink} to="/entrar" variant="contained" size="large" sx={BIG}>
          Entrar
        </Button>
      </Stack>
    );
  } else if (expired) {
    content = (
      <Stack spacing={2.5}>
        <Alert severity="warning" sx={{ fontSize: "1.1rem" }}>
          Este enlace ya no sirve: vence a las 48 horas, se usa una sola vez y deja de servir si se volvió a
          registrar la finca con este correo.
        </Alert>
        <Typography sx={TEXT}>
          Si ya confirmó, entre normalmente. Si no, puede registrar la finca otra vez o usar «¿Olvidó su clave?»,
          que también confirma el correo.
        </Typography>
        <Button component={RouterLink} to="/entrar" variant="contained" size="large" sx={BIG}>
          Ir a entrar
        </Button>
      </Stack>
    );
  } else {
    content = (
      <Stack component="form" spacing={2.5} onSubmit={onSubmit} noValidate>
        <Typography sx={TEXT}>
          Para confirmar que este correo es suyo, escriba la clave que eligió al registrar la finca.
        </Typography>
        {error && <Alert severity="error">{error}</Alert>}
        <TextField
          label="Su clave"
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          autoComplete="current-password"
          autoFocus
          fullWidth
          required
        />
        <Button type="submit" variant="contained" size="large" disabled={busy} sx={BIG}>
          {busy ? "Confirmando…" : "Confirmar correo"}
        </Button>
      </Stack>
    );
  }

  return <AuthLayout title="Confirmar su correo">{content}</AuthLayout>;
}
