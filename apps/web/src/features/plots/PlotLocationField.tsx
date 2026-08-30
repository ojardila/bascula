/**
 * Where the plot is, captured by standing in it.
 *
 * This replaces a 998-line drawing surface whose output nothing consumed. The
 * surface had no basemap -- deliberately, since no tile source is same-origin
 * and none of them work on a farm with no signal -- so an owner was tracing a
 * shape over a grey rectangle, from memory, with a finger. Across every real
 * farm in the database, 2 plots out of 138 have a boundary.
 *
 * A point is one tap, and it is worth having without a basemap of our own:
 * `openInMaps` hands the coordinates to whatever maps app the phone already
 * has, which does have satellite imagery and knows the way there.
 *
 * Written for somebody who barely uses a smartphone, which drives every choice
 * here: one large button, plain words, the wait is explained while it happens,
 * the accuracy is said in metres rather than shown as a number to interpret,
 * and every failure says what to do next instead of naming an error code.
 */
import { useState } from "react";
import { Alert, Box, Button, Stack, Typography } from "@mui/material";
import MyLocationIcon from "@mui/icons-material/MyLocation";
import MapIcon from "@mui/icons-material/Map";
import DeleteOutlineIcon from "@mui/icons-material/DeleteOutline";

/** A GeoJSON Point, longitude first, exactly as it goes on the wire. */
export type PlotPoint = { type: "Point"; coordinates: number[] };

export function pointOf(raw: unknown): PlotPoint | null {
  if (!raw || typeof raw !== "object") return null;
  const g = raw as { type?: unknown; coordinates?: unknown };
  if (g.type !== "Point" || !Array.isArray(g.coordinates)) return null;
  const [lon, lat] = g.coordinates;
  if (typeof lon !== "number" || typeof lat !== "number") return null;
  return { type: "Point", coordinates: [lon, lat] };
}

/**
 * A maps URL the phone will open in its own app. `geo:` is what Android hands
 * to Google Maps or Waze; iOS does not take it, so the https form is the one
 * that works everywhere and both platforms redirect it into the installed app.
 */
export function openInMaps(p: PlotPoint): string {
  const [lon, lat] = p.coordinates;
  return `https://www.google.com/maps/search/?api=1&query=${lat},${lon}`;
}

/** Coordinates as a person can read them back to somebody over the phone. */
export function formatPoint(p: PlotPoint): string {
  const [lon, lat] = p.coordinates;
  return `${lat.toFixed(5)}, ${lon.toFixed(5)}`;
}

/**
 * Accuracy in words. A number in metres is a number to interpret; "as far as
 * across the yard" is a distance somebody can picture while deciding whether
 * to walk further in and press again.
 */
function accuracyWords(metres: number): { text: string; ok: boolean } {
  if (metres <= 20) return { text: "La señal es buena.", ok: true };
  if (metres <= 60) {
    return {
      text: `La señal alcanza para ubicar el lote, con un margen de unos ${Math.round(metres)} metros.`,
      ok: true,
    };
  }
  return {
    text:
      `La señal está débil: el punto puede estar hasta ${Math.round(metres)} metros ` +
      `de donde usted está. Si puede, salga a campo abierto y vuelva a marcar.`,
    ok: false,
  };
}

type Props = {
  value: PlotPoint | null;
  onChange: (p: PlotPoint | null) => void;
};

export function PlotLocationField({ value, onChange }: Props) {
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [accuracy, setAccuracy] = useState<number | null>(null);

  function capture() {
    setProblem(null);
    if (!navigator.geolocation) {
      setProblem(
        "Este dispositivo no sabe dónde está. Puede guardar el lote sin la ubicación " +
          "y marcarla después desde el celular, parado en el lote.",
      );
      return;
    }
    setBusy(true);
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        setBusy(false);
        setAccuracy(pos.coords.accuracy);
        onChange({
          type: "Point",
          coordinates: [pos.coords.longitude, pos.coords.latitude],
        });
      },
      (err) => {
        setBusy(false);
        // Each case says what to do next. "PERMISSION_DENIED" tells somebody
        // who barely uses a phone nothing at all.
        if (err.code === err.PERMISSION_DENIED) {
          setProblem(
            "El navegador no nos deja ver la ubicación. Busque el candado junto a la " +
              "dirección de la página y permita la ubicación, y vuelva a intentar.",
          );
        } else if (err.code === err.TIMEOUT) {
          setProblem(
            "Se demoró demasiado buscando la señal. Debajo de árboles o dentro de una " +
              "construcción casi nunca llega: salga a campo abierto e intente de nuevo.",
          );
        } else {
          setProblem(
            "No se pudo tomar la ubicación en este momento. Puede guardar el lote e " +
              "intentar más tarde, parado en el lote.",
          );
        }
      },
      // A plot is a place, so it is worth waiting for the real fix rather than
      // accepting the cell-tower estimate, which can be kilometres out.
      { enableHighAccuracy: true, timeout: 30000, maximumAge: 0 },
    );
  }

  const words = accuracy === null ? null : accuracyWords(accuracy);

  return (
    <Stack spacing={2}>
      <Typography variant="body2" color="text.secondary">
        Opcional. Estando parado en el lote, toque el botón y el sistema guarda el
        punto. Después podrá abrirlo en el mapa del celular para volver.
      </Typography>

      <Button
        variant={value ? "outlined" : "contained"}
        size="large"
        startIcon={<MyLocationIcon />}
        onClick={capture}
        disabled={busy}
        sx={{ py: 1.5 }}
        fullWidth
      >
        {busy
          ? "Buscando la señal…"
          : value
            ? "Volver a marcar aquí"
            : "Estoy parado en el lote"}
      </Button>

      {busy && (
        <Typography variant="body2" color="text.secondary">
          Puede tardar hasta medio minuto. Es normal: el celular está buscando los
          satélites.
        </Typography>
      )}

      {problem && <Alert severity="warning">{problem}</Alert>}

      {/* Outside the block below on purpose. This says how good the reading
          just taken was, and it must appear whether or not the parent has
          echoed the new point back down -- a weak-signal warning that depends
          on somebody else re-rendering is a warning that can go missing. */}
      {words && (
        <Alert severity={words.ok ? "success" : "warning"}>{words.text}</Alert>
      )}

      {value && (
        <Box>
          <Typography variant="body2" sx={{ mb: 1 }}>
            Punto guardado: <strong>{formatPoint(value)}</strong>
          </Typography>
          <Stack direction="row" spacing={1}>
            <Button
              size="small"
              startIcon={<MapIcon />}
              href={openInMaps(value)}
              target="_blank"
              rel="noopener"
            >
              Ver en el mapa
            </Button>
            <Button
              size="small"
              color="inherit"
              startIcon={<DeleteOutlineIcon />}
              onClick={() => {
                onChange(null);
                setAccuracy(null);
              }}
            >
              Quitar
            </Button>
          </Stack>
        </Box>
      )}
    </Stack>
  );
}
