/**
 * "Historial financiero" on the worker's page: every payment, settlement,
 * advance and discount, newest first. A tap opens the receipt as it stood
 * that day. Large rows, because this is read on a phone in the field.
 */
import { useNavigate } from "react-router-dom";
import { Box, Chip, List, ListItemButton, ListItem, Stack, Typography } from "@mui/material";
import ChevronRightIcon from "@mui/icons-material/ChevronRight";
import { formatDate } from "../../lib/dates";
import { formatMoney } from "../../lib/money";
import type { LedgerEntry } from "../../api/types";
import { historyRows, type HistoryRow } from "./history";

const CHIP_COLOR: Record<string, "success" | "primary" | "warning" | "default"> = {
  Pago: "primary",
  Liquidación: "success",
  Anticipo: "warning",
  Descuento: "default",
  Ajuste: "default",
};

function RowBody({ r }: { r: HistoryRow }) {
  return (
    <Stack direction="row" alignItems="center" spacing={1.5} sx={{ width: "100%" }}>
      <Box sx={{ flex: 1, minWidth: 0 }}>
        <Stack direction="row" spacing={1} alignItems="center" flexWrap="wrap" useFlexGap>
          <Chip label={r.label} color={CHIP_COLOR[r.label] ?? "default"} sx={{ fontSize: 15, fontWeight: 700 }} />
          {r.voided && <Chip label="Anulado" color="error" variant="outlined" sx={{ fontSize: 15 }} />}
          <Typography sx={{ fontSize: 17 }} color="text.secondary">
            {formatDate(r.date)}
          </Typography>
        </Stack>
        <Typography
          sx={{ fontSize: 17, mt: 0.5, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}
        >
          {r.concept}
        </Typography>
      </Box>
      <Typography
        sx={{
          fontSize: 19,
          fontWeight: 800,
          whiteSpace: "nowrap",
          textDecoration: r.voided ? "line-through" : "none",
          color: r.amountCents < 0 ? "text.primary" : "success.dark",
        }}
      >
        {formatMoney(Math.abs(r.amountCents))}
      </Typography>
      {r.target && <ChevronRightIcon color="action" />}
    </Stack>
  );
}

export function WorkerHistory({ workerId, ledger }: { workerId: string; ledger: LedgerEntry[] }) {
  const navigate = useNavigate();
  const rows = historyRows(ledger);
  if (rows.length === 0) {
    return (
      <Typography sx={{ fontSize: 17 }} color="text.secondary">
        Todavía no se le ha pagado, liquidado ni descontado nada.
      </Typography>
    );
  }
  return (
    <List disablePadding data-testid="worker-history">
      {rows.map((r) =>
        r.target ? (
          <ListItemButton
            key={r.id}
            divider
            sx={{ py: 1.5, px: 1 }}
            onClick={() => navigate(`/empleados/${workerId}/historial/${r.target!.kind}/${r.target!.entryId}`)}
            aria-label={`Ver ${r.label.toLowerCase()} del ${formatDate(r.date)}`}
          >
            <RowBody r={r} />
          </ListItemButton>
        ) : (
          <ListItem key={r.id} divider sx={{ py: 1.5, px: 1 }}>
            <RowBody r={r} />
          </ListItem>
        ),
      )}
    </List>
  );
}
