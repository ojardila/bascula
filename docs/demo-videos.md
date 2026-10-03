# Demo videos on the landing

The «Véalo funcionando» (See it in action) section of the landing (`apps/web/src/features/marketing/DemoVideos.tsx`) shows three videos. It appears on the main domain only: the landing is never rendered on a farm's own address.

| File (`apps/web/src/features/marketing/media/`) | What |
|---|---|
| `demo-3.mp4` / `.webm`, `demo-3-poster.webp`, `demo-3.es.vtt` | **Main video.** Narrated explainer, 1920×1080, 88 s, Spanish voice-over in 7 titled steps: price per kilo (and special prices) → workers and teams → daily weighing → weekly settlement → payment and receipt → sales and plots → phone, offline use and ChatGPT/Claude |
| `demo-1.mp4` / `.webm`, `demo-1-poster.webp`, `demo-1.es.vtt` | Payment of one picker, behind the «Ver el pago a un recolector» button. 1920×1080, 45 s: harvest dashboard → workers → pay a picker (advance deducted) → «Pago registrado» (Payment recorded) → receipt and PDF → money history |
| `demo-1-vertical.*` | The same flow, 1080×1920, 40 s, used instead of `demo-1` on phones held upright |
| `demo-2.*` | Full tour, behind the «Ver el recorrido completo» button. 1920×1080, 64 s: weighing on the phone, crew payroll with advances, settlements, «Conexiones» (Connections) / «Conectar con ChatGPT» (Connect to ChatGPT), two farms side by side, bascula.engp.io/empezar, support console |

## Video 3: narrated explainer

- **Pictures:** real Báscula screens with demonstration data (the DEV farm «San José» and the demo farm «La Esperanza» from the landing screenshots), shown in a browser window and phone frames with slow zooms and highlight boxes. A list of the 7 steps stays on the left, and a numbered card shows the current step's title and a one-line summary, so it reads with the sound off. The chat bubble in step 7 is labelled «Conversación de ejemplo» (sample conversation).
- **Voice:** Microsoft Edge neural TTS, voice `es-CO-SalomeNeural` at +8 % rate. The `.vtt` carries the narration text.
- **Music:** original, synthesized from code (no samples), released as CC0 1.0; ducked under the voice and normalized to −16 LUFS.
- **How it was made:** an HTML page (Fraunces and Outfit, SIL OFL) is rendered frame by frame with Playwright at 30 fps, then encoded with ffmpeg. Same pipeline and visual style as the selca explainer.

## Videos 1 and 2

- **Recording:** Báscula v0.2.33, on an isolated local stack with fictional farms (La Esperanza, El Mirador). No production data. The browser address bar shows the production-style farm addresses. The «ChatGPT» connection was a real OAuth grant against the local API and was removed afterwards.
- **Sound:** music only, no voice. Captions are burned into the picture; the `.vtt` files carry the same text.
- **Music:** original, synthesized from code (no samples), released as CC0 1.0, normalized to −20 LUFS. Card fonts: Fraunces and Outfit (SIL OFL).

## All videos

- **Encoding:** H.264 High (yuv420p, `+faststart`) with AAC 128k, and VP9 with Opus 96k.
- **Delivery:** the files are imported through Vite, so they end up in `/assets/` with fingerprinted names, where `nginx.conf` sets `Cache-Control: public, immutable` for a year. They are not in the service worker's precache. Players use `preload="none"` and start only on a tap, with sound. Videos 1 and 2 do not even fetch their posters until their button is pressed.
- **Accessibility:** the `.vtt` files are attached as Spanish captions, off by default so the on-screen text is not shown twice.

To replace a video, overwrite the file under `media/` with the same name. The hash in the URL changes by itself.
