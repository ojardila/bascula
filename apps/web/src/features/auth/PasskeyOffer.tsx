// SPDX-License-Identifier: MIT
import { useState } from "react";
import { Alert, Button, Stack, Typography } from "@mui/material";
import Fingerprint from "@mui/icons-material/Fingerprint";
import { AuthLayout } from "./AuthLayout";
import { api } from "../../api/endpoints";
import { messageFor } from "../../api/errors";
import { deviceLabel } from "../../lib/deviceLabel";
import { passkeyAlreadyHere, passkeyCancelled } from "../../lib/passkeys";
import { DEFAULT_PASSKEY_NAME } from "../config/PasskeysCard";

/** The name the new passkey gets: the device, when we can tell what it is. */
export function offeredPasskeyName(ua: string): string {
  const label = deviceLabel(ua);
  return label === "Dispositivo desconocido" ? DEFAULT_PASSKEY_NAME : label;
}

interface Props {
  /**
   * The password the person typed a moment ago to open this session. It is
   * only held in memory by the login screen and spent here once, on the same
   * check «Agregar llave de acceso» asks for; never stored.
   */
  readonly password: string;
  /** Go on to the app, whatever happened here. */
  readonly onDone: () => void;
}

/**
 * «¿Quiere entrar más rápido la próxima vez?», shown once after a password
 * sign-in. One clear action, and «Ahora no» right below it.
 */
export function PasskeyOffer({ password, onDone }: Props) {
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function accept() {
    setBusy(true);
    setError(null);
    try {
      await api.addPasskey(offeredPasskeyName(navigator.userAgent), password);
      setSaved(true);
    } catch (e) {
      if (passkeyCancelled(e)) {
        onDone();
        return;
      }
      setError(
        passkeyAlreadyHere(e)
          ? "Este dispositivo ya tiene una llave de acceso para su cuenta."
          : messageFor(e),
      );
    } finally {
      setBusy(false);
    }
  }

  if (saved || error) {
    return (
      <AuthLayout title={saved ? "Listo" : "No se pudo activar"}>
        <Stack spacing={2}>
          {saved ? (
            <Alert severity="success">
              La próxima vez toque «Entrar con llave de acceso» y use su huella
              o su cara.
            </Alert>
          ) : (
            <Alert severity="error">{error}</Alert>
          )}
          <Button variant="contained" size="large" fullWidth onClick={onDone}>
            Continuar
          </Button>
        </Stack>
      </AuthLayout>
    );
  }

  return (
    <AuthLayout
      title="¿Quiere entrar más rápido la próxima vez?"
      subtitle="Puede entrar con la huella o la cara de este dispositivo, sin escribir la contraseña."
    >
      <Stack spacing={2}>
        <Button
          variant="contained"
          size="large"
          fullWidth
          startIcon={<Fingerprint />}
          onClick={() => void accept()}
          disabled={busy}
        >
          {busy ? "Esperando…" : "Sí, activarlo"}
        </Button>
        <Button
          color="inherit"
          size="large"
          fullWidth
          onClick={onDone}
          disabled={busy}
        >
          Ahora no
        </Button>
        <Typography variant="body2" sx={{ color: "text.secondary" }}>
          Su contraseña sigue sirviendo igual. No se lo volveremos a preguntar
          en este dispositivo.
        </Typography>
      </Stack>
    </AuthLayout>
  );
}
