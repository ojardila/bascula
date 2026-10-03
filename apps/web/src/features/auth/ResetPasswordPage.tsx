// SPDX-License-Identifier: MIT
/**
 * `/restablecer-clave#<secreto>`: the link «olvidé mi clave» mails.
 *
 * The secret is in the fragment, which the browser never sends to a server or
 * in a Referer, and it is wiped from the address bar as soon as it is read so
 * it does not stay in the history. Spending it does not sign in: the person
 * goes to the login screen and types the new password, which is also how
 * they find out it works.
 */
import { useState, type SubmitEvent, type ReactNode } from "react";
import { Link as RouterLink } from "react-router-dom";
import { Alert, Button, Stack, TextField, Typography } from "@mui/material";
import { AuthLayout } from "./AuthLayout";
import { api } from "../../api/endpoints";
import { ApiError, messageFor } from "../../api/errors";

const TEXT = { fontSize: "1.15rem" } as const;

function readSecret(): string {
  const raw = window.location.hash.replace(/^#/, "");
  const secret = raw.startsWith("token=") ? raw.slice("token=".length) : raw;
  if (raw) window.history.replaceState(null, "", window.location.pathname + window.location.search);
  return secret;
}

export function ResetPasswordPage() {
  const [secret] = useState(readSecret);
  const [password, setPassword] = useState("");
  const [repeat, setRepeat] = useState("");
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [expired, setExpired] = useState(!secret);

  async function onSubmit(e: SubmitEvent) {
    e.preventDefault();
    if (password.length < 10) {
      setError("La clave nueva debe tener al menos 10 caracteres.");
      return;
    }
    if (password !== repeat) {
      setError("Las dos claves no coinciden.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await api.resetPassword(secret, password);
      setDone(true);
    } catch (err) {
      if (err instanceof ApiError && err.status === 400 && /link/.test(err.message)) setExpired(true);
      else setError(messageFor(err));
    } finally {
      setBusy(false);
    }
  }

  const toLogin = (
    <Button component={RouterLink} to="/entrar" variant="contained" size="large" sx={{ minHeight: 56, fontSize: "1.15rem" }}>
      Entrar
    </Button>
  );

  let content: ReactNode;
  if (done) {
    content = (
      <Stack spacing={2.5}>
        <Alert severity="success" sx={{ fontSize: "1.1rem" }}>
          Listo. Su clave cambió y se cerraron las sesiones abiertas en otros equipos.
        </Alert>
        {toLogin}
      </Stack>
    );
  } else if (expired) {
    content = (
      <Stack spacing={2.5}>
        <Alert severity="warning" sx={{ fontSize: "1.1rem" }}>
          Este enlace ya no sirve: vence a los 30 minutos y se puede usar una sola vez.
        </Alert>
        <Button component={RouterLink} to="/olvide-mi-clave" variant="contained" size="large" sx={{ minHeight: 56, fontSize: "1.15rem" }}>
          Pedir otro enlace
        </Button>
      </Stack>
    );
  } else {
    content = (
      <Stack component="form" spacing={2.5} onSubmit={onSubmit} noValidate>
        <Typography sx={TEXT}>Escriba su clave nueva dos veces. Debe tener al menos 10 caracteres.</Typography>
        {error && <Alert severity="error">{error}</Alert>}
        <TextField
          label="Clave nueva"
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          autoComplete="new-password"
          autoFocus
          fullWidth
          required
        />
        <TextField
          label="Repita la clave nueva"
          type="password"
          value={repeat}
          onChange={(e) => setRepeat(e.target.value)}
          autoComplete="new-password"
          fullWidth
          required
        />
        <Button type="submit" variant="contained" size="large" disabled={busy} sx={{ minHeight: 56, fontSize: "1.15rem" }}>
          {busy ? "Guardando…" : "Guardar clave nueva"}
        </Button>
      </Stack>
    );
  }

  return (
    <AuthLayout title="Poner una clave nueva">
      {content}
    </AuthLayout>
  );
}
