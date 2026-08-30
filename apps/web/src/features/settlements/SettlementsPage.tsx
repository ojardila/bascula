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
 *   de qué periodo  the period ACTUALLY covered — BOTH ends of it. It starts
 *                   at the Monday of the earliest payable rather than the
 *                   window the client asked over, and it is frequently not a
 *                   week: the running farm's settlements span from August 2026
 *                   to August 2027
 *   cuánto          the gross, and what is still owed after it
 *   cuáles están anuladas   voided ones are LISTED, struck through, with the
 *                   date — never filtered out, because the ledger carries the
 *                   reversal and a list that hides the settlement cannot be
 *                   reconciled against it
 *
 * `GET /v1/settlements` exists now and answers in one request;
 * `api.listSettlements` still keeps a fan-out behind it for an older server
 * and says so. Either way this screen loads once and filters IN THE BROWSER
 * rather than round-tripping on every keystroke.
 *
 * WHICH MAKES THE FILTER PART OF EVERY FIGURE ON THE PAGE, and that is the
 * thing this screen got wrong for a whole sprint. The three cards and the
 * printed payroll are all sums over the filtered rows, under labels that read
 * as facts about the farm. Typing "Rosa" turned a $2.220.080 payroll into a
 * $335.280 one — on screen AND on the sheet that gets signed and filed, with
 * no mark on the paper to say so. Now the filter names itself in one place and
 * that name reaches the banner, the card labels, the button and the document.
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
import { formatDate, formatPeriod, todayInFarm } from "../../lib/dates";
import { formatMoney } from "../../lib/money";
import { payrollHtml } from "../documents/documents";
import { printDocument } from "../documents/print";
import type { SettlementSummary } from "../../api/types";
import { GROSS_SETTLED_LIVE, GROSS_SETTLED_LIVE_FILTERED } from "../../lib/vocab";

type StatusFilter = "all" | "open" | "void";

const fold = (s: string) => s.toLowerCase().normalize("NFD").replace(/\p{Diacritic}/gu, "");

export function SettlementsPage() {
  const navigate = useNavigate();
  const { user, can } = useAuth();
  const [search, setSearch] = useState("");
  const [status, setStatus] = useState<StatusFilter>("all");

  const { data: list, error, denied } = useAsync(() => api.listSettlements(), []);
  const data = list?.items ?? null;
  /**
   * ── «NO HAY» NO ES LO MISMO QUE «NO PUDE» ────────────────────────────
   *
   * Sin `GET /v1/settlements` esta lista se compone leyendo el libro de cada
   * empleado, y esas lecturas fallan una a una. Los `catch` de
   * `api.listSettlements` devolvían listas vacías, así que una caída llegaba
   * aquí exactamente igual que una finca nueva — y la pantalla AFIRMABA, en
   * presente y sobre la finca, que no se había liquidado nada nunca. Peor:
   * imprimía la planilla en blanco, con su columna de firmas.
   *
   * Ahora los huecos vienen contados y la pantalla los dice, la lista se
   * marca como incompleta, y el botón de imprimir se apaga: un papel que se
   * firma no sale de una lectura que se sabe rota.
   */
  const holes = (list?.unreadableLedgers ?? 0) + (list?.unreadableSettlements ?? 0);
  const incomplete = holes > 0;

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
   * void settlement contributed an earning and a reversal that cancel each
   * other, so counting it would state a total the ledger does not agree with.
   */
  const live = (rows ?? []).filter((s) => s.status === "open");
  const totalCents = live.reduce((a, s) => a + s.grossCents, 0);
  const voided = (rows ?? []).length - live.length;

  /**
   * ── WHAT THE FIGURES ABOVE ARE ACTUALLY ABOUT ────────────────────────
   *
   * Everything on this screen — the three cards and the printed sheet — is a
   * sum over `rows`, and `rows` is what the FILTERS left. That was never
   * stated anywhere. "BRUTO LIQUIDADO (VIGENTES)" reads as a fact about the
   * farm, and "vigentes" means "not voided", not "matching what you typed".
   * Typing "Rosa" turned $2.220.080 into $335.280 under a label that claimed
   * to be about the farm.
   *
   * So the filters are named, in Spanish, once — and that one list drives the
   * banner, the card labels and the paper. A screen that says "filtrado" and a
   * sheet that does not would be the same bug with an extra step.
   */
  const activeFilters: string[] = [];
  if (search.trim() !== "") activeFilters.push(`empleado contiene «${search.trim()}»`);
  if (status === "open") activeFilters.push("solo las vigentes");
  if (status === "void") activeFilters.push("solo las anuladas");
  const filtered = activeFilters.length > 0;

  /** The farm's real totals, so the banner can say what is being left out. */
  const allLive = (data ?? []).filter((s) => s.status === "open");
  const allTotalCents = allLive.reduce((a, s) => a + s.grossCents, 0);

  function printPayroll() {
    if (!rows || rows.length === 0) return;
    printDocument(
      payrollHtml({
        farmName: user?.farm.name ?? "Finca",
        title: filtered ? "Planilla de liquidaciones (parcial)" : "Planilla de liquidaciones",
        date: todayInFarm(user?.farm.timezone ?? "America/Bogota"),
        unit: null,
        // The sheet declares its own scope. Without this the paper is a search
        // result wearing the farm's letterhead, with a signature column.
        scope: {
          filters: activeFilters,
          totalRows: data?.length ?? rows.length,
          totalGrossCents: allTotalCents,
        },
        rows: rows.map((s) => ({
          name: s.workerName,
          // The list carries no document number, no weighed quantity and no
          // balance: all three live on rows this screen does not load. Null
          // prints as "—", which is the truth; a zero would read as "weighed
          // nothing" and "queda a paz y salvo", neither of which was asked.
          quantity: null,
          grossCents: s.grossCents,
          balanceCents: null,
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
            Cada liquidación congela unas labores a su precio y escribe en el libro lo
            que la persona ganó. Anularla no la borra: la deja anulada y suelta las
            labores.
          </Typography>
        </Box>
        <Button
          startIcon={<PrintIcon />}
          variant="outlined"
          // Una planilla en blanco con columna de firmas, salida de una lectura
          // que falló, es el peor papel que este producto puede imprimir.
          disabled={!rows || rows.length === 0 || incomplete}
          onClick={printPayroll}
        >
          {filtered ? "Planilla (parcial)" : "Planilla"}
        </Button>
      </Stack>

      {incomplete && (
        <Alert severity="warning" sx={{ mb: 2 }}>
          <strong>Esta lista está incompleta.</strong>{" "}
          {list!.unreadableLedgers > 0 &&
            `No se pudo leer el libro de ${list!.unreadableLedgers} ${
              list!.unreadableLedgers === 1 ? "empleado" : "empleados"
            }, así que sus liquidaciones no aparecen. `}
          {list!.unreadableSettlements > 0 &&
            `${list!.unreadableSettlements} ${
              list!.unreadableSettlements === 1
                ? "liquidación no se pudo consultar"
                : "liquidaciones no se pudieron consultar"
            }. `}
          Las cifras de abajo son de lo que sí se pudo leer, y la planilla no se puede
          imprimir hasta que la lista esté entera: un papel que se firma no sale de una
          lectura rota.
        </Alert>
      )}

      {filtered && rows !== null && (
        <Alert
          severity="info"
          sx={{ mb: 2 }}
          action={
            <Button
              color="inherit"
              size="small"
              onClick={() => {
                setSearch("");
                setStatus("all");
              }}
            >
              Quitar el filtro
            </Button>
          }
        >
          Está viendo <strong>{rows.length}</strong> de{" "}
          <strong>{data?.length ?? rows.length}</strong> liquidaciones (
          {activeFilters.join("; ")}). Las cifras de abajo y la planilla son de esas{" "}
          {rows.length}, no de la finca entera: sin el filtro el bruto vigente es{" "}
          <strong>{formatMoney(allTotalCents)}</strong>.
        </Alert>
      )}

      <Grid container spacing={2} sx={{ mb: 3 }}>
        <Grid size={{ xs: 12, sm: 4 }}>
          <Card variant="outlined">
            <CardContent>
              <Typography variant="overline" color="text.secondary">
                {/* Decía «(vigentes)», que es un estado de fila de base de
                    datos. Lo que quiere decir es que las anuladas no cuentan,
                    y eso se puede decir así. `lib/vocab.ts`. */}
                {filtered ? GROSS_SETTLED_LIVE_FILTERED : GROSS_SETTLED_LIVE}
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
                {filtered ? "Vigentes (filtrado)" : "Vigentes"}
              </Typography>
              <Typography variant="h2">{rows === null ? "—" : live.length}</Typography>
            </CardContent>
          </Card>
        </Grid>
        <Grid size={{ xs: 6, sm: 4 }}>
          <Card variant="outlined">
            <CardContent>
              <Typography variant="overline" color="text.secondary">
                {filtered ? "Anuladas (filtrado)" : "Anuladas"}
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
            {/* Las cuatro ramas del módulo de cosecha, aquí: cargando,
                falló, filtro sin resultados, y vacío de verdad. La cuarta es
                la única que puede afirmar algo sobre la finca. */}
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
                  {data?.length !== 0
                    ? "Ninguna liquidación coincide con el filtro."
                    : incomplete
                      ? "No se encontró ninguna liquidación en lo que sí se pudo leer. No quiere decir que no las haya: parte de la consulta falló."
                      : "Todavía no se ha liquidado nada en esta finca."}
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
        {/* BOTH ENDS. `formatWeekRange(periodStart)` prints the seven days
            after a Monday, which is a different period from the one the
            settlement covers whenever it is not exactly a week — and on the
            running farm none of them are. Every row read "24–30 ago" while
            the printed sheet, which had it right, said otherwise. */}
        <Typography variant="body2">
          {formatPeriod(s.periodStart, s.periodEnd)}
        </Typography>
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
