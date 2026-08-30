/**
 * The notice that keeps somebody from being paid twice.
 *
 * Decision 3 in `docs/decisiones.md`: the web registers work from Sprint 1,
 * before sync exists. Until sync ships, a labor registered here does not exist
 * for the phone and vice versa, and the anti-double-pay lock lives in each
 * database separately. Paying the same person from both sides in one week pays
 * them twice — with real money, to a picker who will not be the one who
 * notices.
 *
 * So this is not a decoration and it is not dismissible. It sits above the
 * content on every authenticated screen, and it says the mitigation ("pague
 * desde un solo lado") rather than just the fact, because a warning a person
 * cannot act on is a warning they learn to scroll past.
 *
 * ── POR QUÉ AHORA CABE EN UNA LÍNEA ──────────────────────────────────────
 *
 * Porque medía cuatro. Este aviso y el de datos simulados se comían 520 de
 * los primeros 844 píxeles de un celular, EN TODAS LAS PÁGINAS: quien abría la
 * consola desde el teléfono veía dos cajas de texto y tenía que desplazarse
 * para llegar al título de la pantalla que pidió. Un aviso permanente que tapa
 * el contenido no se lee más; se aprende a saltar, y entonces deja de avisar
 * el día que importa.
 *
 * Así que lo que queda arriba es LA INSTRUCCIÓN —«pague desde un solo lado»—
 * en una línea, y el porqué se despliega. Nada se ha quitado: la explicación
 * entera sigue estando, a un toque, y el aviso sigue sin poderse cerrar.
 * Responder primero y explicar después.
 *
 * It comes down the day sync reaches production. Delete this component then;
 * do not make it dismissible in the meantime.
 */
import { useState } from "react";
import { Alert, Box, Button, Collapse, Typography } from "@mui/material";
import SyncProblemIcon from "@mui/icons-material/SyncProblem";

export function SyncWarningBanner() {
  const [open, setOpen] = useState(false);

  return (
    <Alert
      severity="warning"
      icon={<SyncProblemIcon fontSize="small" />}
      variant="outlined"
      role="status"
      sx={{
        borderRadius: 0,
        borderInline: 0,
        borderTop: 0,
        bgcolor: "#fff8e6",
        py: 0.25,
        "& .MuiAlert-message": { py: 0.5, width: "100%" },
        "& .MuiAlert-icon": { py: 0.75 },
      }}
      action={
        <Button
          color="inherit"
          size="small"
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
        >
          {open ? "Ocultar" : "Por qué"}
        </Button>
      }
    >
      <Typography variant="body2" component="div">
        <Box component="strong">Pague siempre desde un solo lado</Box> — el teléfono y
        esta web todavía llevan cuentas separadas.
      </Typography>
      <Collapse in={open}>
        <Typography variant="body2" component="div" sx={{ mt: 1, pb: 0.5, maxWidth: 760 }}>
          Mientras no exista la sincronización, una labor registrada aquí{" "}
          <Box component="strong">no existe para el teléfono</Box>, y al revés. El seguro
          que impide pagar dos veces vive en cada base de datos por separado, así que
          pagarle a la misma persona desde los dos lados en la misma semana{" "}
          <Box component="strong">le paga dos veces</Box>, con plata de verdad y sin que
          nada avise.
        </Typography>
      </Collapse>
    </Alert>
  );
}
