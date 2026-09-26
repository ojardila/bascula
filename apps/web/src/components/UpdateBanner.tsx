import { useCallback, useEffect, useState } from "react";
import { Box, Button, Typography } from "@mui/material";
import SystemUpdateIcon from "@mui/icons-material/SystemUpdate";
import { APP_VERSION, applyUpdate, clearUpdateAttempts, fetchServerVersion, isOutdated } from "../lib/appVersion";

/** How often an open page asks whether a new build is out. */
const CHECK_MS = 5 * 60 * 1000;

/**
 * «Hay una versión nueva, toque para actualizar».
 *
 * The service worker updates itself and reloads the page, but an iPhone
 * (above all the app installed on the home screen) can keep running the old
 * bundle for a long while: it restores the page from memory, or the swap
 * happens on the next open. This asks the server which build is current,
 * on open, on every return to the app and every few minutes, and when it
 * is not this one it says so in one tap.
 */
export function UpdateBanner({ intervalMs = CHECK_MS }: { intervalMs?: number }) {
  const [server, setServer] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const check = useCallback(() => {
    void fetchServerVersion().then((v) => {
      setServer(v);
      if (v !== null && !isOutdated(APP_VERSION, v)) clearUpdateAttempts();
    });
  }, []);

  useEffect(() => {
    if (APP_VERSION === "dev") return;
    check();
    const onBack = () => { if (document.visibilityState !== "hidden") check(); };
    document.addEventListener("visibilitychange", onBack);
    window.addEventListener("pageshow", onBack);
    window.addEventListener("online", onBack);
    const id = window.setInterval(check, intervalMs);
    return () => {
      document.removeEventListener("visibilitychange", onBack);
      window.removeEventListener("pageshow", onBack);
      window.removeEventListener("online", onBack);
      window.clearInterval(id);
    };
  }, [check, intervalMs]);

  if (!isOutdated(APP_VERSION, server)) return null;

  return (
    <Box
      role="status"
      aria-live="polite"
      sx={{
        position: "fixed", left: 12, right: 12, zIndex: (t) => t.zIndex.snackbar + 1,
        bottom: "calc(12px + env(safe-area-inset-bottom))",
        mx: "auto", maxWidth: 560, borderRadius: 3, boxShadow: 6,
        bgcolor: "primary.main", color: "primary.contrastText",
      }}
    >
      <Button
        fullWidth
        color="inherit"
        disabled={busy}
        onClick={() => { setBusy(true); void applyUpdate(); }}
        startIcon={<SystemUpdateIcon />}
        sx={{ minHeight: 60, fontSize: "1.1rem", fontWeight: 700, textTransform: "none", px: 2 }}
      >
        <Typography component="span" sx={{ fontWeight: 700, fontSize: "1.1rem" }}>
          {busy ? "Actualizando…" : "Hay una versión nueva, toque para actualizar"}
        </Typography>
      </Button>
    </Box>
  );
}
