import { useState } from "react";
import {
  Alert, Button, Dialog, DialogActions, DialogContent, DialogTitle, Stack, TextField,
  useMediaQuery, useTheme,
} from "@mui/material";
import { api } from "../../api/endpoints";
import { messageFor } from "../../api/errors";
import { useWriteOnce } from "../../lib/writeOnce";
import { DateField } from "../../components/DateField";
import { isValidDay, todayInFarm } from "../../lib/dates";
import { useAuth } from "../../auth/AuthContext";

/**
 * «Agregar anotación»: a written remark about one worker, `employee_notes`.
 *
 * The API route (`POST /v1/workers/{id}/notes`) has existed since the first
 * sprint; the button on the profile was left disabled with a tooltip, so the
 * owner could see the feature and never use it. This is the other half.
 *
 * Notes are append-only on the server — no PATCH, no DELETE — so the dialog
 * says so before saving instead of after. Same once-only write as the debt
 * dialog: the id is minted per intent, so a double click or a retry after a
 * timeout is the same note, not two.
 *
 * Full screen on a phone: the text box is the whole point of this dialog, and
 * a keyboard plus a centred xs dialog leaves two lines to write in.
 */
export function AddNoteDialog({
  open, workerId, workerName, onClose, onSaved,
}: {
  open: boolean;
  workerId: string;
  workerName?: string;
  onClose: () => void;
  onSaved: () => void;
}) {
  const theme = useTheme();
  const phone = useMediaQuery(theme.breakpoints.down("sm"));
  const { user } = useAuth();
  const today = () => todayInFarm(user?.farm?.timezone ?? "America/Bogota");
  const [text, setText] = useState("");
  const [date, setDate] = useState(today);
  const [error, setError] = useState<string | null>(null);
  const [fieldError, setFieldError] = useState<string | null>(null);
  const { busy, run: runOnce } = useWriteOnce();

  async function save() {
    const body = text.trim();
    if (!body) {
      setFieldError("Escriba la anotación.");
      return;
    }
    setFieldError(null);
    if (date && !isValidDay(date)) {
      setError("Revise la fecha.");
      return;
    }
    const intent = ["anotacion", workerId, date, body].join("|");
    const outcome = await runOnce(intent, async (mint) => {
      setError(null);
      return api.addNote(workerId, body, { id: mint(), date: date || undefined });
    }).catch((err: unknown) => {
      setError(messageFor(err));
      return { ran: false } as const;
    });
    if (!outcome.ran) return;
    setText("");
    setDate(today());
    onSaved();
  }

  return (
    <Dialog
      open={open}
      onClose={busy ? undefined : onClose}
      maxWidth="sm"
      fullWidth
      fullScreen={phone}
    >
      <DialogTitle sx={{ fontSize: "1.5rem" }}>
        Agregar anotación{workerName ? ` · ${workerName}` : ""}
      </DialogTitle>
      <DialogContent>
        <Stack spacing={2.5} sx={{ mt: 1 }}>
          {error && <Alert severity="error">{error}</Alert>}
          <TextField
            label="Anotación"
            value={text}
            onChange={(e) => {
              setText(e.target.value);
              if (fieldError) setFieldError(null);
            }}
            error={!!fieldError}
            helperText={fieldError ?? "Ejemplo: llegó tarde el lunes, pidió permiso para el viernes."}
            multiline
            minRows={4}
            fullWidth
            autoFocus
            disabled={busy}
            sx={{ "& textarea": { fontSize: "1.15rem", lineHeight: 1.5 } }}
          />
          <DateField label="Fecha" value={date} onChange={setDate} />
          <Alert severity="info" variant="outlined" sx={{ fontSize: "1rem" }}>
            Una anotación guardada <strong>no se puede cambiar ni borrar</strong>. Revísela antes
            de guardar. Solo la ven el dueño y los administradores de esta finca.
          </Alert>
        </Stack>
      </DialogContent>
      <DialogActions sx={{ px: 3, pb: 2, gap: 1 }}>
        <Button onClick={onClose} color="inherit" disabled={busy} sx={{ minHeight: 48, fontSize: "1rem" }}>
          Cancelar
        </Button>
        <Button
          onClick={save}
          variant="contained"
          disabled={busy}
          sx={{ minHeight: 48, fontSize: "1rem" }}
        >
          {busy ? "Guardando…" : "Guardar anotación"}
        </Button>
      </DialogActions>
    </Dialog>
  );
}
