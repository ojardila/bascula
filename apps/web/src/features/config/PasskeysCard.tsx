import { useState } from "react";
import {
  Alert, Button, Card, CardContent, Divider, IconButton, Stack, TextField, Typography,
} from "@mui/material";
import DeleteOutlineIcon from "@mui/icons-material/DeleteOutline";
import Fingerprint from "@mui/icons-material/Fingerprint";
import { api, type PasskeyItem } from "../../api/endpoints";
import { messageFor } from "../../api/errors";
import { useAuth } from "../../auth/AuthContext";
import { ConfirmDialog } from "../../components/ConfirmDialog";
import { useAsync } from "../../lib/useAsync";
import { passkeyAlreadyHere, passkeyCancelled, passkeysSupported } from "../../lib/passkeys";

/** What the passkey is called when the person leaves the name empty. */
export const DEFAULT_PASSKEY_NAME = "Llave de acceso";

function formatWhen(iso: string, timeZone: string): string {
  try {
    return new Date(iso).toLocaleString("es-CO", { dateStyle: "long", timeStyle: "short", timeZone });
  } catch {
    return new Date(iso).toLocaleString("es-CO");
  }
}

/**
 * «Llaves de acceso»: optional passkeys, so a person can enter with the
 * phone's fingerprint or face instead of typing the password. The password
 * keeps working; a passkey is one more way in, never the only one.
 *
 * Passkeys belong to the person, not the farm, which is why this card sits on
 * «Conexiones» (every role) as well as Configuración.
 */
export function PasskeysCard() {
  const { user } = useAuth();
  const tz = user?.farm?.timezone ?? "America/Bogota";
  const { data, error: loadError, reload } = useAsync(() => api.listPasskeys(), []);
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [added, setAdded] = useState(false);
  const [removing, setRemoving] = useState<PasskeyItem | null>(null);
  const supported = passkeysSupported();

  async function add() {
    setError(null);
    setAdded(false);
    setBusy(true);
    try {
      await api.addPasskey(name.trim() || DEFAULT_PASSKEY_NAME);
      setName("");
      setAdded(true);
      reload();
    } catch (e) {
      if (passkeyCancelled(e)) return;
      setError(
        passkeyAlreadyHere(e)
          ? "Este dispositivo ya tiene una llave de acceso para su cuenta."
          : messageFor(e),
      );
    } finally {
      setBusy(false);
    }
  }

  async function remove() {
    if (!removing) return;
    setBusy(true);
    try {
      await api.deletePasskey(removing.id);
      setRemoving(null);
      reload();
    } catch (e) {
      setError(messageFor(e));
      setRemoving(null);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card>
      <CardContent>
        <Typography variant="h3" gutterBottom>
          Llaves de acceso
        </Typography>
        <Typography color="text.secondary" sx={{ mb: 2 }}>
          Entre con la huella o la cara de su celular en lugar de escribir la contraseña. Es
          opcional: su contraseña sigue sirviendo igual.
        </Typography>

        {loadError && <Alert severity="error" sx={{ mb: 2 }}>{loadError}</Alert>}
        {error && <Alert severity="error" sx={{ mb: 2 }}>{error}</Alert>}
        {added && <Alert severity="success" sx={{ mb: 2 }}>Llave de acceso guardada.</Alert>}

        {data && data.length > 0 && (
          <Stack divider={<Divider flexItem />} sx={{ mb: 2 }}>
            {data.map((p) => (
              <Stack key={p.id} direction="row" alignItems="center" spacing={1.5} sx={{ py: 1 }}>
                <Fingerprint color="action" />
                <Stack sx={{ flex: 1, minWidth: 0 }}>
                  <Typography sx={{ fontWeight: 600 }} noWrap>{p.name}</Typography>
                  <Typography variant="caption" color="text.secondary">
                    {p.lastUsedAt
                      ? `Último uso: ${formatWhen(p.lastUsedAt, tz)}`
                      : `Creada: ${formatWhen(p.createdAt, tz)}`}
                  </Typography>
                </Stack>
                <IconButton
                  aria-label={`Quitar ${p.name}`}
                  onClick={() => setRemoving(p)}
                  disabled={busy}
                >
                  <DeleteOutlineIcon />
                </IconButton>
              </Stack>
            ))}
          </Stack>
        )}
        {data && data.length === 0 && (
          <Typography color="text.secondary" sx={{ mb: 2 }}>
            Todavía no tiene llaves de acceso.
          </Typography>
        )}

        {supported ? (
          <Stack direction={{ xs: "column", sm: "row" }} spacing={1.5}>
            <TextField
              label="Nombre (opcional)"
              placeholder="Por ejemplo: Mi celular"
              value={name}
              onChange={(e) => setName(e.target.value)}
              slotProps={{ htmlInput: { maxLength: 60 } }}
              sx={{ flex: 1 }}
            />
            <Button
              variant="contained"
              size="large"
              startIcon={<Fingerprint />}
              onClick={() => void add()}
              disabled={busy}
              sx={{ whiteSpace: "nowrap" }}
            >
              {busy ? "Esperando…" : "Agregar llave de acceso"}
            </Button>
          </Stack>
        ) : (
          <Alert severity="info">Este navegador no permite llaves de acceso.</Alert>
        )}
      </CardContent>

      <ConfirmDialog
        open={removing !== null}
        title="¿Quitar la llave de acceso?"
        body={`«${removing?.name ?? ""}» ya no servirá para entrar. Su contraseña sigue igual.`}
        confirmLabel="Quitar"
        destructive
        busy={busy}
        onConfirm={() => void remove()}
        onCancel={() => setRemoving(null)}
      />
    </Card>
  );
}
