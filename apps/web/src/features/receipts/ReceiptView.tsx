/**
 * The receipt on the page. Same `ReceiptDoc` as the PDF, laid out for a
 * phone first: on a narrow screen every line of work is a card with the week,
 * the labor and the lote in words and the value in large type; on a computer
 * it is the table the paper has. Text is large on purpose — the people who
 * read this are checking their week's pay, many of them without glasses.
 */
import {
  Alert, Box, Card, CardContent, Divider, Stack, Table, TableBody, TableCell,
  TableFooter, TableHead, TableRow, Typography,
} from "@mui/material";
import { formatDate } from "../../lib/dates";
import { formatMoney } from "../../lib/money";
import type { ReceiptDoc } from "./receiptDoc";

const money = (c: number) => formatMoney(c);

export function ReceiptView({ doc }: { doc: ReceiptDoc }) {
  return (
    <Card variant="outlined" sx={{ borderRadius: 2 }} data-testid="receipt-view">
      <CardContent sx={{ p: { xs: 2, sm: 3 } }}>
        <Stack direction="row" justifyContent="space-between" alignItems="flex-start" spacing={2}>
          <Box>
            <Typography sx={{ fontSize: 22, fontWeight: 800, color: "primary.dark" }}>
              {doc.farmName}
            </Typography>
            <Typography sx={{ fontSize: 18 }} color="text.secondary">
              {doc.title}
            </Typography>
          </Box>
          <Typography sx={{ fontSize: 18, whiteSpace: "nowrap" }} color="text.secondary">
            {formatDate(doc.date)}
          </Typography>
        </Stack>
        <Divider sx={{ my: 2, borderColor: "primary.main", borderBottomWidth: 2 }} />

        {doc.voided && (
          <Alert severity="error" sx={{ mb: 2, fontSize: 17 }}>
            <strong>{doc.voided.title}.</strong> {doc.voided.text}
          </Alert>
        )}

        <Typography sx={{ fontSize: 20, fontWeight: 800 }}>
          {doc.kind === "liquidacion" ? "Liquidación" : "Recibo"} N.º {doc.number}
        </Typography>
        <Typography sx={{ fontSize: 20, fontWeight: 700, mt: 0.5 }}>{doc.workerName}</Typography>
        {(doc.workerDocument || doc.period) && (
          <Typography sx={{ fontSize: 17 }} color="text.secondary">
            {[doc.workerDocument ? `Documento ${doc.workerDocument}` : null,
              doc.period ? `Periodo ${doc.period}` : null].filter(Boolean).join(" · ")}
          </Typography>
        )}

        {doc.lines.length > 0 && (
          <Box sx={{ mt: 3 }}>
            <Typography sx={{ fontSize: 19, fontWeight: 700, mb: 1 }}>Labores</Typography>

            {/* Phone: one card per week + labor + lote. */}
            <Stack spacing={1.25} sx={{ display: { xs: "flex", md: "none" } }}>
              {doc.lines.map((l) => (
                <Box
                  key={l.key}
                  data-testid="receipt-line"
                  sx={{ border: 1, borderColor: "divider", borderRadius: 1.5, p: 1.5 }}
                >
                  <Typography sx={{ fontSize: 16 }} color="text.secondary">
                    Semana {l.weekLabel}
                  </Typography>
                  <Typography sx={{ fontSize: 19, fontWeight: 700 }}>
                    {l.activityName}
                    {l.provisional ? " (provisional)" : ""}
                  </Typography>
                  <Typography sx={{ fontSize: 18 }}>Lote: {l.plotLabel}</Typography>
                  <Stack direction="row" justifyContent="space-between" alignItems="baseline" sx={{ mt: 0.5 }}>
                    <Typography sx={{ fontSize: 17 }}>
                      {l.quantityLabel} × {money(l.rateCents)}
                    </Typography>
                    <Typography sx={{ fontSize: 20, fontWeight: 800 }}>{money(l.amountCents)}</Typography>
                  </Stack>
                </Box>
              ))}
              <Stack direction="row" justifyContent="space-between" sx={{ px: 1.5, pt: 0.5 }}>
                <Typography sx={{ fontSize: 18, fontWeight: 700 }}>Total labores</Typography>
                <Typography sx={{ fontSize: 20, fontWeight: 800, color: "primary.dark" }}>
                  {money(doc.linesTotalCents)}
                </Typography>
              </Stack>
            </Stack>

            {/* Computer: the table the paper has. */}
            <Table size="small" sx={{ display: { xs: "none", md: "table" }, "& td, & th": { fontSize: 16 } }}>
              <TableHead>
                <TableRow sx={{ "& th": { bgcolor: "primary.main", color: "#fff", fontWeight: 700 } }}>
                  <TableCell>Semana</TableCell>
                  <TableCell>Labor</TableCell>
                  <TableCell>Lote</TableCell>
                  <TableCell align="right">Cantidad</TableCell>
                  <TableCell align="right">Precio</TableCell>
                  <TableCell align="right">Valor</TableCell>
                </TableRow>
              </TableHead>
              <TableBody>
                {doc.lines.map((l) => (
                  <TableRow key={l.key}>
                    <TableCell sx={{ whiteSpace: "nowrap" }}>{l.weekLabel}</TableCell>
                    <TableCell sx={{ fontWeight: 600 }}>
                      {l.activityName}
                      {l.provisional ? " (provisional)" : ""}
                    </TableCell>
                    <TableCell>{l.plotLabel}</TableCell>
                    <TableCell align="right" sx={{ whiteSpace: "nowrap" }}>{l.quantityLabel}</TableCell>
                    <TableCell align="right">{money(l.rateCents)}</TableCell>
                    <TableCell align="right" sx={{ fontWeight: 700 }}>{money(l.amountCents)}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
              <TableFooter>
                <TableRow sx={{ "& td": { fontWeight: 800, color: "primary.dark", fontSize: 17 } }}>
                  <TableCell colSpan={5}>Total labores</TableCell>
                  <TableCell align="right">{money(doc.linesTotalCents)}</TableCell>
                </TableRow>
              </TableFooter>
            </Table>
          </Box>
        )}

        <Box sx={{ mt: 3 }}>
          {doc.summary.map((r) => (
            <Stack
              key={r.label}
              direction="row"
              justifyContent="space-between"
              alignItems="baseline"
              sx={{
                py: 1,
                borderTop: r.strong ? 2 : 0,
                borderColor: "primary.main",
                borderBottom: r.strong ? 0 : 1,
                borderBottomColor: "divider",
              }}
            >
              <Typography sx={{ fontSize: 18, fontWeight: r.strong ? 800 : 400 }}>{r.label}</Typography>
              <Typography sx={{ fontSize: r.strong ? 21 : 18, fontWeight: r.strong ? 800 : 600, whiteSpace: "nowrap" }}>
                {r.sign ? `${r.sign} ` : ""}
                {money(r.cents)}
              </Typography>
            </Stack>
          ))}
        </Box>

        <Stack
          direction="row"
          justifyContent="space-between"
          alignItems="baseline"
          sx={{ mt: 2, p: 2, border: 2, borderColor: "primary.main", borderRadius: 1.5 }}
        >
          <Typography sx={{ fontSize: 17, textTransform: "uppercase", letterSpacing: ".05em" }} color="text.secondary">
            {doc.headline.label}
          </Typography>
          <Typography sx={{ fontSize: 28, fontWeight: 800, color: "primary.dark" }}>
            {money(doc.headline.cents)}
          </Typography>
        </Stack>

        {doc.balanceSentence && (
          <Typography sx={{ fontSize: 18, mt: 2 }}>{doc.balanceSentence}</Typography>
        )}
        {doc.note && (
          <Typography sx={{ fontSize: 17, mt: 1 }} color="text.secondary">
            Nota: {doc.note}
          </Typography>
        )}
        {doc.provisional && (
          <Alert severity="warning" sx={{ mt: 2, fontSize: 16 }}>
            <strong>PROVISIONAL.</strong> Las líneas marcadas se pagan al precio de la semana, que
            todavía no está fijado.
          </Alert>
        )}
      </CardContent>
    </Card>
  );
}
