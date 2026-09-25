/**
 * "Dirección web de la finca": the one field that gives a farm its own address,
 * `lapalma.bascula.engp.io`.
 *
 * It fills itself from the farm's name (see `useFarmUrl`) until the owner
 * touches it, shows the whole address in big letters as they type, and asks
 * the server whether the address is free. Every message is a sentence a farm
 * owner can act on, and the rule is the server's rule, so the form never
 * promises an address the API then refuses.
 */
import { useEffect, useState } from "react";
import { Box, InputAdornment, TextField, Typography } from "@mui/material";
import CheckCircle from "@mui/icons-material/CheckCircle";
import { api } from "../api/endpoints";
import { ApiError } from "../api/errors";
import {
  cleanFarmSlugInput, farmHostForHere, farmSlugProblem, slugifyFarmName,
} from "../lib/farmHost";

export type SlugCheck = "idle" | "checking" | "free" | "taken" | "reserved" | "invalid" | "unknown";

/** Name -> address, until the owner edits the address themselves. */
export function useFarmUrl() {
  const [slug, setSlugState] = useState("");
  const [touched, setTouched] = useState(false);
  return {
    slug,
    /** Call from the farm-name field's onChange. */
    followName: (name: string) => {
      if (!touched) setSlugState(name.trim() ? slugifyFarmName(name) : "");
    },
    /** Call from the address field's onChange. */
    setSlug: (value: string) => {
      setTouched(true);
      setSlugState(cleanFarmSlugInput(value));
    },
    reset: () => {
      setTouched(false);
      setSlugState("");
    },
  };
}

/** Debounced availability check. Local problems never reach the server. */
export function useSlugCheck(slug: string): SlugCheck {
  const [state, setState] = useState<SlugCheck>("idle");
  useEffect(() => {
    if (!slug || farmSlugProblem(slug)) {
      setState("idle");
      return;
    }
    let live = true;
    setState("checking");
    const timer = setTimeout(async () => {
      try {
        const res = await api.slugAvailability(slug);
        if (!live) return;
        if (res.available) setState("free");
        else setState(res.reason === "reserved" ? "reserved" : res.reason === "invalid" ? "invalid" : "taken");
      } catch {
        // An older server without the check, or no network: say nothing and
        // let the create call be the judge.
        if (live) setState("unknown");
      }
    }, 400);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [slug]);
  return state;
}

/** Plain-Spanish sentence for a slug the server refused on create, or null. */
export function slugErrorFromApi(err: unknown): string | null {
  if (!(err instanceof ApiError)) return null;
  const msg = err.message.toLowerCase();
  if (!msg.includes("slug")) return null;
  if (err.status === 409) return "Esa dirección ya la tiene otra finca. Escriba otra.";
  if (msg.includes("reserved")) return "Esa dirección está reservada. Escriba otra.";
  return "Use solo letras minúsculas sin tildes, números y guiones. Ejemplo: lapalma";
}

export function FarmUrlField({
  slug, onChange, check, serverError, disabled,
}: {
  slug: string;
  onChange: (value: string) => void;
  check: SlugCheck;
  /** A refusal from the create call (409 taken, 400 reserved). */
  serverError?: string | null;
  disabled?: boolean;
}) {
  const [blurred, setBlurred] = useState(false);
  const local = slug ? farmSlugProblem(slug) : null;
  const problem =
    serverError ||
    (blurred || slug.length > 1 ? local : null) ||
    (check === "taken" ? "Esa dirección ya la tiene otra finca. Escriba otra." : null) ||
    (check === "reserved" ? "Esa dirección está reservada. Escriba otra." : null);
  const host = farmHostForHere(slug || "sufinca");
  const [label, ...rest] = host.split(".");
  const suffix = "." + rest.join(".");

  return (
    <Box>
      <TextField
        label="Dirección web de la finca"
        value={slug}
        onChange={(e) => onChange(e.target.value)}
        onBlur={() => setBlurred(true)}
        error={!!problem}
        helperText={problem ?? "Así la van a encontrar en internet. Solo letras, números y guiones."}
        fullWidth
        required
        disabled={disabled}
        autoComplete="off"
        slotProps={{
          htmlInput: {
            autoCapitalize: "none",
            autoCorrect: "off",
            spellCheck: false,
            inputMode: "url",
            "aria-describedby": "farm-url-preview",
          },
          input: {
            endAdornment: (
              <InputAdornment position="end" sx={{ display: { xs: "none", sm: "flex" } }}>
                {suffix}
              </InputAdornment>
            ),
          },
        }}
        sx={{ "& .MuiInputBase-input": { fontSize: "1.2rem" } }}
      />
      <Box
        id="farm-url-preview"
        data-testid="farm-url-preview"
        sx={{
          mt: 1.5, p: 2, borderRadius: 2, bgcolor: "action.hover",
          display: "flex", alignItems: "center", gap: 1, flexWrap: "wrap",
        }}
      >
        <Typography component="span" sx={{ fontSize: "1rem", color: "text.secondary" }}>
          Su finca quedará en:
        </Typography>
        <Typography
          component="span"
          sx={{ fontSize: { xs: "1.15rem", sm: "1.35rem" }, fontWeight: 700, wordBreak: "break-all" }}
        >
          <Box component="span" sx={{ color: slug ? "primary.main" : "text.disabled" }}>{label}</Box>
          {suffix}
        </Typography>
        {check === "free" && !problem && (
          <Typography
            component="span"
            sx={{ display: "inline-flex", alignItems: "center", gap: 0.5, color: "success.main", fontWeight: 600 }}
          >
            <CheckCircle fontSize="small" /> Disponible
          </Typography>
        )}
        {check === "checking" && (
          <Typography component="span" sx={{ color: "text.secondary" }}>Revisando…</Typography>
        )}
      </Box>
    </Box>
  );
}
