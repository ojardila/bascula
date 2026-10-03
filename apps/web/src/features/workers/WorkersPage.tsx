// SPDX-License-Identifier: MIT
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
import { Alert, Box, Typography } from "@mui/material";
import {
  ModuleList,
  type Column,
  type StatusFilter,
} from "../../components/ModuleList";
import { PermissionDenied } from "../../components/Guards";
import { useAsync } from "../../lib/useAsync";
import { api } from "../../api/endpoints";
import { useAuth } from "../../auth/AuthContext";
import { OwedFigure } from "./OwedFigure";
import { owedByWorker, owedOf, sumOwedToFarmWorkers } from "./owed";
import type { Worker } from "../../api/types";
import { EMPLOYEE } from "../../lib/vocab";
import {
  WorkerNameCell,
  WorkersFooter,
  editPathOf,
  workerListActions,
} from "./WorkersPageParts";


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
          <WorkerNameCell
            w={w}
            full={full}
            onFixBasket={
              can("workers.write") ? () => navigate(editPathOf(w)) : undefined
            }
          />
        ),
      },
    ];
    // Phone, city and start date live on the profile — the list is name + what is owed.
    if (money) {
      base.push({
        key: "owed",
        header: "Se le debe",
        align: "right",
        render: (w) =>
          ledger === null ? (
            <Typography
              variant="body2"
              sx={{
                color: "text.secondary",
              }}
            >
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
  }, [full, money, ledger, accounts, can, navigate]);

  if (denied) return <PermissionDenied moduleName="ver los empleados" />;

  /**
   * The footer adds up exactly what the rows say, with the same function the
   * dashboard uses. Negative balances —an advance somebody is carrying— are
   * not subtracted from what the farm owes: the cash to be counted out on
   * Saturday does not go down because somebody is in debt.
   */
  const farmOwes = sumOwedToFarmWorkers((data ?? []).map(accountOf));
  const actions = workerListActions(can, navigate, reload, setActionError);

  return (
    <Box>
      {actionError && (
        <Alert
          severity="error"
          sx={{ mb: 2 }}
          onClose={() => setActionError(null)}
        >
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
        searchPlaceholder="Buscar por nombre, canasto o cédula"
        statusFilter={status}
        onStatusFilterChange={setStatus}
        {...actions}
        createLabel={`Nuevo ${EMPLOYEE.one}`}
        emptyTitle="Todavía no hay empleados"
        emptyBody="Registre a las personas que trabajan en la finca. Cada una lleva su propio saldo y su historial."
        footer={
          data && money ? (
            <WorkersFooter
              count={data.length}
              loading={ledger === null}
              farmOwes={farmOwes}
            />
          ) : null
        }
      />
    </Box>
  );
}
