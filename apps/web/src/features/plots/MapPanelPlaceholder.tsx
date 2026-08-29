import { Box, Chip, Stack, Typography } from "@mui/material";
import MapIcon from "@mui/icons-material/Map";

/**
 * The map, framed and switched off.
 *
 * `plan-sprint-1.md` takes the polygon out of PARCELAS but not the parcel, and
 * asks for the space to be laid out now so Sprint 2 only fills it. Two reasons
 * this is better than leaving a gap: the form's proportions do not change when
 * the map lands (so nothing is re-designed under a feature), and the owner can
 * see in the demo that the map is a decision that was made, not one that was
 * forgotten.
 *
 * It says what will live here and when. A grey box with no words reads as a
 * bug.
 */
export function MapPanelPlaceholder({ height = 260 }: { height?: number }) {
  return (
    <Box
      aria-disabled
      sx={{
        height,
        borderRadius: 3,
        border: "1px dashed",
        borderColor: "divider",
        bgcolor: "#eef2ec",
        display: "grid",
        placeItems: "center",
        position: "relative",
        overflow: "hidden",
        // A faint parcel grid, so the panel reads as a map and not as a
        // failed image.
        backgroundImage:
          "linear-gradient(#e2e9df 1px, transparent 1px), linear-gradient(90deg, #e2e9df 1px, transparent 1px)",
        backgroundSize: "28px 28px",
      }}
    >
      <Stack alignItems="center" spacing={1} sx={{ px: 2, textAlign: "center" }}>
        <MapIcon sx={{ fontSize: 36, color: "text.disabled" }} />
        <Typography sx={{ fontWeight: 600, color: "text.secondary" }}>
          Dibujar el lote en el mapa
        </Typography>
        <Typography variant="caption" color="text.secondary" sx={{ maxWidth: 320 }}>
          Aquí podrá trazar el polígono de la parcela y el sistema calculará las
          hectáreas reales, junto a las que usted declara.
        </Typography>
        <Chip size="small" label="Disponible en el sprint 2" />
      </Stack>
    </Box>
  );
}
