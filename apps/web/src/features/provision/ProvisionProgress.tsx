/**
 * "Preparando su finca…" — what the owner watches after creating a farm with
 * its own web address, from the landing, from the app or from the console.
 *
 * It polls GET /v1/farms/{slug}/provision-status until every step is done and
 * then shows the address, big, with one button. Nothing here is technical on
 * purpose: three or four steps in plain words, a spinner or a check next to each.
 *
 * It never leaves the owner stuck. The farm works on the shared app from the
 * first second, so there is always a quiet "Entrar ya" link, and when the
 * dedicated address takes longer than it should the screen says so plainly
 * and makes that link the main button.
 */
import { useEffect, useRef, useState } from "react";
import { Link as RouterLink } from "react-router-dom";
import {
  Alert, Box, Button, CircularProgress, Link, Stack, Typography,
} from "@mui/material";
import CheckCircle from "@mui/icons-material/CheckCircle";
import MailOutline from "@mui/icons-material/MailOutline";
import { api } from "../../api/endpoints";
import { ApiError } from "../../api/errors";
import type { ProvisionStatus } from "../../api/types";
import { APP_HOME, farmProdUrl } from "../../lib/farmHost";

type StepKey = ProvisionStatus["steps"][number]["key"];

const STEPS: Array<{ key: StepKey; title: string; body: string }> = [
  {
    key: "database",
    title: "Base de datos",
    body: "Creamos una base de datos exclusiva para su finca. Sus datos quedan guardados de forma segura y separados de los de cualquier otra finca.",
  },
  { key: "app", title: "Aplicación", body: "Ponemos a funcionar su finca con su usuario y su clave." },
  { key: "certificate", title: "Conexión segura", body: "Preparamos el candado de su dirección para que nadie más pueda ver sus datos." },
  { key: "web", title: "Dirección web", body: "Abrimos su dirección en internet." },
];

export const POLL_MS = 5000;
/** How long the "¡Su finca está lista!" screen shows before going there. */
export const REDIRECT_MS = 3000;

/** Leaving for the farm's own address. A seam so tests can watch it. */
export const goTo = {
  assign: (href: string) => window.location.assign(href),
};

export function ProvisionProgress({
  slug, pollMs = POLL_MS, compact = false, redirectWhenReady = false,
}: {
  slug: string;
  pollMs?: number;
  /** Inside a dialog: smaller headings, no page chrome. */
  compact?: boolean;
  /**
   * Once ready, send the browser to the farm's own address. The public
   * waiting page does; the console and the super-admin dialog do not, since
   * the person there may be creating the farm for somebody else.
   */
  redirectWhenReady?: boolean;
}) {
  const [status, setStatus] = useState<ProvisionStatus | null>(null);
  const [missing, setMissing] = useState(false);
  const [asked, setAsked] = useState(false);
  const [asking, setAsking] = useState(false);
  const [askFailed, setAskFailed] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    let live = true;
    async function tick() {
      try {
        const st = await api.provisionStatus(slug);
        if (!live) return;
        setStatus(st);
        setMissing(false);
        if (st.ready) return;
      } catch (err) {
        if (!live) return;
        if (err instanceof ApiError && err.status === 404) setMissing(true);
      }
      timer.current = setTimeout(tick, pollMs);
    }
    void tick();
    return () => {
      live = false;
      if (timer.current) clearTimeout(timer.current);
    };
  }, [slug, pollMs]);

  const url = status?.url ?? farmProdUrl(slug);
  const host = url.replace(/^https?:\/\//, "");
  const appUrl = `${url}${APP_HOME}`;
  const loginUrl = `${url}/entrar`;
  const ready = status?.ready ?? false;
  // The farm's own address only once its certificate is active and it
  // answered over verified TLS; before that a browser gets a TLS error there,
  // so "no quiere esperar" goes to the shared app, where the farm already works.
  const addressOpens = Boolean(
    status &&
      status.steps.every((s) => (s.key === "certificate" || s.key === "web" ? s.done : true)) &&
      status.steps.some((s) => s.key === "web"),
  );

  useEffect(() => {
    if (!redirectWhenReady || !ready) return;
    const t = setTimeout(() => goTo.assign(appUrl), REDIRECT_MS);
    return () => clearTimeout(t);
  }, [redirectWhenReady, ready, appUrl]);
  const doneCount = status ? status.steps.filter((s) => s.done).length : 0;
  // The certificate step exists only where the platform issues one per farm.
  const steps = STEPS.filter((st) => st.key !== "certificate" || status?.steps.some((x) => x.key === "certificate"));

  if (missing) {
    return (
      <Alert severity="warning" sx={{ fontSize: "1.1rem" }}>
        Todavía no encontramos la finca <strong>{host}</strong>. Si la acaba de crear,
        espere un momento. Si no, <Link component={RouterLink} to="/entrar">entre con su correo</Link>.
      </Alert>
    );
  }

  if (status?.ready) {
    return (
      <Stack spacing={3} alignItems="center" textAlign="center" data-testid="provision-ready">
        <CheckCircle color="success" sx={{ fontSize: compact ? 56 : 80 }} />
        <Typography component="h2" sx={{ fontSize: compact ? "1.5rem" : "2rem", fontWeight: 700 }}>
          ¡Su finca está lista!
        </Typography>
        <Typography sx={{ fontSize: "1.15rem" }}>Esta es su dirección. Guárdela:</Typography>
        <Typography
          sx={{ fontSize: { xs: "1.5rem", sm: compact ? "1.7rem" : "2.2rem" }, fontWeight: 800, wordBreak: "break-all", color: "primary.main" }}
        >
          {host}
        </Typography>
        <Button
          href={appUrl}
          variant="contained"
          size="large"
          sx={{ minHeight: 64, px: 5, fontSize: "1.25rem", borderRadius: 999, width: { xs: "100%", sm: "auto" } }}
        >
          Entrar a mi finca
        </Button>
        <Typography color="text.secondary" sx={{ fontSize: "1rem" }}>
          Entre con el mismo correo y la misma clave.
        </Typography>
      </Stack>
    );
  }

  return (
    <Stack spacing={3} data-testid="provision-progress">
      <Box textAlign="center">
        <Typography component="h2" sx={{ fontSize: compact ? "1.5rem" : "2rem", fontWeight: 700 }}>
          Preparando su finca…
        </Typography>
        <Typography sx={{ fontSize: "1.15rem", mt: 1 }}>
          Estamos preparando el espacio propio de su finca en{" "}
          <Box component="strong" sx={{ wordBreak: "break-all" }}>{host}</Box>.
          Puede tardar unos minutos. No cierre esta página.
        </Typography>
      </Box>

      <Stack spacing={2} component="ol" sx={{ listStyle: "none", p: 0, m: 0 }}>
        {steps.map((step, i) => {
          const done = status?.steps.find((s) => s.key === step.key)?.done ?? false;
          const current = !done && i === doneCount;
          return (
            <Stack
              key={step.key}
              component="li"
              direction="row"
              spacing={2}
              alignItems="center"
              data-testid={`step-${step.key}`}
              data-done={done ? "true" : "false"}
              sx={{
                p: 2, borderRadius: 2, border: 1,
                borderColor: done ? "success.light" : current ? "primary.light" : "divider",
                bgcolor: done ? "rgba(46,125,50,.06)" : "transparent",
              }}
            >
              <Box sx={{ width: 40, display: "flex", justifyContent: "center" }}>
                {done ? (
                  <CheckCircle color="success" sx={{ fontSize: 36 }} />
                ) : current ? (
                  <CircularProgress size={30} />
                ) : (
                  <Typography sx={{ fontSize: "1.3rem", color: "text.disabled", fontWeight: 700 }}>{i + 1}</Typography>
                )}
              </Box>
              <Box>
                <Typography sx={{ fontSize: "1.2rem", fontWeight: 700 }}>
                  {step.title}{done ? " — lista" : ""}
                </Typography>
                <Typography sx={{ fontSize: "1rem", color: "text.secondary" }}>{step.body}</Typography>
              </Box>
            </Stack>
          );
        })}
      </Stack>

      {status?.notifyAvailable && (
        <ReadyEmail
          requested={asked || Boolean(status.notifyRequested)}
          busy={asking}
          failed={askFailed}
          onAsk={async () => {
            setAsking(true);
            setAskFailed(false);
            try {
              await api.requestReadyEmail(slug);
              setAsked(true);
            } catch {
              setAskFailed(true);
            } finally {
              setAsking(false);
            }
          }}
        />
      )}

      {status?.slow ? (
        <Alert severity="info" sx={{ fontSize: "1.05rem" }}>
          Su dirección propia está tardando más de lo normal. Su finca ya funciona:
          puede entrar ahora mismo con su correo y su clave. Cuando{" "}
          <strong>{host}</strong> esté lista, también podrá usarla.
          <Box sx={{ mt: 2 }}>
            <Button component={RouterLink} to="/entrar" variant="contained" size="large" sx={{ minHeight: 56 }}>
              Entrar ahora
            </Button>
          </Box>
        </Alert>
      ) : (
        <Typography textAlign="center" color="text.secondary" sx={{ fontSize: "1rem" }}>
          ¿No quiere esperar? Su finca ya funciona:{" "}
          {addressOpens ? (
            <Link href={loginUrl}>entre aquí con su correo</Link>
          ) : (
            <Link component={RouterLink} to="/entrar">entre aquí con su correo</Link>
          )}
          .
        </Typography>
      )}
    </Stack>
  );
}

/**
 * "Avísenme por correo cuando esté lista". Shown only where the platform can
 * send email (status.notifyAvailable); the email goes to the address the
 * owner registered with, so nothing is typed here.
 */
function ReadyEmail({
  requested, busy, failed, onAsk,
}: {
  requested: boolean;
  busy: boolean;
  failed: boolean;
  onAsk: () => void;
}) {
  if (requested) {
    return (
      <Alert severity="success" icon={<MailOutline />} sx={{ fontSize: "1.1rem" }} data-testid="ready-email-done">
        Listo. Le enviaremos un correo cuando su finca esté lista. Ya puede cerrar esta página.
      </Alert>
    );
  }
  return (
    <Stack spacing={1} alignItems="center" textAlign="center" data-testid="ready-email">
      <Button
        onClick={onAsk}
        disabled={busy}
        variant="outlined"
        size="large"
        startIcon={<MailOutline />}
        sx={{ minHeight: 56, fontSize: "1.1rem", borderRadius: 999, width: { xs: "100%", sm: "auto" } }}
      >
        Avísenme por correo cuando esté lista
      </Button>
      <Typography color="text.secondary" sx={{ fontSize: "1rem" }}>
        Le escribimos al correo con el que se registró. Así no tiene que esperar aquí.
      </Typography>
      {failed && (
        <Alert severity="error" sx={{ fontSize: "1rem" }}>
          No pudimos guardar su pedido. Intente otra vez.
        </Alert>
      )}
    </Stack>
  );
}
