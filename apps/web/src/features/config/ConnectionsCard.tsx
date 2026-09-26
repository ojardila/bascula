import { useCallback, useEffect, useRef, useState } from "react";
import {
  Alert, Box, Button, Card, CardContent, Chip, Collapse, Divider,
  Link, Stack, Typography,
} from "@mui/material";
import CheckCircleIcon from "@mui/icons-material/CheckCircle";
import ContentCopyIcon from "@mui/icons-material/ContentCopy";
import OpenInNewIcon from "@mui/icons-material/OpenInNew";
import ShareIcon from "@mui/icons-material/Share";
import { api, type McpConnection, type McpConnections } from "../../api/endpoints";
import { messageFor } from "../../api/errors";
import { useAuth } from "../../auth/AuthContext";
import { ConfirmDialog } from "../../components/ConfirmDialog";

/**
 * Where «Conectar con ChatGPT» sends the owner: ChatGPT's Plugins page, where
 * the «+» button creates a developer-mode app from an MCP address. This is the
 * address OpenAI's own docs link to as of September 2026 (the older
 * `#settings/Connectors` hash no longer leads anywhere useful).
 *
 * ChatGPT has NO link that adds a custom connector with its URL filled in, so
 * the farm's address waits here with a copy button for the one paste ChatGPT
 * still asks for. ChatGPT then runs the OAuth sign-in against this farm.
 */
export const CHATGPT_PLUGINS_URL = "https://chatgpt.com/plugins";

/** How often the screen asks whether ChatGPT finished while the guide is open. */
const POLL_MS = 4000;

/**
 * Waits before retrying the «already connected?» check. On an iPhone the
 * first request after the app comes back from the background, or while a new
 * version of the app is being swapped in, often fails with "Load failed"
 * even though the server is fine. A retry a moment later goes through.
 */
export const CHECK_RETRY_MS = [800, 2000, 5000];

/** This farm's MCP address: the host the owner is on, which is the farm's. */
export function farmMcpUrl(origin: string = window.location.origin): string {
  return `${origin.replace(/\/+$/, "")}/mcp`;
}

/**
 * A phone or small tablet. ChatGPT creates custom connectors only on the web
 * at chatgpt.com from a computer: its iPhone and Android apps have no
 * developer mode, and a chatgpt.com link on a phone is taken over by the app.
 * Once created there, the connector works in the phone app too.
 */
export function isPhone(): boolean {
  if (typeof navigator === "undefined") return false;
  const ua = navigator.userAgent || "";
  if (/iPhone|iPod|Android.*Mobile|Windows Phone/i.test(ua)) return true;
  // iPadOS, and an iPhone asking for the desktop site, report a Mac; a Mac
  // has no touch points.
  if (/iPad|Android/i.test(ua)) return true;
  if (/Macintosh/.test(ua) && (navigator.maxTouchPoints ?? 0) > 1) return true;
  // The installed app on any touch device, or a small touch-only screen.
  const mq = (q: string) => typeof window !== "undefined" && window.matchMedia?.(q).matches === true;
  if (mq("(pointer: coarse)") && (mq("(display-mode: standalone)") || mq("(max-width: 900px)"))) return true;
  return false;
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
        sx={{ flex: 1, fontFamily: "monospace", fontSize: "1.1rem", wordBreak: "break-all", userSelect: "all" }}
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

/** The steps, as plain text, for sending them to oneself from the phone. */
export function guideText(mcpUrl: string): string {
  return [
    "Conectar Báscula con ChatGPT (hágalo una vez desde un computador):",
    "1. Entre a chatgpt.com. En Configuración > Seguridad e inicio de sesión, active «Modo desarrollador» (Developer mode).",
    `2. Abra ${CHATGPT_PLUGINS_URL} y toque el botón +.`,
    `3. Nombre: Báscula. Dirección (URL) del servidor MCP: ${mcpUrl}`,
    "4. Autenticación: OAuth. Cree la conexión y entre con su correo y clave de Báscula.",
  ].join("\n");
}

function ShareGuide({ mcpUrl }: { mcpUrl: string }) {
  const nav = navigator as Navigator & { share?: (d: { title?: string; text: string }) => Promise<void> };
  const [done, setDone] = useState(false);
  const shareFn = nav.share;
  if (typeof shareFn !== "function") return null;
  async function share() {
    try {
      await shareFn.call(navigator, { title: "Conectar Báscula con ChatGPT", text: guideText(mcpUrl) });
      setDone(true);
    } catch {
      /* cancelled: nothing to say */
    }
  }
  return (
    <Button variant="contained" size="large" startIcon={<ShareIcon />} onClick={() => void share()}>
      {done ? "Enviado" : "Enviarme estos pasos"}
    </Button>
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
 * «Conexiones»: connect this farm to ChatGPT, see that it is connected, and
 * revoke it. The first thing on Configuración.
 *
 * The button is a plain link that the owner taps: the browser opens ChatGPT
 * itself, with no script in between. (The first version opened a blank tab
 * and pointed it at ChatGPT two seconds later; on an iPhone, and above all in
 * the installed app, that tab came up blank or not at all, and the owner saw
 * nothing happen.) The guide shows here at the same moment, so it is there
 * even if no tab opened. On a phone the button does not leave Báscula: it
 * says plainly that this one step is done from a computer.
 */
export function ConnectionsCard() {
  const { user } = useAuth();
  const tz = user?.farm?.timezone ?? "America/Bogota";
  // Not useAsync: that blanks the data on every reload, and the poll below
  // would make «Conectado ✓» blink. The last answer stays until a new one.
  const [data, setData] = useState<McpConnections | null>(null);
  // Only after every retry failed, and only as a quiet note: the check is a
  // nicety, never a gate. Connecting works the same whether or not it answered.
  const [checkFailed, setCheckFailed] = useState(false);
  const retryTimer = useRef<number | null>(null);
  const reload = useCallback(() => {
    if (retryTimer.current) window.clearTimeout(retryTimer.current);
    const attempt = (n: number) => {
      api.listMcpConnections().then(
        (d) => { setData(d); setCheckFailed(false); },
        () => {
          if (n < CHECK_RETRY_MS.length) {
            retryTimer.current = window.setTimeout(() => attempt(n + 1), CHECK_RETRY_MS[n]);
          } else {
            setCheckFailed(true);
          }
        },
      );
    };
    attempt(0);
  }, []);
  useEffect(() => {
    reload();
    // Coming back to the app (from ChatGPT, or from the background on a
    // phone) or back online: ask again.
    const onBack = () => { if (document.visibilityState !== "hidden") reload(); };
    document.addEventListener("visibilitychange", onBack);
    window.addEventListener("online", onBack);
    return () => {
      document.removeEventListener("visibilitychange", onBack);
      window.removeEventListener("online", onBack);
      if (retryTimer.current) window.clearTimeout(retryTimer.current);
    };
  }, [reload]);
  const [guide, setGuide] = useState(false);
  const [manage, setManage] = useState(false);
  const [revoking, setRevoking] = useState<McpConnection | null>(null);
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [revoked, setRevoked] = useState(false);
  const [phone] = useState(isPhone);

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

  const guideRef = useRef<HTMLDivElement | null>(null);
  function openGuide(e?: { preventDefault(): void }) {
    // Belt and braces: whatever the first render decided, a tap on a phone
    // never goes to chatgpt.com (the ChatGPT app takes the link over and
    // cannot add connectors). It stays here, on the data.
    if (isPhone()) e?.preventDefault();
    setActionError(null);
    setRevoked(false);
    setGuide(true);
    // On a phone the button does not leave Báscula: it brings the data into
    // view. (scrollIntoView is missing in some test DOMs.)
    if (phone || isPhone()) guideRef.current?.scrollIntoView?.({ behavior: "smooth", block: "start" });
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
        ) : phone ? (
          <Button
            variant="contained"
            size="large"
            onClick={() => openGuide()}
            aria-expanded={guide}
            sx={{ ...bigButton, width: { xs: "100%", sm: "auto" } }}
          >
            Conectar con ChatGPT
          </Button>
        ) : (
          // A real link: the tap itself opens ChatGPT, which no pop-up
          // blocker stops, and the guide below shows at the same time.
          <Button
            variant="contained"
            size="large"
            href={CHATGPT_PLUGINS_URL}
            target="_blank"
            rel="noopener noreferrer"
            onClick={openGuide}
            endIcon={<OpenInNewIcon />}
            sx={{ ...bigButton, width: { xs: "100%", sm: "auto" } }}
          >
            Conectar con ChatGPT
          </Button>
        )}

        <Typography variant="body2" sx={{ color: "text.secondary", mt: 1.5, fontSize: "1rem" }}>
          Crea una conexión segura solo para esta finca. Puedes revocarla cuando quieras.
          {checkFailed && !connected && (
            <>
              {" "}
              <span>Todavía no pudimos confirmar si ya está conectada; puede conectar igual.</span>{" "}
              <Link component="button" type="button" onClick={reload} sx={{ fontSize: "1rem" }}>
                Revisar otra vez
              </Link>
            </>
          )}
          {!connected && items.length > 0 && (
            <>
              {" "}
              <Link component="button" type="button" onClick={() => setManage((m) => !m)} sx={{ fontSize: "1rem" }}>
                Administrar
              </Link>
            </>
          )}
        </Typography>

        {/* The data for ChatGPT is always on screen while not connected: it
            must not depend on the tap, on a tab opening, or on the check. */}
        {!connected && (
          <Box
            ref={guideRef}
            component="section"
            aria-label="Datos para ChatGPT"
            sx={{
              mt: 3, p: { xs: 2, sm: 2.5 }, border: 1, borderRadius: 3, scrollMarginTop: 80,
              borderColor: guide ? "primary.main" : "divider",
            }}
          >
            <Typography sx={{ fontWeight: 700, color: "text.secondary", mb: 0.5 }}>
              Datos para ChatGPT
            </Typography>
            {phone ? (
              <>
                <Typography variant="h4" sx={{ fontSize: "1.3rem", fontWeight: 700, mb: 1 }}>
                  Hágalo desde un computador
                </Typography>
                <Alert severity="info" sx={{ mb: 2, fontSize: "1.05rem" }}>
                  La aplicación de ChatGPT del celular todavía no deja agregar conectores. Este paso se hace
                  una sola vez en <b>chatgpt.com</b> desde un computador. Después, Báscula funciona también
                  en ChatGPT del celular.
                </Alert>
              </>
            ) : (
              <Typography variant="h4" sx={{ fontSize: "1.3rem", fontWeight: 700, mb: 1.5 }}>
                {guide ? "Termine en ChatGPT" : "Cómo conectar"}
              </Typography>
            )}
            <Stack component="ol" spacing={1.5} sx={{ pl: 3, m: 0, fontSize: "1.1rem" }}>
              <li>
                En chatgpt.com, abra <b>Configuración → Seguridad e inicio de sesión</b> y active
                el <b>Modo desarrollador</b> (Developer mode). Se necesita un plan Plus, Pro, Business
                o Enterprise.
              </li>
              <li>
                Vaya a <b>Plugins</b> ({CHATGPT_PLUGINS_URL.replace("https://", "")}) y toque el botón <b>+</b>.
              </li>
              <li>
                Nombre: <b>Báscula</b>. En la <b>URL del servidor MCP</b> pegue esta dirección:
                <Box sx={{ mt: 1 }}>
                  <CopyField value={mcpUrl} label="Dirección de la finca para ChatGPT" />
                </Box>
              </li>
              <li>
                En autenticación elija <b>OAuth</b>, cree la conexión y entre con su correo y clave de Báscula.
              </li>
            </Stack>
            <Stack direction={{ xs: "column", sm: "row" }} spacing={2} sx={{ mt: 2 }} alignItems={{ sm: "center" }}>
              {phone ? (
                <ShareGuide mcpUrl={mcpUrl} />
              ) : (
                <Button
                  href={CHATGPT_PLUGINS_URL}
                  target="_blank"
                  rel="noopener noreferrer"
                  endIcon={<OpenInNewIcon />}
                  size="large"
                >
                  {guide ? "Abrir ChatGPT otra vez" : "Abrir ChatGPT"}
                </Button>
              )}
              <Typography sx={{ color: "text.secondary" }}>
                Cuando termine, aquí dirá «Conectado ✓».
              </Typography>
            </Stack>
          </Box>
        )}

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
