import { useCallback, useEffect, useRef, useState } from "react";
import {
  Alert, Box, Button, Card, CardContent, Chip, CircularProgress, Collapse, Divider,
  Link, Stack, Typography,
} from "@mui/material";
import CheckCircleIcon from "@mui/icons-material/CheckCircle";
import ContentCopyIcon from "@mui/icons-material/ContentCopy";
import OpenInNewIcon from "@mui/icons-material/OpenInNew";
import { api, type McpConnection, type McpConnections } from "../../api/endpoints";
import { messageFor } from "../../api/errors";
import { useAuth } from "../../auth/AuthContext";
import { ConfirmDialog } from "../../components/ConfirmDialog";

/**
 * Where «Conectar con ChatGPT» sends the owner.
 *
 * ChatGPT has NO link that adds a custom connector with its URL filled in
 * (Claude has one; ChatGPT does not, as of September 2026). What it does have
 * is a stable address for its connector settings, the one OpenAI's own docs
 * link to. So the button opens that, and the farm's address waits here with a
 * copy button for the one paste ChatGPT still asks for. ChatGPT then runs the
 * OAuth sign-in against this farm by itself.
 */
export const CHATGPT_CONNECTORS_URL = "https://chatgpt.com/#settings/Connectors";

/** How long «Conectando…» shows before ChatGPT opens. */
export const CONNECTING_MS = 2000;

/** How often the screen asks whether ChatGPT finished while the guide is open. */
const POLL_MS = 4000;

/** This farm's MCP address: the host the owner is on, which is the farm's. */
export function farmMcpUrl(origin: string = window.location.origin): string {
  return `${origin.replace(/\/+$/, "")}/mcp`;
}

function CopyField({ value, label }: { value: string; label: string }) {
  const [copied, setCopied] = useState(false);
  async function copy() {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2500);
    } catch {
      setCopied(false);
    }
  }
  return (
    <Stack
      direction={{ xs: "column", sm: "row" }}
      spacing={1}
      alignItems={{ xs: "stretch", sm: "center" }}
      sx={{ bgcolor: "action.hover", borderRadius: 2, p: 1.5 }}
    >
      <Typography
        component="code"
        aria-label={label}
        sx={{ flex: 1, fontFamily: "monospace", fontSize: "1.1rem", wordBreak: "break-all" }}
      >
        {value}
      </Typography>
      <Button
        variant="outlined"
        size="large"
        startIcon={copied ? <CheckCircleIcon /> : <ContentCopyIcon />}
        onClick={() => void copy()}
        sx={{ whiteSpace: "nowrap" }}
      >
        {copied ? "Copiada" : "Copiar"}
      </Button>
    </Stack>
  );
}

function formatWhen(iso: string, timeZone: string): string {
  try {
    return new Date(iso).toLocaleString("es-CO", { dateStyle: "long", timeStyle: "short", timeZone });
  } catch {
    return new Date(iso).toLocaleString("es-CO");
  }
}

/**
 * «Conexiones»: connect this farm to ChatGPT in one tap, see that it is
 * connected, and revoke it. The first thing on Configuración.
 */
export function ConnectionsCard() {
  const { user } = useAuth();
  const tz = user?.farm?.timezone ?? "America/Bogota";
  // Not useAsync: that blanks the data on every reload, and the poll below
  // would make «Conectado ✓» blink. The last answer stays until a new one.
  const [data, setData] = useState<McpConnections | null>(null);
  const [error, setError] = useState<string | null>(null);
  const reload = useCallback(() => {
    api.listMcpConnections().then(
      (d) => { setData(d); setError(null); },
      (e) => setError(messageFor(e)),
    );
  }, []);
  useEffect(reload, [reload]);
  const [connecting, setConnecting] = useState(false);
  const [guide, setGuide] = useState(false);
  const [manage, setManage] = useState(false);
  const [revoking, setRevoking] = useState<McpConnection | null>(null);
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [revoked, setRevoked] = useState(false);
  const timer = useRef<number | null>(null);

  const mcpUrl = farmMcpUrl();
  const items = data?.items ?? [];
  const connected = items.some((c) => c.status === "active");

  // While the owner is finishing in ChatGPT, keep asking; the moment the
  // grant lands this card turns into «Conectado ✓» without a reload.
  useEffect(() => {
    if (!guide || connected) return;
    const id = window.setInterval(reload, POLL_MS);
    const onFocus = () => reload();
    window.addEventListener("focus", onFocus);
    return () => {
      window.clearInterval(id);
      window.removeEventListener("focus", onFocus);
    };
  }, [guide, connected, reload]);

  useEffect(() => {
    if (connected) setGuide(false);
  }, [connected]);

  useEffect(() => () => {
    if (timer.current) window.clearTimeout(timer.current);
  }, []);

  function connect() {
    setActionError(null);
    setRevoked(false);
    setConnecting(true);
    // The tab is opened NOW, inside the tap, and pointed at ChatGPT after the
    // pause: a window.open two seconds later is not a user gesture any more,
    // and Safari on a phone blocks it.
    let win: Window | null = null;
    try {
      win = window.open("", "_blank");
      if (win) {
        win.document.title = "Conectando…";
        win.document.body.innerHTML =
          '<p style="font:600 22px system-ui,sans-serif;text-align:center;margin-top:30vh">Conectando…</p>';
      }
    } catch {
      win = null;
    }
    timer.current = window.setTimeout(() => {
      setConnecting(false);
      setGuide(true);
      if (win && !win.closed) {
        win.opener = null;
        win.location.href = CHATGPT_CONNECTORS_URL;
      } else {
        // Pop-ups blocked: the guide below has the same link.
        window.open(CHATGPT_CONNECTORS_URL, "_blank", "noopener");
      }
    }, CONNECTING_MS);
  }

  async function revoke() {
    if (!revoking) return;
    setBusy(true);
    setActionError(null);
    try {
      await api.revokeMcpConnection(revoking.id);
      setRevoking(null);
      setRevoked(true);
      reload();
    } catch (e) {
      setActionError(messageFor(e));
    } finally {
      setBusy(false);
    }
  }

  const bigButton = { minHeight: 64, fontSize: "1.3rem", px: 4, borderRadius: 3 } as const;

  return (
    <Card>
      <CardContent sx={{ p: { xs: 2.5, sm: 3 } }}>
        <Typography variant="h3" gutterBottom>
          Conexiones
        </Typography>

        {error && !data && (
          <Alert severity="warning" sx={{ mb: 2 }}>
            No se pudo consultar si esta finca ya está conectada. {error}
          </Alert>
        )}
        {actionError && (
          <Alert severity="error" sx={{ mb: 2 }} onClose={() => setActionError(null)}>
            {actionError}
          </Alert>
        )}
        {revoked && !connected && (
          <Alert severity="success" sx={{ mb: 2 }} onClose={() => setRevoked(false)}>
            Conexión revocada. ChatGPT ya no puede entrar a esta finca.
          </Alert>
        )}

        {connected ? (
          <Stack direction={{ xs: "column", sm: "row" }} spacing={2} alignItems={{ xs: "stretch", sm: "center" }}>
            <Box
              role="status"
              sx={{
                ...bigButton, display: "flex", alignItems: "center", justifyContent: "center", gap: 1,
                bgcolor: "success.main", color: "success.contrastText", fontWeight: 700,
              }}
            >
              <CheckCircleIcon /> Conectado ✓
            </Box>
            <Link
              component="button"
              type="button"
              onClick={() => setManage((m) => !m)}
              sx={{ fontSize: "1.2rem", fontWeight: 600, alignSelf: { xs: "center", sm: "center" } }}
              aria-expanded={manage}
            >
              Administrar
            </Link>
          </Stack>
        ) : (
          <Button
            variant="contained"
            size="large"
            onClick={connect}
            disabled={connecting}
            sx={{ ...bigButton, width: { xs: "100%", sm: "auto" } }}
            startIcon={connecting ? <CircularProgress size={24} color="inherit" /> : undefined}
          >
            {connecting ? "Conectando…" : "Conectar con ChatGPT"}
          </Button>
        )}

        <Typography variant="body2" sx={{ color: "text.secondary", mt: 1.5, fontSize: "1rem" }}>
          Crea una conexión segura solo para esta finca. Puedes revocarla cuando quieras.
          {!connected && items.length > 0 && (
            <>
              {" "}
              <Link component="button" type="button" onClick={() => setManage((m) => !m)} sx={{ fontSize: "1rem" }}>
                Administrar
              </Link>
            </>
          )}
        </Typography>

        {/* After the tap: ChatGPT is open in another tab. What is left there. */}
        <Collapse in={guide && !connected} unmountOnExit>
          <Box sx={{ mt: 3, p: { xs: 2, sm: 2.5 }, border: 1, borderColor: "divider", borderRadius: 3 }}>
            <Typography variant="h4" sx={{ fontSize: "1.3rem", fontWeight: 700, mb: 1.5 }}>
              Termine en ChatGPT
            </Typography>
            <Stack component="ol" spacing={1.5} sx={{ pl: 3, m: 0, fontSize: "1.1rem" }}>
              <li>
                En ChatGPT, en <b>Aplicaciones y conectores</b>, toque <b>Crear</b>. Si no aparece, active
                el <b>Modo desarrollador</b> en «Configuración avanzada».
              </li>
              <li>
                En <b>URL del servidor MCP</b> pegue esta dirección:
                <Box sx={{ mt: 1 }}>
                  <CopyField value={mcpUrl} label="Dirección de la finca para ChatGPT" />
                </Box>
              </li>
              <li>
                Elija <b>OAuth</b>, guarde, y entre con su correo y clave de Báscula.
              </li>
            </Stack>
            <Stack direction={{ xs: "column", sm: "row" }} spacing={2} sx={{ mt: 2 }} alignItems={{ sm: "center" }}>
              <Button
                href={CHATGPT_CONNECTORS_URL}
                target="_blank"
                rel="noopener noreferrer"
                endIcon={<OpenInNewIcon />}
                size="large"
              >
                Abrir ChatGPT otra vez
              </Button>
              <Typography sx={{ color: "text.secondary" }}>
                Cuando termine, aquí dirá «Conectado ✓».
              </Typography>
            </Stack>
          </Box>
        </Collapse>

        {/* Advanced: only for whoever goes looking. */}
        <Collapse in={manage && items.length > 0} unmountOnExit>
          <Box sx={{ mt: 3 }}>
            <Divider sx={{ mb: 2 }} />
            <Typography sx={{ fontWeight: 700, fontSize: "1.1rem", mb: 1 }}>
              Dirección del conector (MCP)
            </Typography>
            <CopyField value={mcpUrl} label="Dirección MCP de la finca" />
            <Stack spacing={2} sx={{ mt: 2 }}>
              {items.map((c) => (
                <Box key={c.id} sx={{ border: 1, borderColor: "divider", borderRadius: 3, p: 2 }}>
                  <Stack direction="row" justifyContent="space-between" alignItems="center" sx={{ mb: 1 }}>
                    <Typography sx={{ fontWeight: 700, fontSize: "1.15rem" }}>{c.clientName}</Typography>
                    <Chip
                      label={c.status === "active" ? "Activa" : "Vencida"}
                      color={c.status === "active" ? "success" : "default"}
                      variant="outlined"
                    />
                  </Stack>
                  <Typography sx={{ color: "text.secondary", fontSize: "1.05rem" }}>
                    Creada el {formatWhen(c.createdAt, tz)}
                  </Typography>
                  <Button
                      variant="contained"
                      color="error"
                      size="large"
                      onClick={() => setRevoking(c)}
                      sx={{ mt: 2, width: { xs: "100%", sm: "auto" } }}
                    >
                      Revocar conexión
                    </Button>
                </Box>
              ))}
            </Stack>
          </Box>
        </Collapse>
      </CardContent>

      <ConfirmDialog
        open={revoking !== null}
        title="¿Revocar la conexión?"
        body={`${revoking?.clientName ?? "El asistente"} dejará de tener acceso a esta finca. Para volver a usarlo tendrá que conectarlo otra vez.`}
        confirmLabel="Revocar conexión"
        destructive
        busy={busy}
        onConfirm={() => void revoke()}
        onCancel={() => setRevoking(null)}
      />
    </Card>
  );
}

