/**
 * A tour step drawn inline by the page it belongs to — inside the invite
 * dialog, inside the lote form. See steps.tsx for why these steps do not use
 * Joyride's overlay.
 */
import { Box } from "@mui/material";
import { useTour } from "./TourContext";
import { TourCard } from "./TourCard";
import { stepOf, type TourName } from "./steps";

export function TourCallout({
  tour,
  n,
  onPrimary,
}: {
  tour: TourName;
  n: number;
  onPrimary?: () => boolean | Promise<boolean>;
}) {
  const t = useTour();
  const def = stepOf(tour, n);
  if (!def || !t.isAt(tour, n)) return null;
  return (
    <Box sx={{ my: 2 }} data-tour-callout={n}>
      <TourCard tour={tour} def={def} onPrimary={onPrimary} elevated={false} />
    </Box>
  );
}
