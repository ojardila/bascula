import { Navigate, Route, Routes, useLocation } from "react-router-dom";
import { AppShell } from "./components/AppShell";
import { RequireAuth, RequirePermission, RequireSuperAdmin } from "./components/Guards";
import { useAuth } from "./auth/AuthContext";
import { LoginPage } from "./features/auth/LoginPage";
import { SignupPage } from "./features/auth/SignupPage";
import { DashboardPage } from "./features/dashboard/DashboardPage";
import { PlotsPage } from "./features/plots/PlotsPage";
import { PlotFormPage } from "./features/plots/PlotFormPage";
import { PlotDetailPage } from "./features/plots/PlotDetailPage";
import { PlotMapPage } from "./features/plots/PlotMapPage";
import { WorkersPage } from "./features/workers/WorkersPage";
import { WorkerFormPage } from "./features/workers/WorkerFormPage";
import { WorkerProfilePage } from "./features/workers/WorkerProfilePage";
import { PayWorkerPage } from "./features/workers/PayWorkerPage";
import { ActivitiesPage } from "./features/activities/ActivitiesPage";
import { WeekPricePage } from "./features/prices/WeekPricePage";
import { CrewPayrollPage } from "./features/payroll/CrewPayrollPage";
import { SettlementsPage } from "./features/settlements/SettlementsPage";
import { SettlementDetailPage } from "./features/settlements/SettlementDetailPage";
import { FarmUsersPage } from "./features/users/FarmUsersPage";
import { WorkRecordsPage } from "./features/workrecords/WorkRecordsPage";
import { WorkRecordFormPage } from "./features/workrecords/WorkRecordFormPage";
import { HarvestLayout } from "./features/harvest/HarvestLayout";
import { SeasonPage } from "./features/harvest/SeasonPage";
import { WeekPage } from "./features/harvest/WeekPage";
import { CropsPage } from "./features/harvest/CropsPage";
import { YieldPage } from "./features/harvest/YieldPage";
import { ReviewPage } from "./features/harvest/ReviewPage";
import { InventoryPage } from "./features/inventory/InventoryPage";
import { SalesPage } from "./features/sales/SalesPage";
import { ExpensesPage } from "./features/expenses/ExpensesPage";
import { ConfigPage } from "./features/config/ConfigPage";
import { SuperAdminPage } from "./features/admin/SuperAdminPage";

/**
 * `/parcelas/<id>/mapa` -> `/lotes/<id>/mapa`, with the tail intact.
 *
 * Renaming the route is the right call —the address bar is product too— but a
 * link somebody passed around on WhatsApp three weeks ago has no business
 * dying over it. This is a redirect, not an alias: the bar ends up saying
 * "lotes".
 */
function LegacyPlotRedirect() {
  const { pathname, search, hash } = useLocation();
  return <Navigate to={pathname.replace(/^\/parcelas/, "/lotes") + search + hash} replace />;
}

/** Everything inside the tenant shell. */
function Shell() {
  const { landing } = useAuth();
  return (
    <AppShell>
      <Routes>
        <Route index element={<Navigate to={landing} replace />} />
        <Route
          path="tablero"
          element={
            <RequirePermission action="dashboard.view" moduleName="ver el tablero">
              <DashboardPage />
            </RequirePermission>
          }
        />

        {/* THE LAND IS CALLED "lote", IN THE ADDRESS BAR TOO. The menu said
            "Parcelas" and the first field of the form that creates them said
            "Nombre del lote"; the phone knows no word but "lote". See
            `lib/vocab.ts`. The old route is still below, redirecting, because
            somebody out there has `/parcelas` bookmarked and a new word is no
            reason to break their link. */}
        <Route
          path="lotes"
          element={
            <RequirePermission action="plots.read" moduleName="ver los lotes">
              <PlotsPage />
            </RequirePermission>
          }
        />
        <Route
          path="lotes/nuevo"
          element={
            <RequirePermission action="plots.write" moduleName="crear lotes">
              <PlotFormPage />
            </RequirePermission>
          }
        />
        {/* The ONLY route in this file that had no guard, and the one that
            leaked. `/lotes` and `/lotes/:id/mapa` are both `plots.read`; the
            detail was reachable by typing the URL with no check at all. A
            route without a guard is not a decision anybody made — it is the
            one that was forgotten. */}
        <Route
          path="lotes/:id"
          element={
            <RequirePermission action="plots.read" moduleName="ver este lote">
              <PlotDetailPage />
            </RequirePermission>
          }
        />
        {/* The map is `plots.read`, not `plots.write`: a weigher may look at
            the boundary of the lot he is standing in. The editor itself goes
            read-only without `plots.write`, and the server refuses the PUT
            with its own action, `plots.boundary.write`. */}
        <Route
          path="lotes/:id/mapa"
          element={
            <RequirePermission action="plots.read" moduleName="ver el mapa del lote">
              <PlotMapPage />
            </RequirePermission>
          }
        />
        <Route
          path="lotes/:id/editar"
          element={
            <RequirePermission action="plots.write" moduleName="modificar lotes">
              <PlotFormPage />
            </RequirePermission>
          }
        />
        {/* Whatever was bookmarked keeps working. `nueva` was feminine because
            "parcela" is; "lote" is not, so the new route is `/lotes/nuevo`
            and the old one still reaches it. */}
        <Route path="parcelas" element={<Navigate to="/lotes" replace />} />
        <Route path="parcelas/nueva" element={<Navigate to="/lotes/nuevo" replace />} />
        <Route path="parcelas/*" element={<LegacyPlotRedirect />} />

        <Route
          path="empleados"
          element={
            <RequirePermission action="workers.read" moduleName="ver los empleados">
              <WorkersPage />
            </RequirePermission>
          }
        />
        <Route
          path="empleados/nuevo"
          element={
            <RequirePermission action="workers.write" moduleName="registrar empleados">
              <WorkerFormPage />
            </RequirePermission>
          }
        />
        <Route
          path="empleados/:id"
          element={
            <RequirePermission action="workers.profile" moduleName="ver el perfil de un empleado">
              <WorkerProfilePage />
            </RequirePermission>
          }
        />
        <Route
          path="empleados/:id/editar"
          element={
            <RequirePermission action="workers.write" moduleName="modificar empleados">
              <WorkerFormPage />
            </RequirePermission>
          }
        />
        <Route
          path="empleados/:id/pagar"
          element={
            <RequirePermission action="money.pay" moduleName="pagar a un empleado">
              <PayWorkerPage />
            </RequirePermission>
          }
        />

        {/* The crew payroll: settling and paying all thirty of them. It is
            `money.pay` and not `money.read`, which also means a suspended farm
            does not see it at all — `money.pay` is a write action. Until this
            screen existed the console could only pay one worker per page, and
            `docs/simplificacion.md` §2.1 makes it the prerequisite for taking
            the payroll off the phone. */}
        <Route
          path="nomina"
          element={
            <RequirePermission action="money.pay" moduleName="correr la nómina">
              <CrewPayrollPage />
            </RequirePermission>
          }
        />

        {/* Settlements. Settling still happens inside "pagar empleado" —
            that is where the decision is made — but the settlements themselves
            are now records the farm can look up, print and anull. Reading them
            is `money.read`; anulling is guarded inside the detail screen. */}
        <Route
          path="liquidaciones"
          element={
            <RequirePermission action="money.read" moduleName="ver las liquidaciones">
              <SettlementsPage />
            </RequirePermission>
          }
        />
        <Route
          path="liquidaciones/:id"
          element={
            <RequirePermission action="money.read" moduleName="ver una liquidación">
              <SettlementDetailPage />
            </RequirePermission>
          }
        />

        <Route
          path="actividades"
          element={
            <RequirePermission action="activities.read" moduleName="ver las actividades">
              <ActivitiesPage />
            </RequirePermission>
          }
        />

        {/* The week's price per kilo. `PUT /v1/prices/weeks/{monday}` had been
            in the client since sprint 1 and no screen called it: the console
            knew how to read the price and not how to set it, which is the
            owner's most ordinary task during harvest. `config.prices` is the
            owner's alone, as in the role matrix and on the server
            (`prices.write`). */}
        <Route
          path="precio-semana"
          element={
            <RequirePermission action="config.prices" moduleName="fijar el precio de la semana">
              <WeekPricePage />
            </RequirePermission>
          }
        />

        {/* Cosecha. Five readings of one set of facts, so they share a layout
            and a single load — see the note at the top of HarvestLayout. The
            week detail hangs off the season and has no tab of its own. */}
        <Route
          path="cosecha"
          element={
            <RequirePermission action="harvest.read" moduleName="ver la cosecha">
              <HarvestLayout />
            </RequirePermission>
          }
        >
          <Route index element={<SeasonPage />} />
          <Route path="semana/:monday" element={<WeekPage />} />
          <Route path="cultivos" element={<CropsPage />} />
          <Route path="rendimiento" element={<YieldPage />} />
          <Route path="revision" element={<ReviewPage />} />
        </Route>

        <Route
          path="labores"
          element={
            <RequirePermission action="workRecords.read" moduleName="ver las labores">
              <WorkRecordsPage />
            </RequirePermission>
          }
        />
        <Route
          path="labores/nueva"
          element={
            <RequirePermission action="workRecords.write" moduleName="registrar labores">
              <WorkRecordFormPage />
            </RequirePermission>
          }
        />

        {/* RSP-018 … RSP-033. The weigher reaches none of these three: the
            money surface and the warehouse are outside his projection, and
            the guard says so before the server has to. */}
        <Route
          path="inventario"
          element={
            <RequirePermission action="products.read" moduleName="ver el inventario">
              <InventoryPage />
            </RequirePermission>
          }
        />
        <Route
          path="ventas"
          element={
            <RequirePermission action="sales.read" moduleName="ver las ventas">
              <SalesPage />
            </RequirePermission>
          }
        />
        <Route
          path="gastos"
          element={
            <RequirePermission action="expenses.read" moduleName="ver los gastos">
              <ExpensesPage />
            </RequirePermission>
          }
        />

        <Route
          path="configuracion"
          element={
            <RequirePermission action="config.farm" moduleName="ver la configuración">
              <ConfigPage />
            </RequirePermission>
          }
        />
        {/* User management. OWNER ONLY, and that is stricter than
            `casos-de-uso.md` reads on its own: `docs/diagramas/sistema.md`
            §3.3 puts this in the owner column and not the administrator's, so
            an admin who reaches the URL is shown the door rather than a
            screen the server would refuse anyway. */}
        <Route
          path="configuracion/usuarios"
          element={
            <RequirePermission action="config.users" moduleName="gestionar los usuarios">
              <FarmUsersPage />
            </RequirePermission>
          }
        />

        <Route path="*" element={<Navigate to={landing} replace />} />
      </Routes>
    </AppShell>
  );
}

export function App() {
  return (
    <Routes>
      <Route path="/entrar" element={<LoginPage />} />
      <Route path="/registro" element={<SignupPage />} />
      {/* The super-admin hangs off the login, not off the farm shell: other
          routes, another role, and no read of anybody's ledger. */}
      <Route
        path="/admin/fincas"
        element={
          <RequireSuperAdmin>
            <SuperAdminPage />
          </RequireSuperAdmin>
        }
      />
      <Route
        path="/*"
        element={
          <RequireAuth>
            <Shell />
          </RequireAuth>
        }
      />
    </Routes>
  );
}
