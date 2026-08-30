/**
 * THE EMPLOYEE LIST.
 *
 * The right-hand column said "—" on every row and added up to "Total a favor:
 * $0", while the dashboard said $334.500 and a single person's profile said
 * $184.500. The cause was mechanical: the column read `w.balanceCents`, and
 * `GET /v1/workers` has never sent that field. An `undefined` was painted as
 * a dash on every row and as a zero in the footer.
 *
 * Now the figure comes from where it comes from on every other screen —
 * `features/workers/owed.ts` — and out of two reads this screen can do in
 * parallel: `/v1/balances` for the ledger and `/v1/work-records` for what is
 * left to settle. Two requests, not one per employee: here the figure is
 * read, not signed. Where it is signed —payroll— `payables` is still read
 * head by head, which is the query the settlement runs.
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
import { EMPLOYEE, PROVISIONAL_INCLUDES } from "../../lib/vocab";

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
   * The two halves of the account, each with its own failure, in a single
   * load so that "hasn't arrived yet" and "couldn't be done" are distinct
   * states: while `ledger` is null the screen is loading; once it arrives,
   * each half may come back null, and that already means "it failed".
   *
   * `.catch(() => null)` and not `?? []`: an empty list would say "nobody has
   * a balance", which is an assertion about the farm. The null travels all
   * the way to the cell, which writes a dash with its reason.
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
        header: EMPLOYEE.One,
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
    // `accountOf` closes over `ledger` and `accounts`, which are the cell's
    // real dependencies.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [full, money, ledger, accounts]);

  if (denied) return <PermissionDenied moduleName="ver los empleados" />;

  /**
   * The footer adds up exactly what the rows say, with the same function the
   * dashboard uses. Negative balances —an advance somebody is carrying— are
   * not subtracted from what the farm owes: the cash to be counted out on
   * Saturday does not go down because somebody is in debt.
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
        title={EMPLOYEE.Many}
        singular={EMPLOYEE.one}
        plural={EMPLOYEE.many}
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
        onCreate={can("workers.write") ? () => navigate(`${EMPLOYEE.path}/nuevo`) : undefined}
        createLabel={`Nuevo ${EMPLOYEE.one}`}
        onRowClick={can("workers.profile") ? (w) => navigate(`${EMPLOYEE.path}/${w.id}`) : undefined}
        onEdit={can("workers.write") ? (w) => navigate(`${EMPLOYEE.path}/${w.id}/editar`) : undefined}
        extraActions={
          can("money.pay")
            ? (w) => [{ label: "Pagar empleado", onClick: () => navigate(`${EMPLOYEE.path}/${w.id}/pagar`) }]
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
              {/* The sum says how many people it covers. A total with people
                  left out of it, unannounced, is the same lie we fixed
                  above. */}
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
