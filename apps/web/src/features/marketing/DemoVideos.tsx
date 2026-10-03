// SPDX-License-Identifier: MIT
/**
 * «Véalo funcionando»: the demo videos on the landing (main domain only; the
 * landing itself is never rendered on a farm's own address, see HomeRoute).
 *
 * The main video is the narrated explainer (demo-3): a voice explains, step by
 * step, how a farm uses Báscula, from the price per kilo to the receipt.
 * Browsers refuse autoplay with sound, so nothing plays by itself: the poster
 * carries one large play button and a tap starts the video with sound, from
 * inside the user's gesture. Nothing is downloaded until then
 * (`preload="none"`), because a farm's mobile data plan pays for every
 * megabyte and the landing must stay fast on a rural connection.
 *
 * Two shorter recordings stay behind their own buttons: the payment of one
 * picker (video 1, music only; phones in portrait get its vertical cut) and
 * the full tour (video 2, music only). The step titles and texts are on
 * screen in every video, so they read with the sound off; the Spanish .vtt
 * is there for screen readers and search, off by default so the text is not
 * shown twice. Files are imported through Vite, so they are served from
 * /assets with fingerprinted names and cached for a year (nginx.conf), and
 * they are kept out of the service worker's precache (vite.config.ts).
 * How they were made: docs/demo-videos.md.
 */
import { forwardRef, useImperativeHandle, useRef, useState } from "react";
import {
  Box,
  Button,
  ButtonBase,
  Collapse,
  Container,
  Stack,
  Typography,
  useMediaQuery,
} from "@mui/material";
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
import v3Mp4 from "./media/demo-3.mp4?url";
import v3Webm from "./media/demo-3.webm?url";
import v3Poster from "./media/demo-3-poster.webp?url";
import v3Vtt from "./media/demo-3.es.vtt?no-inline";

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
  explainer: {
    mp4: v3Mp4,
    webm: v3Webm,
    poster: v3Poster,
    vtt: v3Vtt,
    width: 1920,
    height: 1080,
    length: "1 min 28 s",
    title:
      "Video narrado: cómo funciona Báscula, del precio del kilo y la pesada diaria a la nómina, el pago y el recibo",
  },
  payment: {
    mp4: v1Mp4,
    webm: v1Webm,
    poster: v1Poster,
    vtt: v1Vtt,
    width: 1920,
    height: 1080,
    length: "45 s",
    title:
      "Video: una semana en Báscula, del tablero de cosecha al pago de un recolector con su recibo",
  },
  paymentVertical: {
    mp4: v1vMp4,
    webm: v1vWebm,
    poster: v1vPoster,
    vtt: v1vVtt,
    width: 1080,
    height: 1920,
    length: "40 s",
    title:
      "Video: una semana en Báscula, del tablero de cosecha al pago de un recolector con su recibo",
  },
  tour: {
    mp4: v2Mp4,
    webm: v2Webm,
    poster: v2Poster,
    vtt: v2Vtt,
    width: 1920,
    height: 1080,
    length: "1 min",
    title:
      "Video: recorrido completo, con la pesada en el celular, la nómina, la conexión con ChatGPT, fincas separadas y la consola de soporte",
  },
} satisfies Record<string, DemoClip>;

export interface PlayerHandle {
  start: () => void;
}

/** Poster + one big play button; the tap starts playback with sound. */
export const DemoPlayer = forwardRef<
  PlayerHandle,
  Readonly<{ clip: DemoClip; maxWidth?: number | string; hidePoster?: boolean }>
>(function DemoPlayer({ clip, maxWidth, hidePoster }, ref) {
  const video = useRef<HTMLVideoElement>(null);
  const [started, setStarted] = useState(false);
  const start = () => {
    const v = video.current;
    if (!v) return;
    setStarted(true);
    v.muted = false;
    v.volume = 1;
    // Called from the click itself: that is what lets the browser play sound.
    // Old engines return undefined instead of a promise.
    const p: Promise<void> | undefined = v.play();
    p?.catch(() => {
      /* the native controls stay available */
    });
  };
  useImperativeHandle(ref, () => ({ start }));
  return (
    <Box
      sx={{
        position: "relative",
        width: "100%",
        maxWidth,
        mx: "auto",
        aspectRatio: `${clip.width} / ${clip.height}`,
        borderRadius: 3,
        overflow: "hidden",
        bgcolor: "#1b2a1c",
        boxShadow: "0 18px 50px rgba(16,40,18,.22)",
      }}
    >
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
        style={{
          display: "block",
          width: "100%",
          height: "100%",
          objectFit: "cover",
        }}
      >
        <source src={clip.webm} type="video/webm" />
        <source src={clip.mp4} type="video/mp4" />
        <track kind="captions" srcLang="es" label="Español" src={clip.vtt} />
      </video>
      {!started && (
        <ButtonBase
          onClick={start}
          aria-label={`Reproducir con sonido: ${clip.title} (${clip.length})`}
          sx={{
            position: "absolute",
            inset: 0,
            display: "flex",
            flexDirection: "column",
            gap: 1.5,
            color: "#fff",
            background:
              "radial-gradient(circle at center, rgba(10,30,12,.28), rgba(10,30,12,.05) 60%)",
            "&:hover .play, &.Mui-focusVisible .play": {
              transform: "scale(1.06)",
              bgcolor: GREEN_DARK,
            },
            "&.Mui-focusVisible": {
              outline: "4px solid #ffc400",
              outlineOffset: -4,
            },
          }}
        >
          <Box
            className="play"
            sx={{
              width: { xs: 88, md: 112 },
              height: { xs: 88, md: 112 },
              borderRadius: "50%",
              bgcolor: GREEN,
              display: "grid",
              placeItems: "center",
              boxShadow: "0 8px 24px rgba(0,0,0,.35)",
              transition: "transform .15s, background-color .15s",
            }}
          >
            <PlayArrowRoundedIcon sx={{ fontSize: { xs: 60, md: 76 } }} />
          </Box>
          <Box
            component="span"
            sx={{
              bgcolor: "rgba(20,32,21,.82)",
              px: 2,
              py: 0.75,
              borderRadius: 99,
              fontWeight: 700,
              fontSize: { xs: "1.05rem", md: "1.15rem" },
            }}
          >
            Ver con sonido · {clip.length}
          </Box>
        </ButtonBase>
      )}
    </Box>
  );
});

/**
 * A shorter video behind its own button: nothing is fetched (not even the
 * poster) until the button is pressed, and that press starts it with sound.
 */
function MoreVideo({
  clip,
  button,
  heading,
  text,
  maxWidth,
  testId,
}: Readonly<{
  clip: DemoClip;
  button: string;
  heading: string;
  text: string;
  maxWidth: number;
  testId: string;
}>) {
  const player = useRef<PlayerHandle>(null);
  const [open, setOpen] = useState(false);
  return (
    <>
      {!open && (
        <Button
          variant="outlined"
          size="large"
          startIcon={<OndemandVideoIcon />}
          onClick={() => {
            setOpen(true);
            player.current?.start();
          }}
          sx={{
            fontSize: "1.15rem",
            minHeight: 56,
            px: 3,
            borderWidth: 2,
            "&:hover": { borderWidth: 2 },
          }}
        >
          {button}
        </Button>
      )}
      <Collapse in={open} data-testid={testId} sx={{ width: "100%" }}>
        <Typography
          component="h3"
          sx={{
            fontWeight: 700,
            fontSize: { xs: "1.3rem", md: "1.5rem" },
            textAlign: "center",
            mb: 1,
            mt: 2,
          }}
        >
          {heading}
        </Typography>
        <Typography
          sx={{
            fontSize: "1.1rem",
            color: MUTED,
            textAlign: "center",
            maxWidth: 720,
            mx: "auto",
            mb: 3,
          }}
        >
          {text}
        </Typography>
        <DemoPlayer
          ref={player}
          clip={clip}
          maxWidth={maxWidth}
          hidePoster={!open}
        />
      </Collapse>
    </>
  );
}

export function DemoVideos() {
  // Portrait phones get the vertical cut of the payment video; checked once
  // per render, and the player is keyed on it so a rotation swaps the element.
  const phone = useMediaQuery(
    "(max-width:599.95px) and (orientation: portrait)",
    { noSsr: true },
  );
  const payment = phone ? CLIPS.paymentVertical : CLIPS.payment;
  return (
    <Box
      component="section"
      id="video"
      aria-labelledby="video-title"
      sx={{ bgcolor: "#fff", py: { xs: 7, md: 10 } }}
    >
      <Container maxWidth="lg">
        <Typography
          id="video-title"
          component="h2"
          sx={{
            fontFamily: DISPLAY,
            fontWeight: 700,
            fontSize: { xs: "2rem", md: "2.6rem" },
            lineHeight: 1.15,
            letterSpacing: "-0.02em",
            textAlign: "center",
            mb: 2,
          }}
        >
          Véalo funcionando
        </Typography>
        <Typography
          sx={{
            fontSize: { xs: "1.15rem", md: "1.3rem" },
            color: MUTED,
            textAlign: "center",
            maxWidth: 720,
            mx: "auto",
            mb: { xs: 4, md: 5 },
          }}
        >
          En menos de un minuto y medio, una voz le explica paso a paso cómo
          funciona Báscula: el precio del kilo, la pesada de cada día, la nómina
          de la semana, el pago y el recibo. Los pasos también van escritos en
          pantalla.
        </Typography>
        <DemoPlayer clip={CLIPS.explainer} maxWidth={1040} />
        <Stack
          spacing={2}
          sx={{
            alignItems: "center",
            mt: 4,
          }}
        >
          <MoreVideo
            key={phone ? "v" : "h"}
            clip={payment}
            maxWidth={phone ? 420 : 1040}
            testId="payment"
            button={`Ver el pago a un recolector (${payment.length})`}
            heading="El pago a un recolector"
            text="La semana de cosecha, el pago a un recolector con su anticipo descontado y el recibo. Tiene música, sin voz; los textos van en pantalla."
          />
          <MoreVideo
            clip={CLIPS.tour}
            maxWidth={1040}
            testId="tour"
            button="Ver el recorrido completo (1 min)"
            heading="Recorrido completo"
            text="La pesada desde el celular, la nómina con anticipos, la conexión con ChatGPT, fincas separadas y la consola de soporte. Tiene música, sin voz; los textos van en pantalla."
          />
        </Stack>
        <Typography
          sx={{
            mt: 2.5,
            fontSize: "0.95rem",
            color: MUTED,
            textAlign: "center",
          }}
        >
          Datos de demostración. Música original.
        </Typography>
      </Container>
    </Box>
  );
}
