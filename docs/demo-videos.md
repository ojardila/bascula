# Demo videos on the landing

The «Véalo funcionando» section of the landing (`apps/web/src/features/marketing/DemoVideos.tsx`) shows two videos. It appears on the main domain only: the landing is never rendered on a farm's own address.

| File (`apps/web/src/features/marketing/media/`) | What |
|---|---|
| `demo-1.mp4` / `.webm`, `demo-1-poster.webp`, `demo-1.es.vtt` | Main flow, 1920×1080, 45 s: harvest dashboard → workers → pay a picker (advance deducted) → «Pago registrado» → receipt and PDF → money history |
| `demo-1-vertical.*` | The same flow, 1080×1920, 40 s, for phones held upright |
| `demo-2.*` | Full tour, 1920×1080, 64 s: weighing on the phone, crew payroll with advances, settlements, Conexiones / «Conectar con ChatGPT», two farms side by side, bascula.engp.io/empezar, support console |

- **Recording:** Báscula v0.2.33, on an isolated local stack with fictional farms (La Esperanza, El Mirador). No production data. The browser address bar shows the production-style farm addresses. The «ChatGPT» connection was a real OAuth grant against the local API and was removed afterwards.
- **Captions:** Spanish captions are burned into the picture, so the videos read with the sound off. The `.vtt` files carry the same text for assistive technology and search, and they are not shown by default.
- **Music:** original, synthesized from code (no samples), released as CC0 1.0, normalized to −20 LUFS. Card fonts: Fraunces and Outfit (SIL OFL).
- **Encoding:** H.264 High (yuv420p, `+faststart`) with AAC 128k, and VP9 with Opus 96k.
- **Delivery:** the files are imported through Vite, so they end up in `/assets/` with fingerprinted names, where `nginx.conf` sets `Cache-Control: public, immutable` for a year. They are not in the service worker's precache. Players use `preload="none"` and start only on a tap, with sound.

To replace a video, overwrite the file under `media/` with the same name. The hash in the URL changes by itself.
