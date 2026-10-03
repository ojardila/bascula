// SPDX-License-Identifier: MIT
/**
 * «Corregir»: change or take out the pesadas one person already has on the
 * day, from the bulk registration. The main screen only ever ADDS; this is
 * where a wrong number is fixed, on any day of a week that is not settled.
 *
 * One big box per pesada, filled with what is registered. «Quitar» marks it to
 * be taken out (and «Dejar» undoes that). Nothing is written until «Guardar
 * cambios».
 */
import { useState } from "react";
import {
  Alert,
  Box,
  Button,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  Stack,
  TextField,
  Typography,
} from "@mui/material";
import { api } from "../../api/endpoints";
import { messageFor } from "../../api/errors";
import type { WorkRecord } from "../../api/types";
import { formatQuantity } from "../../lib/money";
import { plannedCorrections } from "./bulk";
import { formatKg } from "./planilla";

export function CorregirPesadasDialog({
  open,
  name,
  dayLabel,
  records,
  onClose,
  onSaved,
}: Readonly<{
  open: boolean;
  name: string;
  dayLabel: string;
  records: WorkRecord[];
  onClose: () => void;
  /** Called with how many pesadas changed, after they were written. */
  onSaved: (changed: number) => void;
}>) {
  // Mounted afresh for each person (see the page), so it starts from what is
  // registered now.
  const [texts, setTexts] = useState<Record<string, string>>(() =>
    Object.fromEntries(records.map((r) => [r.id, formatKg(r.quantity)])),
  );
  const [removed, setRemoved] = useState<Record<string, boolean>>({});
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const { corrections, errors } = plannedCorrections(records, texts, removed);

  async function save() {
    if (errors.length) {
      setError(errors[0]);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      for (const c of corrections) {
        if (c.kind === "update")
          await api.updateWorkRecord(c.recordId, { quantity: c.quantity });
        else await api.deactivateWorkRecord(c.recordId);
      }
      onSaved(corrections.length);
    } catch (e) {
      setError(messageFor(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog
      open={open}
      onClose={busy ? undefined : onClose}
      maxWidth="xs"
      fullWidth
    >
      <DialogTitle sx={{ fontSize: "1.4rem", pb: 0.5 }}>
        Corregir pesadas
      </DialogTitle>
      <DialogContent>
        <Typography sx={{ fontSize: "1.1rem", mb: 2 }}>
          <strong>{name}</strong> · {dayLabel}
        </Typography>
        <Stack spacing={1.5}>
          {records.map((r, i) => {
            const out = !!removed[r.id];
            return (
              <Box key={r.id}>
                <Typography sx={{ fontSize: "1.05rem", mb: 0.5 }}>
                  <strong>Pesada {i + 1}</strong>
                  {r.plotNames.length > 0 && <> · {r.plotNames.join(", ")}</>}
                </Typography>
                <Stack
                  direction="row"
                  spacing={1.5}
                  sx={{
                    alignItems: "center",
                  }}
                >
                  {out ? (
                    <Typography
                      sx={{
                        flex: 1,
                        fontSize: "1.05rem",
                        color: "error.main",
                        py: 1.5,
                      }}
                    >
                      Se quita · era {formatQuantity(r.quantity)} kg
                    </Typography>
                  ) : (
                    <TextField
                      value={texts[r.id] ?? ""}
                      onChange={(e) => {
                        const v = e.target.value;
                        setTexts((prev) => ({ ...prev, [r.id]: v }));
                        setError(null);
                      }}
                      disabled={busy}
                      sx={{
                        flex: 1,
                        "& input": {
                          textAlign: "right",
                          fontSize: 26,
                          fontWeight: 600,
                          py: 1.5,
                        },
                      }}
                      slotProps={{
                        input: {
                          endAdornment: (
                            <Typography
                              sx={{ ml: 0.5, color: "text.secondary" }}
                            >
                              kg
                            </Typography>
                          ),
                        },
                        htmlInput: {
                          inputMode: "decimal",
                          "aria-label": `Pesada ${i + 1}, kilos`,
                        },
                      }}
                    />
                  )}
                  <Button
                    variant="outlined"
                    onClick={() =>
                      setRemoved((prev) => ({ ...prev, [r.id]: !out }))
                    }
                    disabled={busy}
                    color={out ? "primary" : "error"}
                    aria-label={
                      out
                        ? `Dejar la pesada ${i + 1}`
                        : `Quitar la pesada ${i + 1}`
                    }
                    sx={{
                      minWidth: 92,
                      minHeight: 56,
                      fontSize: "1.05rem",
                      flexShrink: 0,
                    }}
                  >
                    {out ? "Dejar" : "Quitar"}
                  </Button>
                </Stack>
              </Box>
            );
          })}
        </Stack>
        {error && (
          <Alert severity="error" sx={{ mt: 2, fontSize: "1.05rem" }}>
            {error}
          </Alert>
        )}
      </DialogContent>
      <DialogActions sx={{ p: 2, gap: 1 }}>
        <Button onClick={onClose} size="large" disabled={busy}>
          Cancelar
        </Button>
        <Button
          onClick={() => void save()}
          variant="contained"
          size="large"
          disabled={busy || corrections.length === 0}
          sx={{ minHeight: 48, px: 3 }}
        >
          Guardar cambios
        </Button>
      </DialogActions>
    </Dialog>
  );
}
