/**
 * Public conversion page for coffee-farm administrators.
 * Photos: Unsplash — cherries on the tree and a kilo scale only.
 * Primary CTA: contact form so we can schedule a demo.
 */
import { useState, type FormEvent, createElement as h } from "react";
import { Link as RouterLink } from "react-router-dom";
import {
  Alert,
  Box,
  Button,
  Container,
  Stack,
  TextField,
  Typography,
} from "@mui/material";
import { GREEN, GREEN_DARK } from "../../theme";
import { useAuth } from "../../auth/AuthContext";

const DISPLAY = '"Fraunces", Georgia, serif';
const SANS = '"Outfit", "Roboto", sans-serif';
const LEAD_EMAIL = "oscar3425@gmail.com";

const STEPS = [
  { n: "01", title: "Pida el demo", body: "Deje nombre, teléfono y finca. Le llamamos y le mostramos Báscula con datos reales." },
  { n: "02", title: "Vea su operación", body: "Pesada por lote y día, planilla de empleados y liquidación que cuadra — en el celular." },
  { n: "03", title: "Arranque la cosecha", body: "Si le sirve, dejamos su finca lista. El demo no tiene costo ni compromiso." },
];

const FEATURES = [
  { img: "/landing/cherries.jpg", alt: "Cerezas de café en el árbol", kicker: "Cosecha", title: "Kilos por persona, lote y día", body: "Cada pesada queda con el nombre de quien recogió, el lote y el día. Se acabó el cuaderno que se moja y el Excel del sábado." },
  { img: "/landing/branch.jpg", alt: "Café cereza en la rama", kicker: "Gente", title: "Empleados y planilla, claros", body: "Quién trabajó, cuánto recogió y cuánto se le debe. La administración de la finca en un solo lugar, sin pelear por cifras." },
  { img: "/landing/scale.jpg", alt: "Báscula de kilos", kicker: "Plata", title: "Liquidación que cuadra", body: "El recibo nombra semana, saldo anterior, descuentos y pago. Si no suma, no se imprime. Paz y salvo con firma." },
];

export function LandingPage() {
  const { status, landing } = useAuth();
  const signedIn = status === "authenticated";
  return h(Box, { sx: { minHeight: "100dvh", bgcolor: "#0e120e", color: "#f4f1ea", fontFamily: SANS } },
    h(Hero, { signedIn, landing }), h(Proof, null), h(Features, null), h(How, null), h(DemoBand, { signedIn }), h(Footer, null));
}

function fieldSx(dark: boolean) {
  return {
    "& .MuiOutlinedInput-root": {
      bgcolor: dark ? "rgba(255,255,255,.08)" : "#fff",
      color: dark ? "#f4f1ea" : "#1a1c19",
      borderRadius: 2,
      "& fieldset": { borderColor: dark ? "rgba(255,255,255,.25)" : "#c5cec0" },
      "&:hover fieldset": { borderColor: dark ? "rgba(255,255,255,.45)" : GREEN },
      "&.Mui-focused fieldset": { borderColor: dark ? "#fff" : GREEN },
    },
    "& .MuiInputLabel-root": { color: dark ? "rgba(255,255,255,.75)" : "#43483f" },
    "& .MuiInputLabel-root.Mui-focused": { color: dark ? "#fff" : GREEN_DARK },
    "& .MuiInputBase-input": { fontSize: "1.05rem", py: 1.5 },
  } as const;
}

function DemoForm(props: { dark?: boolean }) {
  const dark = Boolean(props.dark);
  const [name, setName] = useState("");
  const [phone, setPhone] = useState("");
  const [email, setEmail] = useState("");
  const [farm, setFarm] = useState("");
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const [error, setError] = useState(null as string | null);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    const n = name.trim();
    const digits = phone.replace(/\D/g, "");
    const em = email.trim();
    const f = farm.trim();
    if (!n || !(digits.length >= 7) || !em || !f) {
      setError("Complete nombre, teléfono, correo y nombre de la finca.");
      return;
    }
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(em)) {
      setError("Ese correo no parece válido.");
      return;
    }
    setBusy(true);
    const payload = { name: n, phone: phone.trim(), email: em, farm: f, _subject: `Demo Báscula — ${f}` };
    try {
      const res = await fetch(`https://formsubmit.co/ajax/${LEAD_EMAIL}`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify(payload),
      });
      if (!res.ok) throw new Error("formsubmit failed");
      setDone(true);
    } catch {
      const body = [`Nombre: ${n}`, `Teléfono: ${phone.trim()}`, `Correo: ${em}`, `Finca: ${f}`].join("\n");
      window.location.href = `mailto:${LEAD_EMAIL}?subject=${encodeURIComponent(`Demo Báscula — ${f}`)}&body=${encodeURIComponent(body)}`;
      setDone(true);
    } finally {
      setBusy(false);
    }
  }

  if (done) {
    return h(Alert, { severity: "success", sx: { borderRadius: 3, fontSize: "1.05rem", bgcolor: dark ? "rgba(46,125,50,.25)" : undefined, color: dark ? "#e8f5e9" : undefined } },
      "Gracias. Le escribimos o le llamamos para agendar el demo de su finca.");
  }

  return h(Box, {
    component: "form", onSubmit, noValidate: true,
    sx: { bgcolor: dark ? "rgba(8,12,8,.72)" : "#fff", color: dark ? "#f4f1ea" : "#1a1c19", borderRadius: 3, p: { xs: 2.5, md: 3 }, border: dark ? "1px solid rgba(255,255,255,.12)" : "1px solid #dde5da", boxShadow: dark ? "0 20px 50px rgba(0,0,0,.35)" : "0 12px 40px rgba(20,40,20,.08)" },
  },
    h(Typography, { sx: { fontFamily: DISPLAY, fontSize: 22, mb: 0.5, color: dark ? "#f4f1ea" : "#1a1c19" } }, "Pedir demo"),
    h(Typography, { sx: { mb: 2.5, opacity: 0.8, fontSize: 15, color: dark ? "#f4f1ea" : "#43483f" } }, "Deje sus datos. Le mostramos Báscula con la operación de una finca cafetera."),
    error ? h(Alert, { severity: "error", sx: { mb: 2, borderRadius: 2 } }, error) : null,
    h(Stack, { spacing: 2 },
      h(TextField, { label: "Nombre", value: name, onChange: (e: { target: { value: string } }) => setName(e.target.value), fullWidth: true, required: true, autoComplete: "name", sx: fieldSx(dark) }),
      h(TextField, { label: "Teléfono", value: phone, onChange: (e: { target: { value: string } }) => setPhone(e.target.value), fullWidth: true, required: true, autoComplete: "tel", inputMode: "tel" as const, sx: fieldSx(dark) }),
      h(TextField, { label: "Correo", type: "email", value: email, onChange: (e: { target: { value: string } }) => setEmail(e.target.value), fullWidth: true, required: true, autoComplete: "email", sx: fieldSx(dark) }),
      h(TextField, { label: "Nombre de la finca", value: farm, onChange: (e: { target: { value: string } }) => setFarm(e.target.value), fullWidth: true, required: true, sx: fieldSx(dark) }),
      h(Button, { type: "submit", variant: "contained", size: "large", disabled: busy, sx: { fontFamily: SANS, fontWeight: 700, minHeight: 56, borderRadius: 999, bgcolor: dark ? "#f4f1ea" : GREEN, color: dark ? GREEN_DARK : "#fff", fontSize: "1.05rem", "&:hover": { bgcolor: dark ? "#fff" : GREEN_DARK } } }, busy ? "Enviando…" : "Pedir demo"),
    ),
  );
}

function Hero(props: { signedIn: boolean; landing: string }) {
  const { signedIn, landing } = props;
  return h(Box, { sx: { position: "relative", minHeight: { xs: "auto", md: "100dvh" }, overflow: "hidden" } },
    h(Box, { component: "img", src: "/landing/cherries.jpg", alt: "", sx: { position: "absolute", inset: 0, width: "100%", height: "100%", objectFit: "cover", objectPosition: "center" } }),
    h(Box, { sx: { position: "absolute", inset: 0, background: "linear-gradient(105deg, rgba(8,12,8,.88) 0%, rgba(8,12,8,.72) 48%, rgba(8,12,8,.55) 100%)" } }),
    h(Container, { maxWidth: "lg", sx: { position: "relative", zIndex: 1, pt: 3, pb: { xs: 5, md: 8 }, minHeight: { md: "100dvh" }, display: "flex", flexDirection: "column" } },
      h(Stack, { direction: "row", justifyContent: "space-between", alignItems: "center", sx: { mb: { xs: 4, md: 6 } } },
        h(Typography, { sx: { fontFamily: DISPLAY, fontWeight: 700, fontSize: 22, letterSpacing: "-0.03em" } }, "Báscula"),
        h(Button, { component: RouterLink, to: signedIn ? landing : "/entrar", variant: "outlined", sx: { color: "#fff", borderColor: "rgba(255,255,255,.45)", borderRadius: 999, "&:hover": { borderColor: "#fff", bgcolor: "rgba(255,255,255,.08)" } } }, signedIn ? "Ir a mi finca" : "Entrar"),
      ),
      h(Stack, { direction: { xs: "column", md: "row" }, spacing: { xs: 4, md: 6 }, alignItems: { md: "center" }, sx: { flex: 1 } },
        h(Box, { sx: { flex: 1.1, maxWidth: 560 } },
          h(Typography, { sx: { letterSpacing: "0.16em", textTransform: "uppercase", fontSize: 12, fontWeight: 600, opacity: 0.9, mb: 2 } }, "Administración de fincas cafeteras"),
          h(Typography, { component: "h1", sx: { fontFamily: DISPLAY, fontWeight: 700, fontSize: { xs: "2.35rem", sm: "3.1rem", md: "3.6rem" }, lineHeight: 1.08, letterSpacing: "-0.03em", mb: 2 } }, "La cosecha, los kilos y la liquidación, en orden."),
          h(Typography, { sx: { fontSize: { xs: "1.1rem", md: "1.25rem" }, opacity: 0.92, mb: 2, lineHeight: 1.45 } }, "Báscula es el sistema para dueños y administradores de finca: pesada por lote y día, planilla de empleados y recibo que cuadra."),
          h(Typography, { sx: { opacity: 0.75, fontSize: 15 } }, "Café en cereza. Báscula de kilos. Sin cuaderno mojado."),
        ),
        h(Box, { sx: { flex: 0.95, width: "100%", maxWidth: 420 } },
          signedIn
            ? h(Button, { component: RouterLink, to: landing, variant: "contained", size: "large", fullWidth: true, sx: { fontWeight: 700, minHeight: 56, borderRadius: 999, bgcolor: "#f4f1ea", color: GREEN_DARK, "&:hover": { bgcolor: "#fff" } } }, "Ir a mi finca")
            : h(DemoForm, { dark: true }),
        ),
      ),
    ),
  );
}

function Proof() {
  const items = [
    { k: "Administración", v: "Cosecha, gente y plata juntas" },
    { k: "La romana", v: "Kilos por persona, lote y día" },
    { k: "El recibo", v: "Liquidación que sí cuadra" },
  ];
  return h(Box, { sx: { bgcolor: "#141914", py: { xs: 4, md: 5 }, borderBottom: "1px solid rgba(255,255,255,.06)" } },
    h(Container, { maxWidth: "lg" },
      h(Stack, { direction: { xs: "column", md: "row" }, spacing: { xs: 3, md: 0 }, justifyContent: "space-between" },
        ...items.map((it) => h(Box, { key: it.k, sx: { flex: 1, px: { md: 3 }, "&:first-of-type": { pl: 0 } } },
          h(Typography, { sx: { fontFamily: DISPLAY, fontSize: 22, mb: 0.5 } }, it.k),
          h(Typography, { sx: { opacity: 0.65 } }, it.v),
        )),
      ),
    ),
  );
}

function Features() {
  return h(Box, { sx: { bgcolor: "#f4f1ea", color: "#1a1c19", py: { xs: 8, md: 12 } } },
    h(Container, { maxWidth: "lg" },
      h(Typography, { sx: { fontFamily: DISPLAY, fontSize: { xs: 32, md: 44 }, letterSpacing: "-0.03em", mb: 6, maxWidth: 680 } }, "Hecha para administrar la finca cafetera, no para vender software."),
      h(Stack, { spacing: { xs: 8, md: 12 } },
        ...FEATURES.map((f, i) => h(Stack, { key: f.title, direction: { xs: "column", md: i % 2 ? "row-reverse" : "row" }, spacing: { xs: 3, md: 8 }, alignItems: "center" },
          h(Box, { component: "img", src: f.img, alt: f.alt, sx: { width: { xs: "100%", md: "52%" }, height: { xs: 240, md: 380 }, objectFit: "cover", borderRadius: 3 } }),
          h(Box, { sx: { flex: 1 } },
            h(Typography, { sx: { letterSpacing: "0.14em", textTransform: "uppercase", fontSize: 12, fontWeight: 700, color: GREEN_DARK, mb: 1 } }, f.kicker),
            h(Typography, { sx: { fontFamily: DISPLAY, fontSize: { xs: 28, md: 34 }, lineHeight: 1.15, mb: 2 } }, f.title),
            h(Typography, { sx: { fontSize: "1.125rem", color: "#43483f", lineHeight: 1.55 } }, f.body),
          ),
        )),
      ),
    ),
  );
}

function How() {
  return h(Box, { sx: { position: "relative", py: { xs: 8, md: 12 }, color: "#f4f1ea", overflow: "hidden" } },
    h(Box, { component: "img", src: "/landing/hero.jpg", alt: "", sx: { position: "absolute", inset: 0, width: "100%", height: "100%", objectFit: "cover", opacity: 0.22 } }),
    h(Box, { sx: { position: "absolute", inset: 0, bgcolor: "rgba(10,14,10,.78)" } }),
    h(Container, { maxWidth: "lg", sx: { position: "relative" } },
      h(Typography, { sx: { fontFamily: DISPLAY, fontSize: { xs: 32, md: 40 }, mb: 6 } }, "Tres pasos hasta el demo."),
      h(Stack, { direction: { xs: "column", md: "row" }, spacing: 4 },
        ...STEPS.map((s) => h(Box, { key: s.n, sx: { flex: 1 } },
          h(Typography, { sx: { fontFamily: DISPLAY, fontSize: 40, opacity: 0.35, lineHeight: 1 } }, s.n),
          h(Typography, { sx: { fontWeight: 700, fontSize: 20, mt: 1, mb: 1 } }, s.title),
          h(Typography, { sx: { opacity: 0.8 } }, s.body),
        )),
      ),
    ),
  );
}

function DemoBand(props: { signedIn: boolean }) {
  const { signedIn } = props;
  return h(Box, { sx: { bgcolor: GREEN_DARK, py: { xs: 8, md: 10 } } },
    h(Container, { maxWidth: "md" },
      h(Typography, { sx: { fontFamily: DISPLAY, fontSize: { xs: 32, md: 44 }, letterSpacing: "-0.03em", mb: 1.5, textAlign: "center", color: "#f4f1ea" } }, "Vea Báscula en su finca."),
      h(Typography, { sx: { textAlign: "center", opacity: 0.9, mb: 4, fontSize: "1.15rem", color: "#f4f1ea" } }, "Deje sus datos y agendamos una demostración. Sin compromiso."),
      !signedIn ? h(Box, { sx: { maxWidth: 420, mx: "auto" } }, h(DemoForm, null)) : null,
      !signedIn ? h(Typography, { sx: { textAlign: "center", mt: 3, opacity: 0.7, fontSize: 14, color: "#f4f1ea" } },
        "¿Ya tiene cuenta? ",
        h(Box, { component: RouterLink, to: "/entrar", sx: { color: "#fff", fontWeight: 600 } }, "Entrar"),
        " · ",
        h(Box, { component: RouterLink, to: "/empezar", sx: { color: "#fff", fontWeight: 600 } }, "Crear mi finca"),
      ) : null,
    ),
  );
}

function Footer() {
  return h(Box, { sx: { bgcolor: "#0e120e", py: 3, borderTop: "1px solid rgba(255,255,255,.06)" } },
    h(Container, { maxWidth: "lg" },
      h(Stack, { direction: { xs: "column", sm: "row" }, justifyContent: "space-between", spacing: 1 },
        h(Typography, { sx: { fontFamily: DISPLAY, opacity: 0.7 } }, "Báscula"),
        h(Typography, { sx: { fontSize: 12, opacity: 0.4 } }, "Fotos: Unsplash — café en cereza y báscula. Uso libre."),
      ),
    ),
  );
}
