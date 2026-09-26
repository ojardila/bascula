/**
 * «Véalo funcionando»: the demo videos on the landing (main domain only; the
 * landing itself is never rendered on a farm's own address, see HomeRoute).
 *
 * Browsers refuse autoplay with sound, and the videos have music, so nothing
 * plays by itself: the poster carries one large play button and a tap starts
 * the video with sound, from inside the user's gesture. Nothing is downloaded
 * until then (`preload="none"`), because a farm's mobile data plan pays for
 * every megabyte and the landing must stay fast on a rural connection.
 *
 * Phones in portrait get the vertical cut of video 1; everything else the
 * 16:9 one. Video 2 (the longer tour) stays behind a button. Captions are
 * burned into the picture, so they read with the sound off; the Spanish .vtt
 * is there for screen readers and search, off by default so the text is not
 * shown twice. Files are imported through Vite, so they are served from
 * /assets with fingerprinted names and cached for a year (nginx.conf), and
 * they are kept out of the service worker's precache (vite.config.ts).
 * How they were made: docs/demo-videos.md.
 */
import { forwardRef, useImperativeHandle, useRef, useState } from "react";
import { Box, Button, ButtonBase, Collapse, Container, Stack, Typography, useMediaQuery } from "@mui/material";
import PlayArrowRoundedIcon from "@mui/icons-material/PlayArrowRounded";
import OndemandVideoIcon from "@mui/icons-material/OndemandVideo";
import { GREEN, GREEN_DARK } from "../../theme";

import v1Mp4 from "./media/demo-1.mp4?url";
import v1Webm from "./media/demo-1.webm?url";
import v1Poster from "./media/demo-1-poster.webp?url";
import v1Vtt from "./media/demo-1.es.vtt?no-inline";
import v1vMp4 from "./media/demo-1-vertical.mp4?url";
import v1vWebm from "./media/demo-1-vertical.webm?url";
import v1vPoster from "./media/demo-1-vertical-poster.webp?url";
import v1vVtt from "./media/demo-1-vertical.es.vtt?no-inline";
import v2Mp4 from "./media/demo-2.mp4?url";
import v2Webm from "./media/demo-2.webm?url";
import v2Poster from "./media/demo-2-poster.webp?url";
import v2Vtt from "./media/demo-2.es.vtt?no-inline";

const DISPLAY = '"Fraunces", Georgia, serif';
const MUTED = "#43483f";

export interface DemoClip {
  mp4: string;
  webm: string;
  poster: string;
  vtt: string;
  width: number;
  height: number;
  /** Accessible name of the video and of its play button. */
  title: string;
  /** Length shown on the play button, e.g. "45 s". */
  length: string;
}

export const CLIPS = {
  main: { mp4: v1Mp4, webm: v1Webm, poster: v1Poster, vtt: v1Vtt, width: 1920, height: 1080, length: "45 s",
    title: "Video: una semana en Báscula, del tablero de cosecha al pago de un recolector con su recibo" },
  mainVertical: { mp4: v1vMp4, webm: v1vWebm, poster: v1vPoster, vtt: v1vVtt, width: 1080, height: 1920, length: "40 s",
    title: "Video: una semana en Báscula, del tablero de cosecha al pago de un recolector con su recibo" },
  tour: { mp4: v2Mp4, webm: v2Webm, poster: v2Poster, vtt: v2Vtt, width: 1920, height: 1080, length: "1 min",
    title: "Video: recorrido completo, con la pesada en el celular, la nómina, la conexión con ChatGPT, fincas separadas y la consola de soporte" },
} satisfies Record<string, DemoClip>;

export interface PlayerHandle { start: () => void }

/** Poster + one big play button; the tap starts playback with sound. */
export const DemoPlayer = forwardRef<PlayerHandle, { clip: DemoClip; maxWidth?: number | string; hidePoster?: boolean }>(function DemoPlayer(
  { clip, maxWidth, hidePoster }, ref,
) {
  const video = useRef<HTMLVideoElement>(null);
  const [started, setStarted] = useState(false);
  const start = () => {
    const v = video.current;
    if (!v) return;
    setStarted(true);
    v.muted = false;
    v.volume = 1;
    // Called from the click itself: that is what lets the browser play sound.
    const p = v.play();
    if (p && typeof p.catch === "function") p.catch(() => { /* the native controls stay available */ });
  };
  useImperativeHandle(ref, () => ({ start }));
  return (
    <Box sx={{ position: "relative", width: "100%", maxWidth, mx: "auto", aspectRatio: `${clip.width} / ${clip.height}`,
      borderRadius: 3, overflow: "hidden", bgcolor: "#1b2a1c", boxShadow: "0 18px 50px rgba(16,40,18,.22)" }}>
      <video
        ref={video}
        poster={hidePoster ? undefined : clip.poster}
        preload="none"
        playsInline
        controls={started}
        width={clip.width}
        height={clip.height}
        aria-label={clip.title}
        onEnded={() => setStarted(false)}
        style={{ display: "block", width: "100%", height: "100%", objectFit: "cover" }}
      >
        <source src={clip.webm} type="video/webm" />
        <source src={clip.mp4} type="video/mp4" />
        <track kind="captions" srcLang="es" label="Español" src={clip.vtt} />
      </video>
      {!started && (
        <ButtonBase
          onClick={start}
          aria-label={`Reproducir con sonido: ${clip.title} (${clip.length})`}
          sx={{ position: "absolute", inset: 0, display: "flex", flexDirection: "column", gap: 1.5, color: "#fff",
            background: "radial-gradient(circle at center, rgba(10,30,12,.28), rgba(10,30,12,.05) 60%)",
            "&:hover .play, &.Mui-focusVisible .play": { transform: "scale(1.06)", bgcolor: GREEN_DARK },
            "&.Mui-focusVisible": { outline: "4px solid #ffc400", outlineOffset: -4 } }}
        >
          <Box className="play" sx={{ width: { xs: 88, md: 112 }, height: { xs: 88, md: 112 }, borderRadius: "50%", bgcolor: GREEN,
            display: "grid", placeItems: "center", boxShadow: "0 8px 24px rgba(0,0,0,.35)", transition: "transform .15s, background-color .15s" }}>
            <PlayArrowRoundedIcon sx={{ fontSize: { xs: 60, md: 76 } }} />
          </Box>
          <Box component="span" sx={{ bgcolor: "rgba(20,32,21,.82)", px: 2, py: 0.75, borderRadius: 99, fontWeight: 700, fontSize: { xs: "1.05rem", md: "1.15rem" } }}>
            Ver con sonido · {clip.length}
          </Box>
        </ButtonBase>
      )}
    </Box>
  );
});

export function DemoVideos() {
  // Portrait phones get the vertical cut; checked once per render, and the
  // player is keyed on it so a rotation swaps the whole element.
  const phone = useMediaQuery("(max-width:599.95px) and (orientation: portrait)", { noSsr: true });
  const main = phone ? CLIPS.mainVertical : CLIPS.main;
  const tour = useRef<PlayerHandle>(null);
  const [tourOpen, setTourOpen] = useState(false);
  return (
    <Box component="section" id="video" aria-labelledby="video-title" sx={{ bgcolor: "#fff", py: { xs: 7, md: 10 } }}>
      <Container maxWidth="lg">
        <Typography id="video-title" component="h2" sx={{ fontFamily: DISPLAY, fontWeight: 700, fontSize: { xs: "2rem", md: "2.6rem" },
          lineHeight: 1.15, letterSpacing: "-0.02em", textAlign: "center", mb: 2 }}>
          Véalo funcionando
        </Typography>
        <Typography sx={{ fontSize: { xs: "1.15rem", md: "1.3rem" }, color: MUTED, textAlign: "center", maxWidth: 720, mx: "auto", mb: { xs: 4, md: 5 } }}>
          Una finca de demostración: la semana de cosecha, el pago a un recolector con su anticipo descontado y el recibo.
          Tiene música; los textos van en pantalla.
        </Typography>
        <DemoPlayer key={phone ? "v" : "h"} clip={main} maxWidth={phone ? 420 : 1040} />
        <Stack alignItems="center" sx={{ mt: 4 }}>
          {!tourOpen && (
            <Button
              variant="outlined"
              size="large"
              startIcon={<OndemandVideoIcon />}
              onClick={() => { setTourOpen(true); tour.current?.start(); }}
              sx={{ fontSize: "1.15rem", minHeight: 56, px: 3, borderWidth: 2, "&:hover": { borderWidth: 2 } }}
            >
              Ver el recorrido completo (1 min)
            </Button>
          )}
        </Stack>
        <Collapse in={tourOpen} data-testid="tour">
          <Typography component="h3" sx={{ fontWeight: 700, fontSize: { xs: "1.3rem", md: "1.5rem" }, textAlign: "center", mb: 1 }}>
            Recorrido completo
          </Typography>
          <Typography sx={{ fontSize: "1.1rem", color: MUTED, textAlign: "center", maxWidth: 720, mx: "auto", mb: 3 }}>
            La pesada desde el celular, la nómina con anticipos, la conexión con ChatGPT, fincas separadas y la consola de soporte.
          </Typography>
          {/* No poster request until the tour is opened. */}
          <DemoPlayer ref={tour} clip={CLIPS.tour} maxWidth={1040} hidePoster={!tourOpen} />
        </Collapse>
        <Typography sx={{ mt: 2.5, fontSize: "0.95rem", color: MUTED, textAlign: "center" }}>
          Datos de demostración. Música original.
        </Typography>
      </Container>
    </Box>
  );
}
