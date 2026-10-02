import { useState } from "react";
import {
  Alert,
  Button,
  Card,
  CardContent,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  Divider,
  IconButton,
  Stack,
  TextField,
  Typography,
} from "@mui/material";
import DeleteOutlineIcon from "@mui/icons-material/DeleteOutlineOutlined";
import Fingerprint from "@mui/icons-material/Fingerprint";
import { api, type PasskeyItem } from "../../api/endpoints";
import { ApiError, messageFor } from "../../api/errors";
import { useAuth } from "../../auth/AuthContext";
import { ConfirmDialog } from "../../components/ConfirmDialog";
import { useAsync } from "../../lib/useAsync";
import {
  passkeyAlreadyHere,
  passkeyCancelled,
  passkeysSupported,
} from "../../lib/passkeys";

/** What the passkey is called when the person leaves the name empty. */
export const DEFAULT_PASSKEY_NAME = "Llave de acceso";

function formatWhen(iso: string, timeZone: string): string {
  try {
    return new Date(iso).toLocaleString("es-CO", {
      dateStyle: "long",
      timeStyle: "short",
      timeZone,
    });
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
  const {
    data,
    error: loadError,
    reload,
  } = useAsync(() => api.listPasskeys(), []);
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [added, setAdded] = useState(false);
  const [removing, setRemoving] = useState<PasskeyItem | null>(null);
  // A passkey opens the account without the password and survives a password
  // change, so adding one asks for the password first.
  const [asking, setAsking] = useState(false);
  const [password, setPassword] = useState("");
  const [passwordError, setPasswordError] = useState<string | null>(null);
  const supported = passkeysSupported();

  function startAdding() {
    setError(null);
    setAdded(false);
    setPassword("");
    setPasswordError(null);
    setAsking(true);
  }

  async function add() {
    setPasswordError(null);
    setBusy(true);
    try {
      await api.addPasskey(name.trim() || DEFAULT_PASSKEY_NAME, password);
      setAsking(false);
      setPassword("");
      setName("");
      setAdded(true);
      reload();
    } catch (e) {
      if (e instanceof ApiError && e.code === "INVALID_CREDENTIALS") {
        setPasswordError("La clave no es correcta.");
        return;
      }
      setAsking(false);
      setPassword("");
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
        <Typography
          sx={{
            color: "text.secondary",
            mb: 2,
          }}
        >
          Entre con la huella o la cara de su celular en lugar de escribir la
          contraseña. Es opcional: su contraseña sigue sirviendo igual.
        </Typography>

        {loadError && (
          <Alert severity="error" sx={{ mb: 2 }}>
            {loadError}
          </Alert>
        )}
        {error && (
          <Alert severity="error" sx={{ mb: 2 }}>
            {error}
          </Alert>
        )}
        {added && (
          <Alert severity="success" sx={{ mb: 2 }}>
            Llave de acceso guardada.
          </Alert>
        )}

        {data && data.length > 0 && (
          <Stack divider={<Divider flexItem />} sx={{ mb: 2 }}>
            {data.map((p) => (
              <Stack
                key={p.id}
                direction="row"
                spacing={1.5}
                sx={{
                  alignItems: "center",
                  py: 1,
                }}
              >
                <Fingerprint color="action" />
                <Stack sx={{ flex: 1, minWidth: 0 }}>
                  <Typography sx={{ fontWeight: 600 }} noWrap>
                    {p.name}
                  </Typography>
                  <Typography
                    variant="caption"
                    sx={{
                      color: "text.secondary",
                    }}
                  >
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
          <Typography
            sx={{
              color: "text.secondary",
              mb: 2,
            }}
          >
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
              onClick={startAdding}
              disabled={busy}
              sx={{ whiteSpace: "nowrap" }}
            >
              {busy ? "Esperando…" : "Agregar llave de acceso"}
            </Button>
          </Stack>
        ) : (
          <Alert severity="info">
            Este navegador no permite llaves de acceso.
          </Alert>
        )}
      </CardContent>

      <Dialog
        open={asking}
        onClose={() => !busy && setAsking(false)}
        fullWidth
        maxWidth="xs"
      >
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void add();
          }}
        >
          <DialogTitle>Confirme que es usted</DialogTitle>
          <DialogContent>
            <Typography sx={{ mb: 2 }}>
              Escriba su clave para agregar la llave de acceso.
            </Typography>
            <TextField
              label="Su clave"
              type="password"
              autoComplete="current-password"
              autoFocus
              fullWidth
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              error={passwordError !== null}
              helperText={passwordError ?? " "}
              slotProps={{ htmlInput: { maxLength: 128 } }}
            />
          </DialogContent>
          <DialogActions>
            <Button onClick={() => setAsking(false)} disabled={busy}>
              Cancelar
            </Button>
            <Button
              type="submit"
              variant="contained"
              disabled={busy || password === ""}
            >
              {busy ? "Esperando…" : "Continuar"}
            </Button>
          </DialogActions>
        </form>
      </Dialog>

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
