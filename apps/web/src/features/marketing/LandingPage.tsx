/**
 * Public landing for coffee-farm owners and administrators who pay the harvest
 * by the kilo. Structure and copy: Notion "Báscula: Landing completa, estructura
 * y copy" (25 Sep 2026), complemented by "Báscula — Copy de landing".
 *
 * One goal per section, one form on the page: every "Solicitar una
 * demostración" scrolls to #demo. "Cree su finca gratis" keeps the self-serve
 * route to /empezar for people who prefer to start on their own.
 *
 * Audience is often around fifty and not used to software: large type, plain
 * Spanish (de usted), one column on the phone, visible field labels.
 *
 * Images: real screens of the web app with demo data (labelled as such),
 * framed as a computer browser and a phone browser, explain; the Unsplash
 * coffee photos only accompany. Báscula is a web app: nothing to install,
 * it can be added to the phone's home screen, and weighings can be recorded
 * with no signal (they upload on their own). Regenerate the screens with the
 * scripts described in docs/screenshots/README.md.
 */
import { useState, type FormEvent, type ReactNode } from "react";
import { Link as RouterLink } from "react-router-dom";
import {
  Accordion,
  AccordionDetails,
  AccordionSummary,
  Alert,
  Box,
  Button,
  Container,
  Stack,
  TextField,
  Typography,
} from "@mui/material";
import ExpandMoreIcon from "@mui/icons-material/ExpandMore";
import CheckCircleOutlineIcon from "@mui/icons-material/CheckCircleOutline";
import PhoneAndroidIcon from "@mui/icons-material/PhoneAndroid";
import AddToHomeScreenIcon from "@mui/icons-material/AddToHomeScreen";
import ComputerIcon from "@mui/icons-material/Computer";
import InfoOutlinedIcon from "@mui/icons-material/InfoOutlined";
import { GREEN, GREEN_DARK } from "../../theme";
import { useAuth } from "../../auth/AuthContext";

const DISPLAY = '"Fraunces", Georgia, serif';
const SANS = '"Outfit", "Roboto", sans-serif';
const INK = "#1a1c19";
const MUTED = "#43483f";
const CREAM = "#f4f1ea";
const LINE = "#dde5da";
const LEAD_EMAIL = "oscar3425@gmail.com";

const DEMO_CTA = "Solicitar una demostración";
const DEMO_NOTE = "Demostración gratuita y sin compromiso.";

/* ------------------------------------------------------------------ copy -- */

const NAV_LINKS = [
  { href: "#como-funciona", label: "Cómo funciona" },
  { href: "#que-puede-consultar", label: "Qué puede consultar" },
  { href: "#preguntas-frecuentes", label: "Preguntas frecuentes" },
];

const PROBLEMS = [
  { title: "Pesadas por revisar.", body: "Encontrar cuánto recogió cada persona, en qué lote y qué día." },
  { title: "Anticipos por descontar.", body: "Recordar qué dinero ya entregó antes de calcular el saldo." },
  { title: "Cuentas por explicar.", body: "Mostrar de dónde sale el valor que recibe cada recolector." },
];

const STEPS = [
  { n: "01", title: "Registre los kilos", body: "Seleccione la persona y el lote, e ingrese el peso. Puede registrar kilos sin señal: se suben solos cuando vuelve la conexión." },
  { n: "02", title: "Revise la semana", body: "Consulte los kilos registrados y la tarifa correspondiente. Antes de liquidar, confirme que no queden pesadas por subir." },
  { n: "03", title: "Calcule lo que debe", body: "Calcule el valor del trabajo y aplique los anticipos y descuentos registrados." },
  { n: "04", title: "Registre lo que entrega", body: "Deje constancia del pago y consulte cuánto queda pendiente. Revise el detalle con el recolector." },
];

const EXAMPLE_ROWS: { label: string; value: string; strong?: boolean }[] = [
  { label: "Kilos registrados en la semana", value: "200 kg" },
  { label: "Tarifa del ejemplo", value: "$1.000 por kg" },
  { label: "Valor de la recolección", value: "$200.000", strong: true },
  { label: "Anticipo ya entregado", value: "−$50.000" },
  { label: "Pendiente antes del pago", value: "$150.000", strong: true },
  { label: "Pago que registra hoy", value: "−$100.000" },
];

const QUESTIONS = [
  { img: "/landing/app/week-detail.jpg", alt: "Pantalla de Báscula con los kilos por recolector y día de una semana", title: "¿Cuánto recogió cada persona?", body: "Consulte kilos por recolector, día y semana. Revise en qué lotes trabajó." },
  { img: "/landing/app/account.jpg", alt: "Pantalla de Báscula con el estado de cuenta de un recolector", title: "¿Cuánto queda pendiente por pagar?", body: "Vea el valor del trabajo, los anticipos, los descuentos y los pagos registrados de cada persona." },
  { img: "/landing/app/crop-detail.jpg", alt: "Pantalla de Báscula con la recolección de un lote por semana", title: "¿Cuánto produjo cada lote?", body: "Revise la recolección por lote y semana para ver cómo cambia durante la cosecha." },
];

const FOR_WHOM = [
  "Paga la recolección por kilo.",
  "Lleva cuentas de varios recolectores.",
  "Entrega anticipos o hace pagos parciales.",
  "Revisa kilos y cuentas al terminar la semana.",
];

const DEMO_POINTS = [
  "Recorra el registro de kilos por persona y lote.",
  "Vea cómo se aplican anticipos y se registran pagos.",
  "Resuelva sus preguntas sobre el uso en campo y oficina.",
];

const FAQ = [
  { q: "¿Tengo que instalar algo?", a: "No. Báscula es una aplicación web: se abre en el navegador del celular o del computador, con la dirección de su finca. Si quiere, agréguela a la pantalla de inicio del celular y ábrala como cualquier aplicación." },
  { q: "¿Puedo usar Báscula si no hay señal en la finca?", a: "Sí, para registrar kilos sin señal: las pesadas se guardan en el celular y se suben solas cuando vuelve la conexión. Para ver informes, pagar y liquidar necesita conexión y los datos al día." },
  { q: "¿Necesito comprar una báscula especial?", a: "Puede ingresar manualmente el peso que marca su báscula. Ese registro no requiere una conexión automática entre la báscula y el celular." },
  { q: "¿Puedo llevar anticipos y pagos parciales?", a: "Sí. Puede registrar anticipos, aplicarlos a la cuenta y dejar constancia de pagos parciales. El saldo muestra cuánto queda pendiente." },
  { q: "¿Báscula transfiere el dinero al recolector?", a: "Báscula permite registrar el dinero que usted entrega y consultar el saldo. El pago al recolector lo realiza por el medio que utiliza en su finca." },
  { q: "¿Puedo consultar cuánto se recoge en cada lote?", a: "Sí. Puede revisar los kilos por lote, recolector y semana." },
  { q: "¿Cuánto cuesta?", a: "La demostración es gratuita. Solicítela para conocer las condiciones de uso y el costo del servicio antes de empezar." },
  { q: "¿Tengo que llevar los datos de mi finca a la demostración?", a: "Puede conocer el recorrido con datos de ejemplo. Cuéntenos cómo registra los kilos y paga la recolección para enfocar la conversación en su operación." },
];

/* ------------------------------------------------------------- building -- */

export function LandingPage() {
  const { status, landing } = useAuth();
  const signedIn = status === "authenticated";
  return (
    <Box sx={{ minHeight: "100dvh", bgcolor: "#fff", color: INK, fontFamily: SANS, "& section": { scrollMarginTop: { xs: 72, md: 88 } } }}>
      <NavBar signedIn={signedIn} landing={landing} />
      <Box component="main">
        <Hero />
        <Problem />
        <HowItWorks />
        <Example />
        <WhatYouCanSee />
        <FieldAndOffice />
        <ForWhom />
        <DemoPreview />
        <Faq />
        <Closing signedIn={signedIn} landing={landing} />
      </Box>
      <Footer signedIn={signedIn} landing={landing} />
    </Box>
  );
}

function Section(props: { id?: string; bg?: string; color?: string; children: ReactNode; maxWidth?: "sm" | "md" | "lg" }) {
  return (
    <Box component="section" id={props.id} sx={{ bgcolor: props.bg ?? "#fff", color: props.color ?? INK, py: { xs: 7, md: 11 } }}>
      <Container maxWidth={props.maxWidth ?? "lg"}>{props.children}</Container>
    </Box>
  );
}

function SectionTitle(props: { children: ReactNode; center?: boolean; color?: string }) {
  return (
    <Typography
      component="h2"
      sx={{ fontFamily: DISPLAY, fontWeight: 700, fontSize: { xs: "2rem", md: "2.75rem" }, lineHeight: 1.15, letterSpacing: "-0.02em", mb: 2.5, maxWidth: 780, color: props.color, textAlign: props.center ? "center" : undefined, mx: props.center ? "auto" : undefined }}
    >
      {props.children}
    </Typography>
  );
}

function Lead(props: { children: ReactNode; center?: boolean; color?: string }) {
  return (
    <Typography sx={{ fontSize: { xs: "1.2rem", md: "1.3rem" }, lineHeight: 1.55, color: props.color ?? MUTED, maxWidth: 720, textAlign: props.center ? "center" : undefined, mx: props.center ? "auto" : undefined }}>
      {props.children}
    </Typography>
  );
}

/** The one primary action of the page. Always scrolls to the form. */
function DemoButton(props: { light?: boolean; fullWidthOnMobile?: boolean }) {
  const light = Boolean(props.light);
  return (
    <Button
      component="a"
      href="#demo"
      variant="contained"
      size="large"
      sx={{
        fontFamily: SANS, fontWeight: 700, fontSize: { xs: "1.15rem", md: "1.2rem" }, minHeight: 60, px: 4, borderRadius: 999,
        width: props.fullWidthOnMobile ? { xs: "100%", sm: "auto" } : undefined,
        bgcolor: light ? CREAM : GREEN, color: light ? GREEN_DARK : "#fff",
        "&:hover": { bgcolor: light ? "#fff" : GREEN_DARK },
      }}
    >
      {DEMO_CTA}
    </Button>
  );
}

function DemoLabel() {
  return (
    <Box sx={{ display: "table", mx: "auto", mt: 1.5, bgcolor: "rgba(26,28,25,.85)", color: "#fff", px: 1.5, py: 0.5, borderRadius: 999, fontSize: 14, fontWeight: 600, whiteSpace: "nowrap" }}>
      Datos de demostración
    </Box>
  );
}

/** A phone-browser screen. The frame and address bar are part of the image. */
function Screenshot(props: { src: string; alt: string; maxWidth?: number }) {
  return (
    <Box sx={{ mx: "auto", maxWidth: props.maxWidth ?? 300, width: "100%" }}>
      <Box
        component="img"
        src={props.src}
        alt={props.alt}
        loading="lazy"
        sx={{ display: "block", width: "100%", height: "auto", filter: "drop-shadow(0 18px 30px rgba(20,40,20,.18))" }}
      />
      <DemoLabel />
    </Box>
  );
}

/**
 * The same farm on a computer browser and a phone browser, overlapping: one
 * web address, two screens, nothing to install.
 */
function HeroScreens() {
  // The phone is taller than the computer screen it overlaps; the bottom
  // padding (a share of the width, so it scales with both images) is the room
  // it hangs into, so it never covers the label or the caption below.
  return (
    <Box>
      <Box sx={{ position: "relative", width: "100%", pb: { xs: "30%", md: "16%" } }}>
        <Box
          component="img"
          src="/landing/app/desktop-home.jpg"
          alt="Báscula abierta en el navegador del computador: kilos recolectados por semana en la finca"
          sx={{ display: "block", width: "86%", height: "auto", borderRadius: 3 }}
        />
        <Box
          component="img"
          src="/landing/app/phone-weigh.png"
          alt="Báscula abierta en el navegador del celular: registro de una pesada con persona, lote, día y kilos"
          sx={{ position: "absolute", right: 0, bottom: 0, width: "34%", height: "auto", filter: "drop-shadow(0 18px 30px rgba(20,40,20,.25))" }}
        />
      </Box>
      <Box sx={{ mt: 2 }}>
        <DemoLabel />
      </Box>
    </Box>
  );
}

/* ----------------------------------------------------------- 1. nav bar -- */

function NavBar(props: { signedIn: boolean; landing: string }) {
  const { signedIn, landing } = props;
  return (
    <Box component="header" sx={{ position: "sticky", top: 0, zIndex: 10, bgcolor: "rgba(255,255,255,.96)", backdropFilter: "blur(6px)", borderBottom: `1px solid ${LINE}` }}>
      <Container maxWidth="lg">
        <Stack direction="row" alignItems="center" spacing={3} sx={{ minHeight: { xs: 64, md: 76 } }}>
          <Typography component="a" href="#" sx={{ fontFamily: DISPLAY, fontWeight: 700, fontSize: 26, letterSpacing: "-0.03em", color: INK, textDecoration: "none" }}>
            Báscula
          </Typography>
          <Box component="nav" aria-label="Secciones" sx={{ display: { xs: "none", md: "flex" }, gap: 3, flex: 1, justifyContent: "center" }}>
            {NAV_LINKS.map((l) => (
              <Box key={l.href} component="a" href={l.href} sx={{ color: MUTED, fontSize: "1.05rem", fontWeight: 500, textDecoration: "none", "&:hover": { color: GREEN_DARK, textDecoration: "underline" } }}>
                {l.label}
              </Box>
            ))}
          </Box>
          <Box sx={{ flex: { xs: 1, md: "none" } }} />
          <Button component={RouterLink} to={signedIn ? landing : "/entrar"} sx={{ color: GREEN_DARK, fontSize: "1.05rem", fontWeight: 700 }}>
            {signedIn ? "Ir a mi finca" : "Iniciar sesión"}
          </Button>
          <Button component="a" href="#demo" variant="contained" sx={{ display: { xs: "none", md: "inline-flex" }, borderRadius: 999, fontSize: "1.05rem", px: 3 }}>
            {DEMO_CTA}
          </Button>
        </Stack>
      </Container>
    </Box>
  );
}

/* ------------------------------------------------------------- 2. hero -- */

function Hero() {
  return (
    <Box component="section" sx={{ bgcolor: CREAM, py: { xs: 6, md: 10 }, overflow: "hidden" }}>
      <Container maxWidth="lg">
        <Stack direction={{ xs: "column", md: "row" }} spacing={{ xs: 6, md: 8 }} alignItems="center">
          <Box sx={{ flex: 1.2 }}>
            <Typography sx={{ letterSpacing: "0.14em", textTransform: "uppercase", fontSize: 15, fontWeight: 700, color: GREEN_DARK, mb: 2 }}>
              Para fincas cafeteras
            </Typography>
            <Typography component="h1" sx={{ fontFamily: DISPLAY, fontWeight: 700, fontSize: { xs: "2.4rem", sm: "3rem", md: "3.5rem" }, lineHeight: 1.1, letterSpacing: "-0.03em", mb: 3 }}>
              Registre los kilos de café y calcule cuánto debe a cada recolector.
            </Typography>
            <Typography sx={{ fontSize: { xs: "1.25rem", md: "1.4rem" }, lineHeight: 1.5, color: MUTED, mb: 4, maxWidth: 600 }}>
              Lleve los kilos por persona y lote, descuente anticipos y consulte el saldo pendiente de cada recolector.
            </Typography>
            <Stack direction={{ xs: "column", sm: "row" }} spacing={2} alignItems={{ xs: "stretch", sm: "center" }}>
              <DemoButton fullWidthOnMobile />
              <Button component="a" href="#como-funciona" sx={{ fontSize: "1.15rem", color: GREEN_DARK, textDecoration: "underline", minHeight: 56 }}>
                Ver cómo funciona
              </Button>
            </Stack>
            <Typography sx={{ mt: 2.5, fontSize: "1.05rem", color: MUTED, maxWidth: 520 }}>
              Le mostramos una cuenta semanal de principio a fin. Demostración gratuita y sin compromiso.
            </Typography>
          </Box>
          <Box component="figure" sx={{ flex: 1, m: 0, width: "100%", textAlign: "center" }}>
            <HeroScreens />
            <Typography component="figcaption" sx={{ mt: 2.5, fontSize: "1.05rem", color: MUTED }}>
              Se abre en el navegador del celular o del computador. No hay nada que instalar.
            </Typography>
          </Box>
        </Stack>
      </Container>
    </Box>
  );
}

/* ---------------------------------------------------------- 3. problem -- */

function Problem() {
  return (
    <Section>
      <SectionTitle>¿Cuánto tiempo dedica a juntar las cuentas de la cosecha?</SectionTitle>
      <Lead>
        Los kilos están en el cuaderno, los anticipos en otra lista y las cuentas de la semana en Excel. Para saber cuánto debe, tiene que reunirlo todo.
      </Lead>
      <Stack direction={{ xs: "column", md: "row" }} spacing={3} sx={{ mt: 5 }}>
        {PROBLEMS.map((p) => (
          <Box key={p.title} sx={{ flex: 1, p: 3.5, borderRadius: 4, bgcolor: "#f6f7f4", border: `1px solid ${LINE}` }}>
            <Typography component="h3" sx={{ fontWeight: 700, fontSize: "1.35rem", mb: 1 }}>{p.title}</Typography>
            <Typography sx={{ fontSize: "1.15rem", color: MUTED, lineHeight: 1.5 }}>{p.body}</Typography>
          </Box>
        ))}
      </Stack>
      <Typography sx={{ mt: 5, fontSize: { xs: "1.2rem", md: "1.3rem" }, fontWeight: 600, color: GREEN_DARK, maxWidth: 760 }}>
        Báscula reúne los registros de cosecha y los movimientos de cada persona para que pueda seguir la cuenta.
      </Typography>
    </Section>
  );
}

/* ----------------------------------------------------- 4. how it works -- */

function HowItWorks() {
  return (
    <Section id="como-funciona" bg="#f6f7f4">
      <SectionTitle>Así pasa una pesada a la cuenta del recolector.</SectionTitle>
      <Box component="ol" sx={{ listStyle: "none", p: 0, m: 0, mt: 5, display: "grid", gap: 3, gridTemplateColumns: { xs: "1fr", sm: "1fr 1fr", lg: "repeat(4, 1fr)" } }}>
        {STEPS.map((s) => (
          <Box component="li" key={s.n} sx={{ p: 3.5, borderRadius: 4, bgcolor: "#fff", border: `1px solid ${LINE}` }}>
            <Typography aria-hidden sx={{ fontFamily: DISPLAY, fontSize: 44, fontWeight: 700, color: GREEN, lineHeight: 1, mb: 1.5 }}>{s.n}</Typography>
            <Typography component="h3" sx={{ fontWeight: 700, fontSize: "1.35rem", mb: 1 }}>{s.title}</Typography>
            <Typography sx={{ fontSize: "1.15rem", color: MUTED, lineHeight: 1.5 }}>{s.body}</Typography>
          </Box>
        ))}
      </Box>
      <Box sx={{ mt: 5 }}>
        <DemoButton fullWidthOnMobile />
      </Box>
    </Section>
  );
}

/* ---------------------------------------------------------- 5. example -- */

function Example() {
  return (
    <Section maxWidth="md">
      <SectionTitle center>Vea de dónde sale cada saldo.</SectionTitle>
      <Lead center>Revise los kilos, el valor del trabajo y el dinero que ya entregó.</Lead>
      <Box sx={{ mt: 5, mx: "auto", maxWidth: 620, borderRadius: 4, border: `2px solid ${LINE}`, overflow: "hidden", boxShadow: "0 12px 40px rgba(20,40,20,.08)" }}>
        <Typography sx={{ bgcolor: "#f6f7f4", px: { xs: 2.5, md: 4 }, py: 1.5, fontSize: 14, fontWeight: 700, letterSpacing: "0.08em", color: GREEN_DARK, borderBottom: `1px solid ${LINE}` }}>
          EJEMPLO ILUSTRATIVO · VALORES EN PESOS COLOMBIANOS
        </Typography>
        <Box component="dl" sx={{ m: 0, px: { xs: 2.5, md: 4 }, py: 1 }}>
          {EXAMPLE_ROWS.map((r) => (
            <Stack key={r.label} direction="row" justifyContent="space-between" alignItems="baseline" spacing={2} sx={{ py: 1.75, borderBottom: `1px solid ${LINE}` }}>
              <Box component="dt" sx={{ fontSize: { xs: "1.1rem", md: "1.2rem" }, color: r.strong ? INK : MUTED, fontWeight: r.strong ? 700 : 400 }}>{r.label}</Box>
              <Box component="dd" sx={{ m: 0, fontSize: { xs: "1.15rem", md: "1.3rem" }, fontWeight: r.strong ? 700 : 500, whiteSpace: "nowrap", fontVariantNumeric: "tabular-nums" }}>{r.value}</Box>
            </Stack>
          ))}
        </Box>
        <Stack direction="row" justifyContent="space-between" alignItems="baseline" spacing={2} sx={{ bgcolor: GREEN_DARK, color: "#fff", px: { xs: 2.5, md: 4 }, py: 2.5 }}>
          <Typography sx={{ fontSize: { xs: "1.25rem", md: "1.4rem" }, fontWeight: 700 }}>Saldo pendiente</Typography>
          <Typography sx={{ fontSize: { xs: "1.5rem", md: "1.75rem" }, fontWeight: 700, whiteSpace: "nowrap", fontVariantNumeric: "tabular-nums" }}>$50.000</Typography>
        </Stack>
      </Box>
      <Typography sx={{ mt: 2, fontSize: "1rem", color: MUTED, textAlign: "center" }}>
        Ejemplo sin otros saldos ni descuentos. Los kilos y la tarifa son ilustrativos.
      </Typography>
      <Typography sx={{ mt: 4, fontSize: { xs: "1.2rem", md: "1.3rem" }, fontWeight: 600, color: GREEN_DARK, textAlign: "center" }}>
        Cada movimiento ayuda a explicar cuánto se debía, cuánto se entregó y cuánto falta.
      </Typography>
    </Section>
  );
}

/* ----------------------------------------------- 6. what you can check -- */

function WhatYouCanSee() {
  return (
    <Section id="que-puede-consultar" bg={CREAM}>
      <SectionTitle>Responda las preguntas de cada semana.</SectionTitle>
      <Box sx={{ mt: 5, display: "grid", gap: { xs: 7, md: 4 }, gridTemplateColumns: { xs: "1fr", md: "repeat(3, 1fr)" } }}>
        {QUESTIONS.map((q) => (
          <Box key={q.title}>
            <Screenshot src={q.img} alt={q.alt} maxWidth={280} />
            <Typography component="h3" sx={{ mt: 3.5, fontWeight: 700, fontSize: "1.4rem", mb: 1 }}>{q.title}</Typography>
            <Typography sx={{ fontSize: "1.15rem", color: MUTED, lineHeight: 1.5 }}>{q.body}</Typography>
          </Box>
        ))}
      </Box>
      <Typography sx={{ mt: 6, fontSize: { xs: "1.15rem", md: "1.25rem" }, color: MUTED, maxWidth: 760 }}>
        También puede llevar lotes, labores, inventario, ventas y gastos desde el computador.
      </Typography>
    </Section>
  );
}

/* ------------------------------------------------- 7. field and office -- */

function FieldAndOffice() {
  const blocks = [
    { icon: <PhoneAndroidIcon sx={{ fontSize: 40 }} />, title: "En el celular", body: "Abra Báscula en el navegador y registre las pesadas donde recibe el café. Puede registrar kilos sin señal: se guardan en el celular y se suben solas cuando vuelve la conexión." },
    { icon: <ComputerIcon sx={{ fontSize: 40 }} />, title: "En el computador", body: "Abra la misma dirección para consultar la información de la finca, revisar el trabajo registrado y llevar las cuentas de los trabajadores." },
    { icon: <AddToHomeScreenIcon sx={{ fontSize: 40 }} />, title: "Nada que instalar", body: "Es una aplicación web. Si quiere, agréguela a la pantalla de inicio del celular y ábrala como cualquier aplicación." },
  ];
  return (
    <Section>
      <Stack direction={{ xs: "column", md: "row" }} spacing={{ xs: 5, md: 8 }} alignItems="center">
        <Box sx={{ flex: 1.2 }}>
          <SectionTitle>Registre en el campo. Revise las cuentas de la finca.</SectionTitle>
          <Stack spacing={3} sx={{ mt: 4 }}>
            {blocks.map((b) => (
              <Stack key={b.title} direction="row" spacing={2.5} alignItems="flex-start">
                <Box sx={{ color: GREEN, flexShrink: 0, mt: 0.5 }}>{b.icon}</Box>
                <Box>
                  <Typography component="h3" sx={{ fontWeight: 700, fontSize: "1.35rem", mb: 0.5 }}>{b.title}</Typography>
                  <Typography sx={{ fontSize: "1.15rem", color: MUTED, lineHeight: 1.5 }}>{b.body}</Typography>
                </Box>
              </Stack>
            ))}
          </Stack>
          <Stack direction="row" spacing={1.5} alignItems="flex-start" sx={{ mt: 4, p: 2.5, borderRadius: 3, bgcolor: "#fff8e1", border: "1px solid #f0d58a" }}>
            <InfoOutlinedIcon sx={{ color: "#8a6100", mt: 0.25 }} />
            <Typography sx={{ fontSize: "1.1rem", color: INK, lineHeight: 1.5 }}>
              Puede registrar kilos sin señal. Para ver informes, pagar y liquidar necesita conexión y las pesadas ya subidas.
            </Typography>
          </Stack>
        </Box>
        <Box component="img" src="/landing/branch.jpg" alt="Café cereza en la rama" loading="lazy" sx={{ flex: 0.8, width: "100%", maxWidth: { xs: "100%", md: 440 }, height: { xs: 260, md: 440 }, objectFit: "cover", borderRadius: 4 }} />
      </Stack>
    </Section>
  );
}

/* --------------------------------------------------------- 8. for whom -- */

function ForWhom() {
  return (
    <Section bg="#f6f7f4">
      <Stack direction={{ xs: "column-reverse", md: "row" }} spacing={{ xs: 5, md: 8 }} alignItems="center">
        <Box component="img" src="/landing/cherries.jpg" alt="Cerezas de café en el árbol" loading="lazy" sx={{ flex: 0.8, width: "100%", maxWidth: { xs: "100%", md: 440 }, height: { xs: 240, md: 420 }, objectFit: "cover", borderRadius: 4 }} />
        <Box sx={{ flex: 1.2 }}>
          <SectionTitle>Pensada para quien lleva la recolección y las cuentas.</SectionTitle>
          <Lead>Conozca Báscula si en su finca:</Lead>
          <Stack component="ul" spacing={2} sx={{ listStyle: "none", p: 0, m: 0, mt: 3 }}>
            {FOR_WHOM.map((item) => (
              <Stack component="li" key={item} direction="row" spacing={1.5} alignItems="flex-start">
                <CheckCircleOutlineIcon sx={{ color: GREEN, fontSize: 30, flexShrink: 0 }} />
                <Typography sx={{ fontSize: { xs: "1.2rem", md: "1.25rem" } }}>{item}</Typography>
              </Stack>
            ))}
          </Stack>
          <Typography sx={{ mt: 4, fontSize: { xs: "1.15rem", md: "1.25rem" }, fontWeight: 600, color: GREEN_DARK }}>
            En la demostración revisamos cómo encaja con su forma de trabajar.
          </Typography>
        </Box>
      </Stack>
    </Section>
  );
}

/* ---------------------------------------------------- 9. demo preview -- */

function DemoPreview() {
  return (
    <Section maxWidth="md">
      <SectionTitle>Vea el proceso antes de decidir.</SectionTitle>
      <Lead>Le mostramos cómo registrar una pesada, calcular una cuenta semanal y consultar el saldo pendiente.</Lead>
      <Stack component="ul" spacing={2} sx={{ listStyle: "none", p: 0, m: 0, mt: 4 }}>
        {DEMO_POINTS.map((item) => (
          <Stack component="li" key={item} direction="row" spacing={1.5} alignItems="flex-start">
            <CheckCircleOutlineIcon sx={{ color: GREEN, fontSize: 30, flexShrink: 0 }} />
            <Typography sx={{ fontSize: { xs: "1.2rem", md: "1.25rem" } }}>{item}</Typography>
          </Stack>
        ))}
      </Stack>
      <Typography sx={{ mt: 4, mb: 4, fontSize: { xs: "1.15rem", md: "1.25rem" }, color: MUTED }}>
        La demostración es gratuita y no lo compromete a contratar.
      </Typography>
      <DemoButton fullWidthOnMobile />
    </Section>
  );
}

/* -------------------------------------------------------------- 10. faq -- */

function Faq() {
  return (
    <Section id="preguntas-frecuentes" bg="#f6f7f4" maxWidth="md">
      <SectionTitle>Preguntas frecuentes</SectionTitle>
      <Box sx={{ mt: 4 }}>
        {FAQ.map((f) => (
          <Accordion key={f.q} disableGutters elevation={0} sx={{ bgcolor: "#fff", border: `1px solid ${LINE}`, borderRadius: "12px !important", mb: 1.5, "&:before": { display: "none" } }}>
            <AccordionSummary expandIcon={<ExpandMoreIcon sx={{ fontSize: 32, color: GREEN_DARK }} />} sx={{ px: { xs: 2, md: 3 }, py: 1, minHeight: 64 }}>
              <Typography component="span" sx={{ fontWeight: 700, fontSize: { xs: "1.15rem", md: "1.25rem" } }}>{f.q}</Typography>
            </AccordionSummary>
            <AccordionDetails sx={{ px: { xs: 2, md: 3 }, pb: 3 }}>
              <Typography sx={{ fontSize: "1.15rem", color: MUTED, lineHeight: 1.55 }}>{f.a}</Typography>
            </AccordionDetails>
          </Accordion>
        ))}
      </Box>
    </Section>
  );
}

/* --------------------------------------------------- 11. closing + form -- */

function Closing(props: { signedIn: boolean; landing: string }) {
  const { signedIn } = props;
  const linkSx = { color: "#fff", fontWeight: 700, textDecoration: "underline" } as const;
  return (
    <Box component="section" id="demo" sx={{ bgcolor: GREEN_DARK, color: CREAM, py: { xs: 7, md: 11 } }}>
      <Container maxWidth="sm">
        <SectionTitle center color={CREAM}>Conozca cómo llevar las cuentas de su cosecha con Báscula.</SectionTitle>
        <Lead center color="rgba(244,241,234,.9)">
          Deje sus datos. Nos pondremos en contacto para acordar el día y la hora de la demostración.
        </Lead>
        <Box sx={{ mt: 5 }}>
          <DemoForm />
        </Box>
        {!signedIn ? (
          <Box sx={{ mt: 5, textAlign: "center" }}>
            <Typography sx={{ fontSize: "1.2rem", mb: 2 }}>¿Prefiere empezar por su cuenta?</Typography>
            <Button
              component={RouterLink}
              to="/empezar"
              variant="outlined"
              size="large"
              sx={{ fontFamily: SANS, fontWeight: 700, minHeight: 60, px: 4, borderRadius: 999, fontSize: "1.15rem", color: CREAM, borderColor: "rgba(244,241,234,.6)", borderWidth: 2, width: { xs: "100%", sm: "auto" }, "&:hover": { borderColor: "#fff", borderWidth: 2, bgcolor: "rgba(255,255,255,.08)" } }}
            >
              Cree su finca gratis
            </Button>
            <Typography sx={{ mt: 4, fontSize: "1.1rem" }}>
              ¿Ya tiene cuenta?{" "}
              <Box component={RouterLink} to="/entrar" sx={linkSx}>Iniciar sesión</Box>
            </Typography>
          </Box>
        ) : null}
      </Container>
    </Box>
  );
}

type Field = "name" | "phone" | "email" | "farm";
type Values = Record<Field, string>;

const EMPTY: Values = { name: "", phone: "", email: "", farm: "" };

const LABELS: Record<Field, string> = {
  name: "Nombre",
  phone: "Teléfono de contacto",
  email: "Correo electrónico",
  farm: "Nombre de la finca",
};

export function validateDemo(v: Values): Partial<Record<Field, string>> {
  const errors: Partial<Record<Field, string>> = {};
  if (!v.name.trim()) errors.name = "Escriba su nombre.";
  if (v.phone.replace(/\D/g, "").length < 7) errors.phone = "Escriba un número de teléfono donde podamos contactarlo.";
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(v.email.trim())) errors.email = "Revise el correo electrónico. Ejemplo: nombre@correo.com.";
  if (!v.farm.trim()) errors.farm = "Escriba el nombre de su finca.";
  return errors;
}

type Outcome = "idle" | "sending" | "sent" | "mailto";

function DemoForm() {
  const [values, setValues] = useState<Values>(EMPTY);
  const [errors, setErrors] = useState<Partial<Record<Field, string>>>({});
  const [outcome, setOutcome] = useState<Outcome>("idle");

  function set(field: Field, value: string) {
    setValues((prev) => ({ ...prev, [field]: value }));
    if (errors[field]) setErrors((prev) => ({ ...prev, [field]: undefined }));
  }

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    const found = validateDemo(values);
    setErrors(found);
    if (Object.keys(found).length > 0) return;
    setOutcome("sending");
    const v = { name: values.name.trim(), phone: values.phone.trim(), email: values.email.trim(), farm: values.farm.trim() };
    const subject = `Demo Báscula — ${v.farm}`;
    try {
      const res = await fetch(`https://formsubmit.co/ajax/${LEAD_EMAIL}`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({ ...v, _subject: subject }),
      });
      if (!res.ok) throw new Error("formsubmit failed");
      setOutcome("sent");
    } catch {
      // Opening the mail app is not a confirmed request: say so, keep the data.
      setOutcome("mailto");
      const body = [`Nombre: ${v.name}`, `Teléfono: ${v.phone}`, `Correo: ${v.email}`, `Finca: ${v.farm}`].join("\n");
      window.location.href = `mailto:${LEAD_EMAIL}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
    }
  }

  if (outcome === "sent") {
    return (
      <Alert severity="success" sx={{ borderRadius: 3, fontSize: "1.2rem", py: 2, alignItems: "center" }}>
        Recibimos su solicitud. Nos pondremos en contacto para acordar la demostración.
      </Alert>
    );
  }

  const busy = outcome === "sending";
  const fieldSx = {
    "& .MuiInputBase-input": { fontSize: "1.2rem", py: 1.75 },
    "& .MuiFormHelperText-root": { fontSize: "1rem", mx: 0 },
  } as const;

  return (
    <Box component="form" onSubmit={onSubmit} noValidate sx={{ bgcolor: "#fff", color: INK, borderRadius: 4, p: { xs: 2.5, sm: 4 }, boxShadow: "0 20px 50px rgba(0,0,0,.25)" }}>
      <Typography sx={{ fontSize: "1.1rem", color: MUTED, mb: 3 }}>Complete los cuatro campos para que podamos contactarlo.</Typography>
      {outcome === "mailto" ? (
        <Stack spacing={1.5} sx={{ mb: 3 }}>
          <Alert severity="error" sx={{ borderRadius: 2, fontSize: "1.05rem" }}>No pudimos enviar su solicitud. Intente de nuevo.</Alert>
          <Alert severity="info" sx={{ borderRadius: 2, fontSize: "1.05rem" }}>
            Se abrirá su aplicación de correo con la solicitud preparada. Envíe el mensaje para solicitar la demostración.
          </Alert>
        </Stack>
      ) : null}
      <Stack spacing={3}>
        {(Object.keys(LABELS) as Field[]).map((field) => (
          <Box key={field}>
            <Typography component="label" htmlFor={`demo-${field}`} sx={{ display: "block", fontWeight: 700, fontSize: "1.15rem", mb: 1 }}>
              {LABELS[field]}
            </Typography>
            <TextField
              id={`demo-${field}`}
              name={field}
              value={values[field]}
              onChange={(e) => set(field, e.target.value)}
              fullWidth
              required
              type={field === "email" ? "email" : field === "phone" ? "tel" : "text"}
              autoComplete={field === "name" ? "name" : field === "phone" ? "tel" : field === "email" ? "email" : "organization"}
              error={Boolean(errors[field])}
              helperText={errors[field]}
              sx={fieldSx}
            />
          </Box>
        ))}
        <Button type="submit" variant="contained" size="large" disabled={busy} sx={{ fontFamily: SANS, fontWeight: 700, minHeight: 64, borderRadius: 999, fontSize: "1.2rem" }}>
          {busy ? "Enviando solicitud…" : DEMO_CTA}
        </Button>
        <Typography sx={{ textAlign: "center", fontSize: "1.05rem", color: MUTED, mt: "12px !important" }}>{DEMO_NOTE}</Typography>
      </Stack>
    </Box>
  );
}

/* ----------------------------------------------------------- 12. footer -- */

function Footer(props: { signedIn: boolean; landing: string }) {
  const { signedIn, landing } = props;
  const linkSx = { color: CREAM, fontSize: "1.05rem", textDecoration: "underline" } as const;
  return (
    <Box component="footer" sx={{ bgcolor: "#0e120e", color: CREAM, py: { xs: 5, md: 6 } }}>
      <Container maxWidth="lg">
        <Stack direction={{ xs: "column", md: "row" }} justifyContent="space-between" spacing={3}>
          <Box>
            <Typography sx={{ fontFamily: DISPLAY, fontWeight: 700, fontSize: 24 }}>Báscula</Typography>
            <Typography sx={{ opacity: 0.8, fontSize: "1.05rem", mt: 0.5 }}>Registro de cosecha y cuentas por recolector.</Typography>
          </Box>
          <Stack direction={{ xs: "column", sm: "row" }} spacing={{ xs: 1.5, sm: 3 }} alignItems={{ sm: "center" }}>
            <Box component={RouterLink} to={signedIn ? landing : "/entrar"} sx={linkSx}>{signedIn ? "Ir a mi finca" : "Iniciar sesión"}</Box>
            <Box component={RouterLink} to="/empezar" sx={linkSx}>Crear mi finca</Box>
          </Stack>
        </Stack>
        <Typography sx={{ mt: 4, fontSize: 13, opacity: 0.5 }}>Fotos: Unsplash — café en cereza.</Typography>
      </Container>
    </Box>
  );
}
