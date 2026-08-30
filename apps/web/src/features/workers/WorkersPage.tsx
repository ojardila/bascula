/**
 * LA LISTA DE EMPLEADOS.
 *
 * La columna de la derecha decía «—» en todas las filas y sumaba «Total a
 * favor: $0», mientras el tablero decía $334.500 y el perfil de una sola
 * persona decía $184.500. La causa era mecánica: la columna leía
 * `w.balanceCents`, y `GET /v1/workers` nunca ha enviado ese campo. Un
 * `undefined` se pintaba como guion en cada fila y como cero en el pie.
 *
 * Ahora la cifra sale de donde sale en todas las demás pantallas —
 * `features/workers/owed.ts` — y de dos lecturas que esta pantalla puede
 * hacer en paralelo: `/v1/balances` para el libro y `/v1/work-records` para lo
 * que falta liquidar. Dos peticiones, no una por empleado: aquí la cifra se
 * lee, no se firma. Donde se firma —la nómina— se sigue leyendo `payables`
 * cabeza por cabeza, que es la consulta que corre la liquidación.
 */
import { useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Alert, Avatar, Box, Stack, Tooltip, Typography } from "@mui/material";
import { ModuleList, type Column, type StatusFilter } from "../../components/ModuleList";
import { PermissionDenied } from "../../components/Guards";
import { Money } from "../../components/Money";
import { useAsync } from "../../lib/useAsync";
import { api } from "../../api/endpoints";
import { useAuth } from "../../auth/AuthContext";
import { messageFor } from "../../api/errors";
import { formatDate } from "../../lib/dates";
import { OwedFigure } from "./OwedFigure";
import { owedByWorker, owedOf, sumOwedToFarmWorkers } from "./owed";
import type { Worker } from "../../api/types";
import { EMPLEADO, PROVISIONAL_INCLUDES } from "../../lib/vocab";

export function WorkersPage() {
  const navigate = useNavigate();
  const { can } = useAuth();
  const [search, setSearch] = useState("");
  const [status, setStatus] = useState<StatusFilter>("active");
  const [actionError, setActionError] = useState<string | null>(null);

  const { data, error, denied, reload } = useAsync(
    () => api.listWorkers({ status, q: search || undefined }),
    [status, search],
  );

  // The weigher gets a narrower row from the server: no document, no phone,
  // no balance. The table follows the payload rather than hiding columns,
  // which is the same distinction the API makes.
  const full = can("workers.readFull");
  const money = can("money.read");

  /**
   * Las dos mitades de la cuenta, cada una con su propio fallo, en una sola
   * carga para que «todavía no llegó» y «no se pudo» sean estados distintos:
   * mientras `ledger` es null la pantalla está cargando; cuando llega, cada
   * mitad puede venir en null y eso ya significa «falló».
   *
   * `.catch(() => null)` y no `?? []`: una lista vacía diría «nadie tiene
   * saldo», que es una afirmación sobre la finca. El null viaja hasta la
   * celda, que escribe un guion con su motivo.
   */
  const { data: ledger } = useAsync(async () => {
    if (!money) return { balances: null, records: null, read: false };
    const [balances, records] = await Promise.all([
      api.listBalances().catch(() => null),
      api.listWorkRecords({ status: "active" }).catch(() => null),
    ]);
    return { balances, records, read: true };
  }, [money]);

  const accounts = useMemo(
    () => owedByWorker(ledger?.balances ?? null, ledger?.records ?? null),
    [ledger],
  );
  const accountOf = (w: Worker) =>
    owedOf(accounts, w.id, !!ledger?.balances, !!ledger?.records);

  const columns: Column<Worker>[] = useMemo(() => {
    const base: Column<Worker>[] = [
      {
        key: "name",
        header: EMPLEADO.One,
        render: (w) => (
          <Stack direction="row" spacing={1.5} alignItems="center">
            <Avatar src={w.photoUrl ?? undefined} sx={{ width: 36, height: 36 }}>
              {w.name[0]}
            </Avatar>
            <Box>
              <Typography sx={{ fontWeight: 600 }}>
                {w.name} {w.lastName}
              </Typography>
              {full && (
                <Typography variant="caption" color="text.secondary">
                  {w.documentType} {w.documentNumber}
                </Typography>
              )}
            </Box>
          </Stack>
        ),
      },
    ];
    if (full) {
      base.push(
        { key: "phone", header: "Teléfono", render: (w) => w.phone ?? "—", secondary: true },
        { key: "city", header: "Ciudad", render: (w) => w.city ?? "—", secondary: true },
        {
          key: "since",
          header: "Desde",
          render: (w) => (w.startedAt ? formatDate(w.startedAt) : "—"),
          secondary: true,
        },
      );
    }
    if (money) {
      base.push({
        key: "owed",
        header: "Se le debe",
        align: "right",
        render: (w) =>
          ledger === null ? (
            <Typography variant="body2" color="text.secondary">
              …
            </Typography>
          ) : (
            <OwedFigure owed={accountOf(w)} />
          ),
      });
    }
    return base;
    // `accountOf` cierra sobre `ledger` y `accounts`, que son las dependencias
    // reales de la celda.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [full, money, ledger, accounts]);

  if (denied) return <PermissionDenied moduleName="ver los empleados" />;

  /**
   * El pie suma exactamente lo que dicen las filas, con la misma función que
   * usa el tablero. Los saldos negativos —un anticipo que alguien carga— no
   * se restan de lo que la finca debe: la plata que hay que contar el sábado
   * no baja porque alguien deba.
   */
  const farmOwes = sumOwedToFarmWorkers((data ?? []).map(accountOf));

  return (
    <Box>
      {actionError && (
        <Alert severity="error" sx={{ mb: 2 }} onClose={() => setActionError(null)}>
          {actionError}
        </Alert>
      )}
      <ModuleList<Worker>
        title={EMPLEADO.Many}
        singular={EMPLEADO.one}
        plural={EMPLEADO.many}
        rows={data}
        error={error}
        columns={columns}
        getId={(w) => w.id}
        getName={(w) => `${w.name} ${w.lastName}`}
        isInactive={(w) => w.status === "inactive"}
        search={search}
        onSearchChange={setSearch}
        searchPlaceholder="Buscar por nombre o identificación"
        statusFilter={status}
        onStatusFilterChange={setStatus}
        onCreate={can("workers.write") ? () => navigate(`${EMPLEADO.path}/nuevo`) : undefined}
        createLabel={`Nuevo ${EMPLEADO.one}`}
        onRowClick={can("workers.profile") ? (w) => navigate(`${EMPLEADO.path}/${w.id}`) : undefined}
        onEdit={can("workers.write") ? (w) => navigate(`${EMPLEADO.path}/${w.id}/editar`) : undefined}
        extraActions={
          can("money.pay")
            ? (w) => [{ label: "Pagar empleado", onClick: () => navigate(`${EMPLEADO.path}/${w.id}/pagar`) }]
            : undefined
        }
        onDeactivate={
          can("workers.delete")
            ? async (w) => {
                try {
                  await api.deactivateWorker(w.id);
                  reload();
                } catch (e) {
                  setActionError(messageFor(e));
                }
              }
            : undefined
        }
        onReactivate={
          can("workers.delete")
            ? async (w) => {
                await api.reactivateWorker(w.id);
                reload();
              }
            : undefined
        }
        emptyTitle="Todavía no hay empleados"
        emptyBody="Registre a las personas que trabajan en la finca. Cada una lleva su propio saldo y su historial."
        footer={
          data && money ? (
            <Stack direction="row" spacing={2} flexWrap="wrap" useFlexGap>
              <span>
                {data.length} {data.length === 1 ? "empleado" : "empleados"}
              </span>
              <span>
                La finca les debe:{" "}
                {ledger === null ? (
                  "…"
                ) : farmOwes.cents === null ? (
                  <Tooltip title="No se pudo consultar ninguna cuenta. No es cero.">
                    <Box component="span" sx={{ color: "text.disabled", fontWeight: 700, cursor: "help" }}>
                      —
                    </Box>
                  </Tooltip>
                ) : (
                  <Money cents={farmOwes.cents} variant="small" />
                )}
                {farmOwes.isEstimate && ` (${PROVISIONAL_INCLUDES})`}
              </span>
              {/* La suma dice de cuántos es. Un total con gente fuera, sin
                  decirlo, es la misma mentira que arreglamos arriba. */}
              {ledger !== null && farmOwes.unreadable > 0 && (
                <Box component="span" sx={{ color: "warning.dark" }}>
                  {farmOwes.unreadable === 1
                    ? "1 cuenta no se pudo leer y queda fuera de esa suma."
                    : `${farmOwes.unreadable} cuentas no se pudieron leer y quedan fuera de esa suma.`}
                </Box>
              )}
            </Stack>
          ) : null
        }
      />
    </Box>
  );
}
