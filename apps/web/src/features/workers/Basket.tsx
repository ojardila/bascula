/**
 * «Número de canasto»: the number painted on the basket. It is how the scale
 * finds a person or a team, so it is shown big wherever somebody is picked or
 * paid (docs/use-cases/basket-numbers.md).
 *
 * A team has its own number; its members keep theirs. Workers registered
 * before the number was required may have none: they get the small «Sin
 * canasto» badge and an offer to add one — nothing breaks.
 */
import { Box, Chip, Typography, type SxProps, type Theme } from "@mui/material";

/** The label used everywhere for the field. */
export const BASKET_LABEL = "Número de canasto";
export const BASKET_REQUIRED = "Escriba el número de canasto.";

/** The number trimmed, or null when there is none. */
export function basketOf(tag: string | null | undefined): string | null {
  const t = (tag ?? "").trim();
  return t === "" ? null : t;
}

/** «Canasto 46» or «Sin canasto», for plain text places. */
export function basketText(tag: string | null | undefined): string {
  const b = basketOf(tag);
  return b ? `Canasto ${b}` : "Sin canasto";
}

/**
 * The square with the number, in front of a name. Long numbers («46-63»)
 * shrink to fit; no number shows a dash in a dashed square.
 */
export function BasketTile({
  tag,
  team = false,
  size = 48,
  sx,
}: Readonly<{
  tag: string | null | undefined;
  team?: boolean;
  size?: number;
  sx?: SxProps<Theme>;
}>) {
  const b = basketOf(tag);
  const len = b?.length ?? 1;
  const font = len <= 2 ? size * 0.46 : len <= 3 ? size * 0.38 : len <= 5 ? size * 0.28 : size * 0.22;
  return (
    <Box
      role="img"
      aria-label={basketText(tag)}
      title={basketText(tag)}
      sx={{
        width: size,
        minWidth: size,
        height: size,
        borderRadius: 1.5,
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        lineHeight: 1,
        ...(b
          ? team
            ? { bgcolor: "primary.main", color: "primary.contrastText" }
            : { bgcolor: "#FFF4D6", color: "#5B4300", border: "2px solid #E8C468" }
          : { border: "2px dashed", borderColor: "divider", color: "text.disabled" }),
        ...sx,
      }}
    >
      <Typography component="span" sx={{ fontSize: Math.max(9, size * 0.18), fontWeight: 600, opacity: 0.8, lineHeight: 1 }}>
        {b ? "canasto" : ""}
      </Typography>
      <Typography component="span" sx={{ fontSize: font, fontWeight: 800, lineHeight: 1.05, letterSpacing: "-0.02em" }}>
        {b ?? "—"}
      </Typography>
    </Box>
  );
}

/** The small warning badge for a worker without a number. */
export function NoBasketChip({ onClick }: Readonly<{ onClick?: () => void }>) {
  return (
    <Chip
      size="small"
      color="warning"
      variant="outlined"
      label="Sin canasto"
      onClick={onClick}
      sx={{ fontWeight: 600 }}
    />
  );
}

/** «Canasto 46» as a big inline chip, or the «Sin canasto» badge. */
export function BasketChip({ tag, big = false }: Readonly<{ tag: string | null | undefined; big?: boolean }>) {
  const b = basketOf(tag);
  if (!b) return <NoBasketChip />;
  return (
    <Chip
      label={`Canasto ${b}`}
      sx={{
        bgcolor: "#FFF4D6",
        color: "#5B4300",
        border: "1px solid #E8C468",
        fontWeight: 800,
        ...(big ? { fontSize: "1.05rem", height: 36, px: 0.5 } : {}),
      }}
    />
  );
}
