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
 * It comes down the day sync reaches production. Delete this component then;
 * do not make it dismissible in the meantime.
 */
import { Alert, AlertTitle, Box, Typography } from "@mui/material";
import SyncProblemIcon from "@mui/icons-material/SyncProblem";

export function SyncWarningBanner() {
  return (
    <Alert
      severity="warning"
      icon={<SyncProblemIcon />}
      variant="outlined"
      role="status"
      sx={{
        borderRadius: 0,
        borderInline: 0,
        borderTop: 0,
        bgcolor: "#fff8e6",
        alignItems: "flex-start",
        "& .MuiAlert-message": { py: 0.5 },
      }}
    >
      <AlertTitle sx={{ fontWeight: 700, mb: 0.25 }}>
        El teléfono y esta web todavía llevan cuentas separadas
      </AlertTitle>
      <Typography variant="body2" component="div">
        Mientras no exista la sincronización, una labor registrada aquí{" "}
        <Box component="strong">no existe para el teléfono</Box>, y al revés.
        Pagarle a la misma persona desde los dos lados en la misma semana{" "}
        <Box component="strong">le paga dos veces</Box>.{" "}
        Durante la transición, pague siempre desde un solo lado.
      </Typography>
    </Alert>
  );
}
