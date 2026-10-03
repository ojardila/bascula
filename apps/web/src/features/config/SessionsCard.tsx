import { useState } from "react";
import {
  Alert,
  Button,
  Card,
  CardContent,
  Chip,
  Divider,
  Stack,
  Typography,
} from "@mui/material";
import ComputerIcon from "@mui/icons-material/Computer";
import PhoneIphoneIcon from "@mui/icons-material/PhoneIphone";
import { api, type UserSession } from "../../api/endpoints";
import { messageFor } from "../../api/errors";
import { useAuth } from "../../auth/AuthContext";
import { ConfirmDialog } from "../../components/ConfirmDialog";
import { deviceLabel, isMobileAgent } from "../../lib/deviceLabel";
import { useAsync } from "../../lib/useAsync";

/** How the person signed in, as a sentence start; null when not recorded. */
function methodLabel(method: UserSession["method"]): string | null {
  if (method === "passkey") return "Entró con llave de acceso";
  if (method === "unknown") return null;
  return "Entró con la clave";
}

function dayKey(d: Date, timeZone: string): string {
  try {
    return d.toLocaleDateString("en-CA", { timeZone });
  } catch {
    return d.toLocaleDateString("en-CA");
  }
}

function longDate(iso: string, timeZone: string): string {
  try {
    return new Date(iso).toLocaleDateString("es-CO", {
      dateStyle: "long",
      timeZone,
    });
  } catch {
    return new Date(iso).toLocaleDateString("es-CO");
  }
}

/** "hoy", "ayer" or the date: the last use is only accurate to minutes. */
export function lastUsedLabel(
  iso: string,
  timeZone: string,
  now = new Date(),
): string {
  const day = dayKey(new Date(iso), timeZone);
  if (day === dayKey(now, timeZone)) return "hoy";
  const yesterday = new Date(now.getTime() - 86_400_000);
  if (day === dayKey(yesterday, timeZone)) return "ayer";
  return `el ${longDate(iso, timeZone)}`;
}

/**
 * «Sesiones abiertas»: where this account is signed in on this farm, how it
 * got in, and when it was last used. A person who does not recognise one
 * closes it; a person who lost a phone closes all the others at once.
 *
 * Assistants (ChatGPT, Claude) are not listed: they live in «Conexiones», and
 * closing the other sessions does not disconnect them.
 */
export function SessionsCard() {
  const { user } = useAuth();
  const tz = user?.farm?.timezone ?? "America/Bogota";
  const {
    data,
    error: loadError,
    reload,
  } = useAsync(() => api.listSessions(), []);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const [closing, setClosing] = useState<UserSession | null>(null);
  const [closingOthers, setClosingOthers] = useState(false);

  const others = (data ?? []).filter((s) => !s.current);

  async function closeOne() {
    if (!closing) return;
    setBusy(true);
    setError(null);
    setDone(null);
    try {
      await api.closeSession(closing.id);
      setDone("Listo. Esa sesión quedó cerrada.");
      reload();
    } catch (e) {
      setError(messageFor(e));
    } finally {
      setClosing(null);
      setBusy(false);
    }
  }

  async function closeOthers() {
    setBusy(true);
    setError(null);
    setDone(null);
    try {
      const n = await api.closeOtherSessions();
      setDone(
        n === 1
          ? "Listo. Se cerró 1 sesión."
          : `Listo. Se cerraron ${n} sesiones.`,
      );
      reload();
    } catch (e) {
      setError(messageFor(e));
    } finally {
      setClosingOthers(false);
      setBusy(false);
    }
  }

  return (
    <Card id="sesiones">
      <CardContent>
        <Typography variant="h3" gutterBottom>
          Sesiones abiertas
        </Typography>
        <Typography sx={{ color: "text.secondary", mb: 2 }}>
          Estos son los celulares y computadores donde su cuenta está abierta.
          Si no reconoce alguno, ciérrelo.
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
        {done && (
          <Alert severity="success" sx={{ mb: 2 }}>
            {done}
          </Alert>
        )}

        {data && data.length > 0 && (
          <Stack divider={<Divider flexItem />} sx={{ mb: 2 }}>
            {data.map((s) => {
              const name = deviceLabel(s.userAgent);
              const method = methodLabel(s.method);
              const Icon = isMobileAgent(s.userAgent)
                ? PhoneIphoneIcon
                : ComputerIcon;
              return (
                <Stack
                  key={s.id}
                  direction={{ xs: "column", sm: "row" }}
                  spacing={1.5}
                  sx={{ alignItems: { xs: "stretch", sm: "center" }, py: 1.5 }}
                >
                  <Stack
                    direction="row"
                    spacing={1.5}
                    sx={{ alignItems: "center", flex: 1, minWidth: 0 }}
                  >
                    <Icon color="action" fontSize="large" />
                    <Stack sx={{ minWidth: 0 }}>
                      <Stack
                        direction="row"
                        spacing={1}
                        sx={{ alignItems: "center", flexWrap: "wrap" }}
                      >
                        <Typography
                          sx={{ fontWeight: 600, fontSize: "1.1rem" }}
                        >
                          {name}
                        </Typography>
                        {s.current && (
                          <Chip
                            size="small"
                            color="success"
                            label="Este dispositivo"
                          />
                        )}
                      </Stack>
                      <Typography sx={{ color: "text.secondary" }}>
                        {method
                          ? `${method} el ${longDate(s.createdAt, tz)}`
                          : `Abierta el ${longDate(s.createdAt, tz)}`}
                      </Typography>
                      <Typography sx={{ color: "text.secondary" }}>
                        {`Último uso: ${lastUsedLabel(s.lastUsedAt, tz)}`}
                      </Typography>
                    </Stack>
                  </Stack>
                  {!s.current && (
                    <Button
                      variant="outlined"
                      color="error"
                      size="large"
                      aria-label={`Cerrar la sesión de ${name}`}
                      onClick={() => setClosing(s)}
                      disabled={busy}
                    >
                      Cerrar
                    </Button>
                  )}
                </Stack>
              );
            })}
          </Stack>
        )}

        {others.length > 1 && (
          <Button
            variant="contained"
            color="error"
            size="large"
            fullWidth
            onClick={() => setClosingOthers(true)}
            disabled={busy}
          >
            Cerrar todas las demás sesiones
          </Button>
        )}
        {data && others.length === 0 && (
          <Typography sx={{ color: "text.secondary" }}>
            Su cuenta solo está abierta aquí.
          </Typography>
        )}

        <Typography variant="body2" sx={{ color: "text.secondary", mt: 2 }}>
          ChatGPT y otros asistentes no aparecen aquí. Se manejan en
          «Conexiones».
        </Typography>
      </CardContent>

      <ConfirmDialog
        open={closing !== null}
        title="¿Cerrar esta sesión?"
        body={`En ${closing ? deviceLabel(closing.userAgent) : ""} tendrá que entrar otra vez con su clave.`}
        confirmLabel="Cerrar sesión"
        destructive
        busy={busy}
        onConfirm={() => void closeOne()}
        onCancel={() => setClosing(null)}
      />
      <ConfirmDialog
        open={closingOthers}
        title="¿Cerrar las demás sesiones?"
        body="En los otros celulares y computadores tendrá que entrar otra vez. Aquí sigue abierta."
        confirmLabel="Cerrar las demás"
        destructive
        busy={busy}
        onConfirm={() => void closeOthers()}
        onCancel={() => setClosingOthers(false)}
      />
    </Card>
  );
}
