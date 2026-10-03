/**
 * «Cambiar clave», for every role (issue #145: until this card a password
 * could not be changed at all).
 *
 * The server closes every other session of the account and answers with a
 * new one for this device, which `api.changePassword` installs, so nothing
 * here signs the person out.
 */
import { useEffect, useRef, useState, type SubmitEvent } from "react";
import { useLocation } from "react-router-dom";
import {
  Alert,
  Button,
  Card,
  CardContent,
  Stack,
  TextField,
  Typography,
} from "@mui/material";
import { api } from "../../api/endpoints";
import { ApiError, messageFor } from "../../api/errors";

export function ChangePasswordCard() {
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [repeat, setRepeat] = useState("");
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const ref = useRef<HTMLDivElement>(null);
  const { hash } = useLocation();

  // «Cambiar clave» in the account menu lands here with #clave.
  useEffect(() => {
    if (hash === "#clave")
      ref.current?.scrollIntoView?.({ behavior: "smooth", block: "start" });
  }, [hash]);

  async function onSubmit(e: SubmitEvent) {
    e.preventDefault();
    setDone(false);
    if (!current) {
      setError("Escriba su clave actual.");
      return;
    }
    if (next.length < 10) {
      setError("La clave nueva debe tener al menos 10 caracteres.");
      return;
    }
    if (next !== repeat) {
      setError("Las dos claves nuevas no coinciden.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await api.changePassword(current, next);
      setDone(true);
      setCurrent("");
      setNext("");
      setRepeat("");
    } catch (err) {
      if (err instanceof ApiError && err.code === "INVALID_CREDENTIALS")
        setError("La clave actual no es correcta.");
      else setError(messageFor(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card id="clave" ref={ref}>
      <CardContent>
        <Typography variant="h3" gutterBottom>
          Cambiar clave
        </Typography>
        <Typography
          sx={{
            color: "text.secondary",
            mb: 2,
          }}
        >
          Al cambiarla se cierran las sesiones abiertas en otros celulares y
          computadores. Este equipo sigue adentro.
        </Typography>
        <Stack
          component="form"
          spacing={2}
          onSubmit={onSubmit}
          noValidate
          sx={{ maxWidth: 480 }}
        >
          {done && <Alert severity="success">Su clave cambió.</Alert>}
          {error && <Alert severity="error">{error}</Alert>}
          <TextField
            label="Clave actual"
            type="password"
            value={current}
            onChange={(e) => setCurrent(e.target.value)}
            autoComplete="current-password"
            fullWidth
          />
          <TextField
            label="Clave nueva"
            type="password"
            value={next}
            onChange={(e) => setNext(e.target.value)}
            autoComplete="new-password"
            helperText="Al menos 10 caracteres."
            fullWidth
          />
          <TextField
            label="Repita la clave nueva"
            type="password"
            value={repeat}
            onChange={(e) => setRepeat(e.target.value)}
            autoComplete="new-password"
            fullWidth
          />
          <Button
            type="submit"
            variant="contained"
            disabled={busy}
            sx={{ alignSelf: "flex-start", minHeight: 48 }}
          >
            {busy ? "Guardando…" : "Cambiar clave"}
          </Button>
        </Stack>
      </CardContent>
    </Card>
  );
}
