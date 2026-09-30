/**
 * The «Modo cosecha» switch: one big, plain control. The whole row is the
 * target, so a thumb on a phone cannot miss it, and the state is written out
 * in words next to the switch ("Encendido" / "Apagado") — a coloured knob on
 * its own is a symbol somebody has to decode.
 */
import { Alert, Box, Stack, Switch, Typography } from "@mui/material";
import AgricultureIcon from "@mui/icons-material/Agriculture";
import type { HarvestModeState } from "./harvestMode";

export function HarvestModeSwitch({ mode, compact }: { mode: HarvestModeState; compact?: boolean }) {
  const on = mode.on === true;
  const id = "modo-cosecha-switch";
  return (
    <Box>
      <Box
        component="label"
        htmlFor={id}
        sx={{
          display: "flex",
          alignItems: "center",
          gap: 1.5,
          p: compact ? 1.5 : 2,
          borderRadius: 3,
          border: 2,
          borderColor: on ? "primary.main" : "divider",
          bgcolor: on ? "rgba(46,125,50,.06)" : "background.paper",
          cursor: mode.saving || mode.on === null ? "default" : "pointer",
        }}
      >
        <AgricultureIcon sx={{ fontSize: 36, color: on ? "primary.main" : "text.secondary", flexShrink: 0 }} />
        <Box sx={{ flex: 1, minWidth: 0 }}>
          <Typography component="span" sx={{ display: "block", fontSize: "1.25rem", fontWeight: 700, lineHeight: 1.25 }}>
            Modo cosecha
          </Typography>
          <Typography component="span" sx={{ display: "block", fontSize: "1rem", color: "text.secondary" }}>
            {on
              ? "Encendido: aquí ve la semana de cosecha, con lotes y personas."
              : "Apagado. Enciéndalo en época de cosecha para ver lotes, rendimiento y personas."}
          </Typography>
        </Box>
        <Stack alignItems="center" sx={{ flexShrink: 0 }}>
          <Switch
            id={id}
            checked={on}
            disabled={mode.saving || mode.on === null}
            onChange={(e) => void mode.set(e.target.checked)}
            slotProps={{ input: { role: "switch", "aria-label": "Modo cosecha" } }}
            sx={{
              width: 76,
              height: 46,
              p: 1,
              "& .MuiSwitch-switchBase": { p: 1.25 },
              "& .MuiSwitch-switchBase.Mui-checked": { transform: "translateX(30px)" },
              "& .MuiSwitch-thumb": { width: 26, height: 26 },
              "& .MuiSwitch-track": { borderRadius: 14 },
            }}
          />
          <Typography sx={{ fontSize: "0.95rem", fontWeight: 700, color: on ? "primary.main" : "text.secondary" }}>
            {on ? "Encendido" : "Apagado"}
          </Typography>
        </Stack>
      </Box>
      {mode.error && (
        <Alert severity="error" sx={{ mt: 1, fontSize: "1rem" }}>
          {mode.error}
        </Alert>
      )}
    </Box>
  );
}
