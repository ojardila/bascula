import {
  Button, Dialog, DialogActions, DialogContent, DialogContentText, DialogTitle,
} from "@mui/material";

interface Props {
  open: boolean;
  title: string;
  body: string;
  confirmLabel?: string;
  destructive?: boolean;
  busy?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}

/**
 * The confirmation in front of every logical removal.
 *
 * It says "queda inactiva" and not "se elimina", because that is what happens:
 * nothing is ever deleted (casos-de-uso.md). Telling the user otherwise makes
 * them hesitate over a reversible action and, worse, trains them to believe
 * data disappears when it does not.
 */
export function ConfirmDialog({
  open, title, body, confirmLabel = "Confirmar", destructive, busy, onConfirm, onCancel,
}: Props) {
  return (
    <Dialog open={open} onClose={busy ? undefined : onCancel} maxWidth="xs" fullWidth>
      <DialogTitle>{title}</DialogTitle>
      <DialogContent>
        <DialogContentText>{body}</DialogContentText>
      </DialogContent>
      <DialogActions sx={{ px: 3, pb: 2 }}>
        <Button onClick={onCancel} disabled={busy} color="inherit">
          Cancelar
        </Button>
        <Button
          onClick={onConfirm}
          disabled={busy}
          variant="contained"
          color={destructive ? "error" : "primary"}
        >
          {confirmLabel}
        </Button>
      </DialogActions>
    </Dialog>
  );
}
