/**
 * RSP-025: "al guardar, el sistema imprime los stickers de identificación".
 *
 * The server generates the batch and gives it an id; the paper is this
 * dialog's problem. Doing it the other way round — printing from inside the
 * request — would make receiving a truckload of coffee fail because a printer
 * was out of paper, which is the wrong thing to couple to the wrong thing.
 *
 * `window.print()` and a print stylesheet, rather than a PDF library: the
 * labels are eight rectangles with text in them, and a browser already knows
 * how to put those on paper at the size the paper is. Nothing is fetched, so
 * nothing here cares about the no-external-hosts policy either.
 */
import {
  Box, Button, Dialog, DialogActions, DialogContent, DialogTitle, Typography,
} from "@mui/material";
import PrintIcon from "@mui/icons-material/Print";
import { formatQuantity } from "../../lib/money";
import { formatDate } from "../../lib/dates";
import type { LabelBatch } from "../../api/types";

export function LabelSheetDialog({
  batch, onClose,
}: {
  batch: LabelBatch | null;
  onClose: () => void;
}) {
  return (
    <Dialog open={!!batch} onClose={onClose} maxWidth="md" fullWidth>
      <DialogTitle className="no-print">
        Stickers de esa entrada ({batch?.count ?? 0})
      </DialogTitle>
      <DialogContent>
        <Typography variant="body2" color="text.secondary" className="no-print" sx={{ mb: 2 }}>
          La cantidad se reparte entre los stickers; el sobrante va en el último, así que
          la suma de lo impreso es exactamente lo que entró.
        </Typography>
        {/* The print rules live with the thing they print. A stylesheet in
            index.html would be a rule about a component nobody reading the
            component can see. */}
        <style>{`
          @media print {
            body * { visibility: hidden; }
            #hoja-stickers, #hoja-stickers * { visibility: visible; }
            #hoja-stickers { position: absolute; left: 0; top: 0; width: 100%; }
            .no-print { display: none !important; }
          }
        `}</style>
        <Box
          id="hoja-stickers"
          sx={{
            display: "grid",
            gridTemplateColumns: { xs: "1fr", sm: "1fr 1fr" },
            gap: 1.5,
          }}
        >
          {(batch?.labels ?? []).map((l) => (
            <Box
              key={l.code}
              sx={{
                border: "1px dashed", borderColor: "text.disabled", borderRadius: 1,
                p: 1.5, breakInside: "avoid",
              }}
            >
              <Typography sx={{ fontWeight: 700, fontSize: 18 }}>{l.productName}</Typography>
              <Typography sx={{ fontSize: 22, fontWeight: 700 }}>
                {formatQuantity(l.qty)} {l.storageUnit}
              </Typography>
              <Typography variant="body2" color="text.secondary">
                {l.warehouseName}
                {l.plotName ? ` · ${l.plotName}` : ""}
              </Typography>
              <Typography variant="body2" color="text.secondary">
                {formatDate(l.date)}
              </Typography>
              <Typography
                sx={{ fontFamily: "monospace", fontSize: 13, mt: 0.5, letterSpacing: 1 }}
              >
                {l.code}
              </Typography>
            </Box>
          ))}
        </Box>
      </DialogContent>
      <DialogActions className="no-print" sx={{ px: 3, pb: 2 }}>
        <Button color="inherit" onClick={onClose}>
          Cerrar
        </Button>
        <Button variant="contained" startIcon={<PrintIcon />} onClick={() => window.print()}>
          Imprimir
        </Button>
      </DialogActions>
    </Dialog>
  );
}
