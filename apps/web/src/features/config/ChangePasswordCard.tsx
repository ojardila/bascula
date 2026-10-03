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
  const currentRef = useRef<HTMLInputElement>(null);
  const { hash, key } = useLocation();

  // «Cambiar clave» in the account menu lands here with #clave, and the card
  // has to end up on screen with the first field ready. Two things used to
  // stop that, so the menu item looked like it did nothing:
  //   - the cards above this one load their own data and grow after it
  //     mounts, so a single scroll on mount landed where the card USED to be,
  //     below the fold on a phone;
  //   - choosing the item again from Configuración keeps the same hash, so
  //     an effect keyed on the hash alone never ran a second time.
  // So it runs on every navigation (`key`), and keeps the card in view while
  // the page above it settles, until the person scrolls or types themselves.
  useEffect(() => {
    if (hash !== "#clave") return;
    const card = ref.current;
    if (!card) return;
    const bring = () => card.scrollIntoView?.({ block: "start" });
    bring();
    currentRef.current?.focus({ preventScroll: true });

    const observer =
      typeof ResizeObserver === "undefined" ? null : new ResizeObserver(bring);
    observer?.observe(document.body);
    const stopOn = ["wheel", "touchstart", "keydown"] as const;
    const stop = () => {
      observer?.disconnect();
      for (const ev of stopOn) window.removeEventListener(ev, stop);
    };
    for (const ev of stopOn) window.addEventListener(ev, stop, { passive: true });
    const timer = window.setTimeout(stop, 3000);
    return () => {
      window.clearTimeout(timer);
      stop();
    };
  }, [hash, key]);

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
    // The margin keeps the title clear of the fixed app bar.
    <Card id="clave" ref={ref} sx={{ scrollMarginTop: 80 }}>
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
            inputRef={currentRef}
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
