/**
 * `/olvide-mi-clave`.
 *
 * Where the deployment can send email (GET /v1/auth/password-reset says
 * `available`), the person types their address and gets a link to
 * `/restablecer-clave`. The answer is the same whether or not the address has
 * an account, so the screen says "if it is registered" and never "we found
 * you".
 *
 * Without email there is no self-service reset, and the page says plainly
 * who can help instead. That used to send people to Configuración → Usuarios,
 * which cannot change a password; it now says what the owner actually can do.
 */
import { useState, type FormEvent } from "react";
import { Link as RouterLink } from "react-router-dom";
import { Alert, Button, CircularProgress, Stack, TextField, Typography } from "@mui/material";
import { AuthLayout } from "./AuthLayout";
import { api } from "../../api/endpoints";
import { messageFor } from "../../api/errors";
import { useAsync } from "../../lib/useAsync";

const TEXT = { fontSize: "1.15rem" } as const;

function BackButton() {
  return (
    <Button
      component={RouterLink}
      to="/entrar"
      variant="outlined"
      size="large"
      sx={{ minHeight: 56, fontSize: "1.15rem" }}
    >
      Volver a entrar
    </Button>
  );
}

function NoEmailHelp() {
  return (
    <Stack spacing={2.5}>
      <Typography sx={TEXT}>Su usuario es el correo con el que entra a la finca.</Typography>
      <Typography sx={TEXT}>
        Si no recuerda la clave, pídale al <strong>dueño</strong> de la finca que lo quite en{" "}
        <strong>Configuración → Usuarios</strong> y lo vuelva a agregar con una clave nueva.
      </Typography>
      <Typography sx={TEXT}>
        Si recuerda la clave y solo quiere cambiarla, entre y use <strong>Cambiar clave</strong>.
      </Typography>
      <BackButton />
    </Stack>
  );
}

export function ForgotPasswordPage() {
  const { data: available, loading } = useAsync(() => api.passwordResetAvailable().catch(() => false), []);
  const [email, setEmail] = useState("");
  const [sent, setSent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    if (!email.includes("@")) {
      setError("Escriba el correo con el que entra a la finca.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await api.requestPasswordReset(email.trim());
      setSent(true);
    } catch (err) {
      setError(messageFor(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <AuthLayout title="¿Olvidó su clave?">
      {loading ? (
        <Stack alignItems="center" sx={{ py: 4 }}>
          <CircularProgress aria-label="Cargando" />
        </Stack>
      ) : !available ? (
        <NoEmailHelp />
      ) : sent ? (
        <Stack spacing={2.5}>
          <Alert severity="success" sx={{ fontSize: "1.1rem" }}>
            Si ese correo está registrado, le enviamos un enlace para poner una clave nueva.
          </Alert>
          <Typography sx={TEXT}>
            Ábralo en los próximos 30 minutos. Si no le llega, revise la carpeta de correo no deseado.
          </Typography>
          <BackButton />
        </Stack>
      ) : (
        <Stack component="form" spacing={2.5} onSubmit={onSubmit} noValidate>
          <Typography sx={TEXT}>
            Escriba el correo con el que entra a la finca. Le enviaremos un enlace para poner una clave nueva.
          </Typography>
          {error && <Alert severity="error">{error}</Alert>}
          <TextField
            label="Correo"
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            autoComplete="username"
            autoFocus
            fullWidth
            required
          />
          <Button
            type="submit"
            variant="contained"
            size="large"
            disabled={busy}
            sx={{ minHeight: 56, fontSize: "1.15rem" }}
          >
            {busy ? "Enviando…" : "Enviarme el enlace"}
          </Button>
          <BackButton />
        </Stack>
      )}
    </AuthLayout>
  );
}
