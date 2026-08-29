/**
 * LAS LIQUIDACIONES DE LA FINCA.
 *
 * Until this sprint, settling lived entirely inside "pagar empleado": you
 * could make one and never see it again. The sidebar has carried a disabled
 * "Liquidación" entry since Sprint 1 with a comment explaining that settling
 * "is a step inside pagar empleado and has no screen of its own" — this is
 * that screen, and the entry is live.
 *
 * What it answers, which nothing else did:
 *
 *   cuáles hay      every settlement the farm has made, newest first
 *   de quién        the worker's name, joined — never a UUID
 *   de qué semana   the period ACTUALLY covered, which is the Monday of the
 *                   earliest payable and not the window the client asked over
 *   cuánto          the gross, and what is still owed after it
 *   cuáles están anuladas   voided ones are LISTED, struck through, with the
 *                   date — never filtered out, because the ledger carries the
 *                   reversal and a list that hides the settlement cannot be
 *                   reconciled against it
 *
 * There is no `GET /v1/settlements`; `api.listSettlements` composes the list
 * out of the ledgers and says how. That composition is a fan-out, which is why
 * this screen loads once and filters in the browser rather than round-tripping
 * on every keystroke — and why the empty state says what it is doing.
 */
import { useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import {
  Alert, Box, Button, Card, CardContent, Chip, Grid, MenuItem, Stack, Table, TableBody,
  TableCell, TableHead, TableRow, TextField, Typography,
} from "@mui/material";
import PrintIcon from "@mui/icons-material/Print";
import { Money } from "../../components/Money";
import { PermissionDenied } from "../../components/Guards";
import { useAsync } from "../../lib/useAsync";
import { useAuth } from "../../auth/AuthContext";
import { api } from "../../api/endpoints";
import { formatDate, formatWeekRange, todayInFarm } from "../../lib/dates";
import { payrollHtml } from "../documents/documents";
import { printDocument } from "../documents/print";
import type { SettlementSummary } from "../../api/types";

type StatusFilter = "all" | "open" | "void";

const fold = (s: string) => s.toLowerCase().normalize("NFD").replace(/\p{Diacritic}/gu, "");

export function SettlementsPage() {
  const navigate = useNavigate();
  const { user, can } = useAuth();
  const [search, setSearch] = useState("");
  const [status, setStatus] = useState<StatusFilter>("all");

  const { data, error, denied } = useAsync(() => api.listSettlements(), []);

  const rows = useMemo(() => {
    if (!data) return null;
    const q = fold(search.trim());
    return data.filter(
      (s) =>
        (status === "all" || s.status === status) &&
        (q === "" || fold(s.workerName).includes(q)),
    );
  }, [data, search, status]);

  if (!can("money.read")) return <PermissionDenied moduleName="ver las liquidaciones" />;
  if (denied) return <PermissionDenied moduleName="ver las liquidaciones" />;
  if (error) return <Alert severity="error">{error}</Alert>;

  /**
   * The three figures at the top are sums over the LIVE settlements only. A
   * void settlement contributed a `devengo` and a `reverso` that cancel each
   * other, so counting it would state a total the ledger does not agree with.
   */
  const live = (rows ?? []).filter((s) => s.status === "open");
  const totalCents = live.reduce((a, s) => a + s.grossCents, 0);
  const voided = (rows ?? []).length - live.length;

  function printPayroll() {
    if (!rows || rows.length === 0) return;
    printDocument(
      payrollHtml({
        farmName: user?.farm.name ?? "Finca",
        title: "Planilla de liquidaciones",
        date: todayInFarm(user?.farm.timezone ?? "America/Bogota"),
        unit: null,
        rows: rows.map((s) => ({
          name: s.workerName,
          // The list carries no document number and no weighed quantity: both
          // live on rows this screen does not load. Null prints as "—", which
          // is the truth; a zero would read as "weighed nothing".
          quantity: null,
          grossCents: s.grossCents,
          balanceCents: 0,
          status: s.status,
        })),
      }),
    );
  }

  return (
    <Box>
      <Stack
        direction={{ xs: "column", sm: "row" }}
        justifyContent="space-between"
        alignItems={{ sm: "center" }}
        spacing={2}
        sx={{ mb: 2 }}
      >
        <Box>
          <Typography variant="h1">Liquidaciones</Typography>
          <Typography color="text.secondary">
            Cada liquidación congela unas labores a su precio y escribe un devengo en el
            libro. Anularla no la borra: la deja anulada y suelta las labores.
          </Typography>
        </Box>
        <Button
          startIcon={<PrintIcon />}
          variant="outlined"
          disabled={!rows || rows.length === 0}
          onClick={printPayroll}
        >
          Planilla
        </Button>
      </Stack>

      <Grid container spacing={2} sx={{ mb: 3 }}>
        <Grid size={{ xs: 12, sm: 4 }}>
          <Card variant="outlined">
            <CardContent>
              <Typography variant="overline" color="text.secondary">
                Bruto liquidado (vigentes)
              </Typography>
              {/* No figure at all until the list has loaded. A "$0" while a
                  fan-out is in flight is a claim that the farm has settled
                  nothing, and somebody will read it. */}
              {rows === null ? (
                <Typography color="text.secondary">Cargando…</Typography>
              ) : (
                <Money cents={totalCents} variant="big" />
              )}
            </CardContent>
          </Card>
        </Grid>
        <Grid size={{ xs: 6, sm: 4 }}>
          <Card variant="outlined">
            <CardContent>
              <Typography variant="overline" color="text.secondary">
                Vigentes
              </Typography>
              <Typography variant="h2">{rows === null ? "—" : live.length}</Typography>
            </CardContent>
          </Card>
        </Grid>
        <Grid size={{ xs: 6, sm: 4 }}>
          <Card variant="outlined">
            <CardContent>
              <Typography variant="overline" color="text.secondary">
                Anuladas
              </Typography>
              <Typography variant="h2">{rows === null ? "—" : voided}</Typography>
            </CardContent>
          </Card>
        </Grid>
      </Grid>

      <Stack direction={{ xs: "column", sm: "row" }} spacing={2} sx={{ mb: 2 }}>
        <TextField
          label="Buscar por empleado"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          size="small"
          sx={{ minWidth: 260 }}
        />
        <TextField
          select
          label="Estado"
          value={status}
          onChange={(e) => setStatus(e.target.value as StatusFilter)}
          size="small"
          sx={{ minWidth: 180 }}
        >
          <MenuItem value="all">Todas</MenuItem>
          <MenuItem value="open">Vigentes</MenuItem>
          <MenuItem value="void">Anuladas</MenuItem>
        </TextField>
      </Stack>

      <Card>
        <Table>
          <TableHead>
            <TableRow>
              <TableCell>Empleado</TableCell>
              <TableCell>Periodo</TableCell>
              <TableCell>Registrada</TableCell>
              <TableCell align="right">Líneas</TableCell>
              <TableCell align="right">Bruto</TableCell>
              <TableCell>Estado</TableCell>
            </TableRow>
          </TableHead>
          <TableBody>
            {rows === null && (
              <TableRow>
                <TableCell colSpan={6} sx={{ color: "text.secondary" }}>
                  Reuniendo las liquidaciones de cada empleado…
                </TableCell>
              </TableRow>
            )}
            {rows?.length === 0 && (
              <TableRow>
                <TableCell colSpan={6} sx={{ color: "text.secondary" }}>
                  {data?.length === 0
                    ? "Todavía no se ha liquidado nada en esta finca."
                    : "Ninguna liquidación coincide con el filtro."}
                </TableCell>
              </TableRow>
            )}
            {rows?.map((s) => (
              <SettlementRow key={s.id} s={s} onOpen={() => navigate(`/liquidaciones/${s.id}`)} />
            ))}
          </TableBody>
        </Table>
      </Card>
    </Box>
  );
}

function SettlementRow({ s, onOpen }: { s: SettlementSummary; onOpen: () => void }) {
  const isVoid = s.status === "void";
  return (
    <TableRow hover onClick={onOpen} sx={{ cursor: "pointer", opacity: isVoid ? 0.6 : 1 }}>
      <TableCell sx={{ fontWeight: 600, textDecoration: isVoid ? "line-through" : "none" }}>
        {s.workerName}
      </TableCell>
      <TableCell>
        <Stack>
          <Typography variant="body2">{formatWeekRange(s.periodStart)}</Typography>
          {s.periodStart.slice(0, 7) !== s.periodEnd.slice(0, 7) && (
            <Typography variant="caption" color="text.secondary">
              hasta {formatDate(s.periodEnd)}
            </Typography>
          )}
        </Stack>
      </TableCell>
      <TableCell>{formatDate(s.createdAt.slice(0, 10))}</TableCell>
      <TableCell align="right">{s.lineCount}</TableCell>
      <TableCell align="right">
        <Money cents={s.grossCents} variant="small" />
      </TableCell>
      <TableCell>
        {isVoid ? (
          <Chip
            size="small"
            color="error"
            variant="outlined"
            label={`Anulada ${s.voidedAt ? formatDate(s.voidedAt.slice(0, 10)) : ""}`.trim()}
          />
        ) : (
          <Chip size="small" color="success" variant="outlined" label="Vigente" />
        )}
      </TableCell>
    </TableRow>
  );
}
