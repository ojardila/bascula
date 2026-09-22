/**
 * Public conversion page: a finca owner should want to register before they
 * finish scrolling. Photos are Unsplash (free commercial use); the product
 * mock is CSS, not a screenshot that would rot.
 */
import { Link as RouterLink } from "react-router-dom";
import { Box, Button, Container, Stack, Typography } from "@mui/material";
import { GREEN, GREEN_DARK } from "../../theme";
import { useAuth } from "../../auth/AuthContext";

const DISPLAY = '"Fraunces", Georgia, serif';
const SANS = '"Outfit", "Roboto", sans-serif';

const STEPS = [
  { n: "01", title: "Ponga su nombre", body: "Un minuto. Nombre, correo, teléfono. Usted elige el identificador." },
  { n: "02", title: "Pese la cosecha", body: "Un lote, un día, los kilos de cada persona. En el celular, en la romana." },
  { n: "03", title: "Pague con el recibo que suma", body: "Semana, saldo anterior, descuentos y pago. El trabajador firma. Queda paz y salvo." },
];

const FEATURES = [
  {
    img: "/landing/cherries.jpg",
    alt: "Cerezas de café",
    kicker: "La romana",
    title: "La planilla, sin el cuaderno que se moja",
    body: "Deje de pasar kilos a Excel el sábado. Cada pesada queda en el lote y en el día, con el nombre de quien recogió.",
  },
  {
    img: "/landing/branch.jpg",
    alt: "Café en el palo",
    kicker: "La plata",
    title: "Liquidación que cuadra, no que se discute",
    body: "El recibo nombra semana actual, saldo anterior, cada descuento y lo pagado. Si no suma, no se imprime.",
  },
  {
    img: "/landing/beans.jpg",
    alt: "Café servido",
    kicker: "El asistente",
    title: "Pregúntele a ChatGPT por su propia finca",
    body: "Conecte Báscula. Pregunte cómo quedó el recibo de Elena o cuánto se recolectó esta semana — sin abrirle el libro a nadie más.",
  },
];

export function LandingPage() {
  const { status, landing } = useAuth();
  const signedIn = status === "authenticated";

  return (
    <Box sx={{ minHeight: "100dvh", bgcolor: "#0e120e", color: "#f4f1ea", fontFamily: SANS }}>
      <Hero signedIn={signedIn} landing={landing} />
      <Proof />
      <Features />
      <How />
      <OwnUrl signedIn={signedIn} />
      <Footer />
    </Box>
  );
}

function Cta({ to, children, dark }: { to: string; children: string; dark?: boolean }) {
  return (
    <Button
      component={RouterLink}
      to={to}
      variant="contained"
      size="large"
      sx={{
        fontFamily: SANS,
        fontWeight: 700,
        px: 4,
        minHeight: 56,
        borderRadius: 999,
        bgcolor: dark ? GREEN : "#f4f1ea",
        color: dark ? "#fff" : GREEN_DARK,
        "&:hover": { bgcolor: dark ? GREEN_DARK : "#fff" },
      }}
    >
      {children}
    </Button>
  );
}

function Hero({ signedIn, landing }: { signedIn: boolean; landing: string }) {
  return (
    <Box sx={{ position: "relative", minHeight: { xs: "92dvh", md: "100dvh" }, overflow: "hidden" }}>
      <Box
        component="img"
        src="/landing/hills.jpg"
        alt=""
        sx={{
          position: "absolute", inset: 0, width: "100%", height: "100%",
          objectFit: "cover", objectPosition: "center 40%",
        }}
      />
      <Box
        sx={{
          position: "absolute", inset: 0,
          background:
            "linear-gradient(180deg, rgba(8,12,8,.55) 0%, rgba(8,12,8,.35) 40%, rgba(8,12,8,.82) 100%)",
        }}
      />
      <Container maxWidth="lg" sx={{ position: "relative", zIndex: 1, pt: 3, pb: 8, minHeight: { xs: "92dvh", md: "100dvh" }, display: "flex", flexDirection: "column" }}>
        <Stack direction="row" justifyContent="space-between" alignItems="center">
          <Typography sx={{ fontFamily: DISPLAY, fontWeight: 700, fontSize: 22, letterSpacing: "-0.03em" }}>
            Báscula
          </Typography>
          <Button
            component={RouterLink}
            to={signedIn ? landing : "/entrar"}
            variant="outlined"
            sx={{
              color: "#fff", borderColor: "rgba(255,255,255,.45)", borderRadius: 999,
              "&:hover": { borderColor: "#fff", bgcolor: "rgba(255,255,255,.08)" },
            }}
          >
            {signedIn ? "Ir a mi finca" : "Entrar"}
          </Button>
        </Stack>

        <Box sx={{ flex: 1, display: "flex", flexDirection: "column", justifyContent: "flex-end", maxWidth: 760, pb: { xs: 2, md: 6 } }}>
          <Typography sx={{ letterSpacing: "0.18em", textTransform: "uppercase", fontSize: 12, fontWeight: 600, opacity: 0.85, mb: 2 }}>
            Café de finca · Colombia
          </Typography>
          <Typography
            component="h1"
            sx={{
              fontFamily: DISPLAY,
              fontWeight: 700,
              fontSize: { xs: "2.6rem", sm: "3.6rem", md: "4.4rem" },
              lineHeight: 1.05,
              letterSpacing: "-0.03em",
              mb: 2,
            }}
          >
            Deje de liquidar la cosecha en un cuaderno.
          </Typography>
          <Typography sx={{ fontSize: { xs: "1.15rem", md: "1.35rem" }, opacity: 0.92, maxWidth: 540, mb: 4, lineHeight: 1.45 }}>
            Pesada, planilla y recibo en el celular. Su finca queda en su propia
            dirección — <Box component="span" sx={{ fontFamily: "ui-monospace, monospace" }}>fincasanjose.bascula.engp.io</Box> —
            con su gente y su plata.
          </Typography>
          <Stack direction={{ xs: "column", sm: "row" }} spacing={2} alignItems={{ xs: "stretch", sm: "center" }}>
            {!signedIn && <Cta to="/empezar">Crear mi finca</Cta>}
            {signedIn && <Cta to={landing}>Ir a mi finca</Cta>}
            <Typography sx={{ opacity: 0.75, fontSize: 14 }}>
              Un minuto. Sin tarjeta. El precio del kilo lo pone después.
            </Typography>
          </Stack>
        </Box>
      </Container>
    </Box>
  );
}

function Proof() {
  const items = [
    { k: "La romana", v: "Kilos por persona, lote y día" },
    { k: "El recibo", v: "Semana, saldo, descuentos, pago" },
    { k: "Su URL", v: "La finca, en su propia casa" },
  ];
  return (
    <Box sx={{ bgcolor: "#141914", py: { xs: 4, md: 5 }, borderBottom: "1px solid rgba(255,255,255,.06)" }}>
      <Container maxWidth="lg">
        <Stack direction={{ xs: "column", md: "row" }} spacing={{ xs: 3, md: 0 }} justifyContent="space-between">
          {items.map((it) => (
            <Box key={it.k} sx={{ flex: 1, px: { md: 3 }, "&:first-of-type": { pl: 0 } }}>
              <Typography sx={{ fontFamily: DISPLAY, fontSize: 22, mb: 0.5 }}>{it.k}</Typography>
              <Typography sx={{ opacity: 0.65 }}>{it.v}</Typography>
            </Box>
          ))}
        </Stack>
      </Container>
    </Box>
  );
}

function Features() {
  return (
    <Box sx={{ bgcolor: "#f4f1ea", color: "#1a1c19", py: { xs: 8, md: 12 } }}>
      <Container maxWidth="lg">
        <Typography sx={{ fontFamily: DISPLAY, fontSize: { xs: 32, md: 44 }, letterSpacing: "-0.03em", mb: 6, maxWidth: 640 }}>
          Hecha para quien paga la cosecha, no para quien vende software.
        </Typography>
        <Stack spacing={{ xs: 8, md: 12 }}>
          {FEATURES.map((f, i) => (
            <Stack
              key={f.title}
              direction={{ xs: "column", md: i % 2 ? "row-reverse" : "row" }}
              spacing={{ xs: 3, md: 8 }}
              alignItems="center"
            >
              <Box
                component="img"
                src={f.img}
                alt={f.alt}
                sx={{
                  width: { xs: "100%", md: "52%" },
                  height: { xs: 240, md: 380 },
                  objectFit: "cover",
                  borderRadius: 3,
                }}
              />
              <Box sx={{ flex: 1 }}>
                <Typography sx={{ letterSpacing: "0.14em", textTransform: "uppercase", fontSize: 12, fontWeight: 700, color: GREEN_DARK, mb: 1 }}>
                  {f.kicker}
                </Typography>
                <Typography sx={{ fontFamily: DISPLAY, fontSize: { xs: 28, md: 34 }, lineHeight: 1.15, mb: 2 }}>
                  {f.title}
                </Typography>
                <Typography sx={{ fontSize: "1.125rem", color: "#43483f", lineHeight: 1.55 }}>
                  {f.body}
                </Typography>
              </Box>
            </Stack>
          ))}
        </Stack>
      </Container>
    </Box>
  );
}

function How() {
  return (
    <Box
      sx={{
        position: "relative",
        py: { xs: 8, md: 12 },
        color: "#f4f1ea",
        overflow: "hidden",
      }}
    >
      <Box
        component="img"
        src="/landing/hero.jpg"
        alt=""
        sx={{ position: "absolute", inset: 0, width: "100%", height: "100%", objectFit: "cover", opacity: 0.22 }}
      />
      <Box sx={{ position: "absolute", inset: 0, bgcolor: "rgba(10,14,10,.78)" }} />
      <Container maxWidth="lg" sx={{ position: "relative" }}>
        <Typography sx={{ fontFamily: DISPLAY, fontSize: { xs: 32, md: 40 }, mb: 6 }}>
          Tres pasos. El cuarto es la cosecha.
        </Typography>
        <Stack direction={{ xs: "column", md: "row" }} spacing={4}>
          {STEPS.map((s) => (
            <Box key={s.n} sx={{ flex: 1 }}>
              <Typography sx={{ fontFamily: DISPLAY, fontSize: 40, opacity: 0.35, lineHeight: 1 }}>{s.n}</Typography>
              <Typography sx={{ fontWeight: 700, fontSize: 20, mt: 1, mb: 1 }}>{s.title}</Typography>
              <Typography sx={{ opacity: 0.8 }}>{s.body}</Typography>
            </Box>
          ))}
        </Stack>
      </Container>
    </Box>
  );
}

function OwnUrl({ signedIn }: { signedIn: boolean }) {
  return (
    <Box sx={{ bgcolor: GREEN_DARK, py: { xs: 8, md: 10 } }}>
      <Container maxWidth="md" sx={{ textAlign: "center" }}>
        <Typography sx={{ fontFamily: DISPLAY, fontSize: { xs: 32, md: 48 }, letterSpacing: "-0.03em", mb: 2 }}>
          Su finca, su dirección.
        </Typography>
        <Typography sx={{ fontSize: "1.2rem", opacity: 0.9, mb: 1 }}>
          Si registra <strong>fincasanjose</strong>, entra por
        </Typography>
        <Typography
          sx={{
            fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
            fontSize: { xs: 16, md: 22 },
            mb: 4,
            wordBreak: "break-all",
          }}
        >
          fincasanjose.bascula.engp.io
        </Typography>
        {!signedIn && <Cta to="/empezar">Crear mi finca ahora</Cta>}
      </Container>
    </Box>
  );
}

function Footer() {
  return (
    <Box sx={{ bgcolor: "#0e120e", py: 3, borderTop: "1px solid rgba(255,255,255,.06)" }}>
      <Container maxWidth="lg">
        <Stack direction={{ xs: "column", sm: "row" }} justifyContent="space-between" spacing={1}>
          <Typography sx={{ fontFamily: DISPLAY, opacity: 0.7 }}>Báscula</Typography>
          <Typography sx={{ fontSize: 12, opacity: 0.4 }}>
            Fotos: Unsplash. Uso libre.
          </Typography>
        </Stack>
      </Container>
    </Box>
  );
}
