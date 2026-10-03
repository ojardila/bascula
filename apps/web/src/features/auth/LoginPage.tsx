// SPDX-License-Identifier: MIT
import { useEffect, useRef, useState, type SubmitEvent } from "react";
import {
  Link as RouterLink,
  Navigate,
  useLocation,
  useNavigate,
} from "react-router-dom";
import {
  Alert,
  Box,
  Button,
  Divider,
  IconButton,
  InputAdornment,
  Link,
  Stack,
  TextField,
  Typography,
} from "@mui/material";
import Visibility from "@mui/icons-material/Visibility";
import VisibilityOff from "@mui/icons-material/VisibilityOff";
import Fingerprint from "@mui/icons-material/Fingerprint";
import { AuthLayout } from "./AuthLayout";
import { useAuth } from "../../auth/AuthContext";
import { ApiError, messageFor } from "../../api/errors";
import type { PasskeyAnswer } from "../../api/endpoints";
import {
  conditionalMediationAvailable,
  passkeyCancelled,
  passkeysSupported,
} from "../../lib/passkeys";
import { startPasskeyAutofill } from "../../lib/passkeyAutofill";
import { api } from "../../api/endpoints";
import {
  farmGreeting,
  farmSlugFromHost,
  offersSignup,
} from "../../lib/farmHost";
import { useFarmDisplayName } from "../../lib/useFarmDisplayName";
import {
  markPasskeyOfferSeen,
  shouldOfferPasskey,
} from "../../lib/passkeyOffer";
import { PasskeyOffer } from "./PasskeyOffer";
import { safeReturnPath } from "../../lib/returnTo";
import type { Membership, Role } from "../../api/types";

function loginSubtitle(
  pinned: boolean,
  farmName: string | null | undefined,
): string {
  if (!pinned) return "Escriba el correo y la contraseña de su finca.";
  return `Escriba el correo y la contraseña de ${farmName ? farmGreeting(farmName) : "esta finca"}.`;
}

/** What to say when a passkey sign-in fails; a closed prompt says nothing. */
function passkeyMessage(err: unknown): string | null {
  if (passkeyCancelled(err)) return null;
  if (err instanceof ApiError && err.code === "INVALID_CREDENTIALS") {
    return "No reconocimos esa llave de acceso. Entre con su correo y contraseña.";
  }
  if (
    err instanceof ApiError &&
    err.status === 403 &&
    err.code === "FORBIDDEN"
  ) {
    return "Esa llave de acceso no abre esta finca. Entre con su correo y contraseña.";
  }
  return messageFor(err);
}

const ROLE_LABEL: Record<Role, string> = {
  owner: "Dueño",
  administrator: "Administrador",
  weigher: "Pesador",
};

export function LoginPage() {
  const { status, login, loginWithPasskey, landing } = useAuth();
  const navigate = useNavigate();
  const location = useLocation() as { state?: { from?: unknown } };
  /**
   * Where to go once signed in: the page the person was headed to (only if it
   * is a page of this app), else the role's home. Every exit below uses this
   * one value — including the `<Navigate>` that renders as soon as the
   * session opens. That one used to say `landing`, and since React Router
   * runs `navigate(from)` in a transition, it won the race and everybody
   * landed on /cosecha.
   */
  const target = safeReturnPath(location.state?.from) ?? landing;
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  /**
   * Set when the address belongs to more than one farm. The server answers
   * that case with a 400 carrying the list, because there is no access token
   * valid for two farms — the farm is a claim inside it. So choosing one is a
   * second login that names the farm, not a switch inside this session.
   */
  const [choices, setChoices] = useState<Membership[] | null>(null);
  /**
   * Set when the farm choice came from a passkey sign-in: the signed answer,
   * which the second half sends again with the farm instead of asking the
   * phone a second time.
   */
  const [pendingPasskey, setPendingPasskey] = useState<PasskeyAnswer | null>(
    null,
  );
  const canUsePasskey = passkeysSupported();
  /**
   * True while «¿Quiere entrar más rápido la próxima vez?» is on screen,
   * after a password sign-in and before the app. The session is already
   * open; this only holds the redirect back.
   */
  const [offering, setOffering] = useState(false);
  /**
   * True from a password attempt until it is decided where to go: the
   * session opens before the offer is decided, and the redirect below must
   * wait for that answer.
   */
  const [holding, setHolding] = useState(false);
  /**
   * A pinned host is the farm. Login still sends email and password only —
   * the browser already puts the host on `/v1/auth/login`. If the API has not
   * started pinning yet and still answers 400, the chooser below is the same
   * as today. A 403 is the wrong farm and stays on this screen.
   */
  /**
   * Passkey autofill: the phone suggests the passkey in the email field.
   * `stopAutofill` ends it, which the «Entrar con llave de acceso» button
   * needs first: a browser runs one passkey request at a time.
   */
  const attemptPasskeyRef = useRef(attemptPasskey);
  attemptPasskeyRef.current = attemptPasskey;
  const stopAutofill = useRef<(() => void) | null>(null);
  useEffect(() => {
    if (!canUsePasskey) return;
    let live = true;
    void conditionalMediationAvailable().then((ok) => {
      if (!ok || !live) return;
      stopAutofill.current = startPasskeyAutofill({
        request: api.passkeyAutofill,
        onAnswer: (answer) => attemptPasskeyRef.current(answer),
      });
    });
    return () => {
      live = false;
      stopAutofill.current?.();
      stopAutofill.current = null;
    };
  }, [canUsePasskey]);
  const pinnedSlug = farmSlugFromHost(window.location.hostname);
  const { name: farmName } = useFarmDisplayName(pinnedSlug);

  function goIn() {
    // The password is not needed past this point; do not keep it around.
    setPassword("");
    setOffering(false);
    setHolding(false);
    navigate(target, { replace: true });
  }

  if (offering) return <PasskeyOffer password={password} onDone={goIn} />;
  if (status === "authenticated" && !holding)
    return <Navigate to={target} replace />;

  async function attempt(farmId?: string) {
    setError(null);
    setBusy(true);
    setHolding(true);
    try {
      const res = await login(email, password, farmId);
      if ("choose" in res) {
        setHolding(false);
        setChoices(res.memberships);
        return;
      }
      if (await shouldOfferPasskey(email)) {
        markPasskeyOfferSeen(email);
        setOffering(true);
        return;
      }
      goIn();
    } catch (err) {
      setHolding(false);
      setError(messageFor(err));
    } finally {
      setBusy(false);
    }
  }

  async function attemptPasskey(pending?: PasskeyAnswer, farmId?: string) {
    if (!pending) {
      stopAutofill.current?.();
      stopAutofill.current = null;
    }
    setError(null);
    setBusy(true);
    try {
      const res = await loginWithPasskey(pending, farmId);
      if ("choose" in res) {
        setPendingPasskey(res.passkey);
        setChoices(res.memberships);
        return;
      }
      navigate(target, { replace: true });
    } catch (err) {
      setError(passkeyMessage(err));
    } finally {
      setBusy(false);
    }
  }

  async function onSubmit(e: SubmitEvent) {
    e.preventDefault();
    await attempt();
  }

  if (choices) {
    return (
      <AuthLayout
        title="¿A cuál finca entra?"
        subtitle="Su correo trabaja en varias."
      >
        <Stack spacing={1.5}>
          {error && <Alert severity="error">{error}</Alert>}
          {choices.map((m) => (
            <Button
              key={m.farmId}
              variant="outlined"
              size="large"
              disabled={busy}
              onClick={() =>
                pendingPasskey
                  ? attemptPasskey(pendingPasskey, m.farmId)
                  : attempt(m.farmId)
              }
              sx={{ justifyContent: "space-between" }}
            >
              {m.farmName}
              <Typography
                variant="caption"
                sx={{
                  color: "text.secondary",
                }}
              >
                {ROLE_LABEL[m.role]}
              </Typography>
            </Button>
          ))}
          <Button
            color="inherit"
            onClick={() => {
              setChoices(null);
              setPendingPasskey(null);
            }}
            disabled={busy}
          >
            Volver
          </Button>
        </Stack>
      </AuthLayout>
    );
  }

  return (
    <AuthLayout
      title="Entrar"
      subtitle={loginSubtitle(Boolean(pinnedSlug), farmName)}
    >
      <Box component="form" onSubmit={onSubmit} noValidate>
        <Stack spacing={2}>
          {error && <Alert severity="error">{error}</Alert>}
          <TextField
            label="Correo"
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            autoComplete="username webauthn"
            autoFocus
            fullWidth
            size="medium"
            required
          />
          <TextField
            label="Contraseña"
            type={showPassword ? "text" : "password"}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete="current-password"
            fullWidth
            size="medium"
            required
            slotProps={{
              input: {
                endAdornment: (
                  <InputAdornment position="end">
                    <IconButton
                      aria-label={
                        showPassword ? "Ocultar contraseña" : "Ver contraseña"
                      }
                      onClick={() => setShowPassword((v) => !v)}
                      edge="end"
                    >
                      {showPassword ? <VisibilityOff /> : <Visibility />}
                    </IconButton>
                  </InputAdornment>
                ),
              },
            }}
          />
          <Button
            type="submit"
            variant="contained"
            size="large"
            disabled={busy}
            fullWidth
          >
            {busy ? "Entrando…" : "Entrar"}
          </Button>
          {/* Optional: only for people who added a passkey in Configuración.
              Browsers without WebAuthn never see the button. */}
          {canUsePasskey && (
            <Button
              variant="outlined"
              size="large"
              fullWidth
              disabled={busy}
              startIcon={<Fingerprint />}
              onClick={() => attemptPasskey()}
            >
              Entrar con llave de acceso
            </Button>
          )}
          {/* Main domain only: a farm's login never offers another farm. */}
          {offersSignup() && (
            <>
              <Divider>o</Divider>
              <Button
                component={RouterLink}
                to="/empezar"
                variant="outlined"
                fullWidth
                size="large"
              >
                Registrar mi finca
              </Button>
            </>
          )}
        </Stack>
      </Box>

      {import.meta.env.VITE_USE_MOCKS === "true" && (
        <Box sx={{ mt: 3, p: 1.5, bgcolor: "#f2f5f0", borderRadius: 2 }}>
          <Typography
            variant="caption"
            component="div"
            sx={{
              color: "text.secondary",
            }}
          >
            <strong>Datos de prueba</strong> (finca simulada, sin API):
          </Typography>
          {[
            ["oscar@laesperanza.co", "dueño"],
            ["admin@laesperanza.co", "administrador"],
            ["pesador@laesperanza.co", "pesador"],
          ].map(([mail, role]) => (
            <Typography
              key={mail}
              variant="caption"
              component="div"
              sx={{
                color: "text.secondary",
              }}
            >
              <Link
                component="button"
                type="button"
                onClick={() => {
                  setEmail(mail);
                  setPassword("esperanza");
                }}
              >
                {mail}
              </Link>{" "}
              · {role} · clave <code>esperanza</code>
            </Typography>
          ))}
          <Typography
            variant="caption"
            component="div"
            sx={{
              color: "text.secondary",
            }}
          >
            <Link
              component="button"
              type="button"
              onClick={() => {
                setEmail("super@bascula.co");
                setPassword("bascula");
              }}
            >
              super@bascula.co
            </Link>{" "}
            · super-admin · clave <code>bascula</code>
          </Typography>
        </Box>
      )}
    </AuthLayout>
  );
}
