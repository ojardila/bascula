import { Navigate, Route, Routes, useLocation } from "react-router-dom";
import { AppShell } from "./components/AppShell";
import { TourProvider } from "./features/onboarding/TourContext";
import { TourHost } from "./features/onboarding/TourHost";
import { RequireAuth, RequirePermission, RequireSuperAdmin } from "./components/Guards";
import { useAuth } from "./auth/AuthContext";
import { LoginPage } from "./features/auth/LoginPage";
import { SignupPage } from "./features/auth/SignupPage";
import { LandingPage } from "./features/marketing/LandingPage";
import { APP_HOME, showsFarmEntry } from "./lib/farmHost";
import { FarmEntryPage } from "./features/entry/FarmEntryPage";
import { ForgotPasswordPage } from "./features/auth/ForgotPasswordPage";
import { OfflineProvider } from "./offline/OfflineContext";
import { OfflineBar } from "./offline/OfflineBar";
import { PlotsPage } from "./features/plots/PlotsPage";
import { PlotFormPage } from "./features/plots/PlotFormPage";
import { PlotDetailPage } from "./features/plots/PlotDetailPage";
import { WorkersPage } from "./features/workers/WorkersPage";
import { WorkerFormPage } from "./features/workers/WorkerFormPage";
import { WorkerProfilePage } from "./features/workers/WorkerProfilePage";
import { ReceiptPage } from "./features/receipts/ReceiptPage";
import { PayWorkerPage } from "./features/workers/PayWorkerPage";
import { ActivitiesPage } from "./features/activities/ActivitiesPage";
import { WeekPricePage } from "./features/prices/WeekPricePage";
import { CrewPayrollPage } from "./features/payroll/CrewPayrollPage";
import { SettlementsPage } from "./features/settlements/SettlementsPage";
import { SettlementDetailPage } from "./features/settlements/SettlementDetailPage";
import { FarmUsersPage } from "./features/users/FarmUsersPage";
import { WorkRecordsPage } from "./features/workrecords/WorkRecordsPage";
import { WorkRecordFormPage } from "./features/workrecords/WorkRecordFormPage";
import { RecoleccionFormPage } from "./features/workrecords/RecoleccionFormPage";
import { PlanillaPage } from "./features/workrecords/PlanillaPage";
import { HarvestLayout } from "./features/harvest/HarvestLayout";
import { CosechaHome } from "./features/harvest/CosechaHome";
import { RegistroMasivoPage } from "./features/workrecords/RegistroMasivoPage";
import { SeasonPage } from "./features/harvest/SeasonPage";
import { WeekPage } from "./features/harvest/WeekPage";
import { CropsPage } from "./features/harvest/CropsPage";
import { YieldPage } from "./features/harvest/YieldPage";
import { ReviewPage } from "./features/harvest/ReviewPage";
import { InventoryPage } from "./features/inventory/InventoryPage";
import { SalesPage } from "./features/sales/SalesPage";
import { ExpensesPage } from "./features/expenses/ExpensesPage";
import { ConfigPage } from "./features/config/ConfigPage";
import { WorkUnitsPage } from "./features/units/WorkUnitsPage";
import { SuperAdminPage } from "./features/admin/SuperAdminPage";
import { ProvisionPage } from "./features/provision/ProvisionPage";

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
    <OfflineProvider>
    <TourProvider>
    <AppShell>
      <OfflineBar />
      <TourHost />
      <Routes>
        <Route index element={<Navigate to={landing} replace />} />
        {/* Tablero left the day-to-day product. Old bookmarks still work:
            they land on Cosecha, the farm's home screen now. */}
        <Route path="tablero" element={<Navigate to="/cosecha" replace />} />

        {/* THE LAND IS CALLED "lote", IN THE ADDRESS BAR TOO. The menu said
            "Parcelas" and the first field of the form that creates them said
            "Nombre del lote"; the farms know no word but "lote". See
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
        {/* A receipt from the worker's history, as it stood that day. Money,
            so `money.read`: the weigher never sees what anybody was paid. */}
        <Route
          path="empleados/:id/historial/:kind/:entryId"
          element={
            <RequirePermission action="money.read" moduleName="ver los recibos">
              <ReceiptPage />
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
            screen existed the web could only pay one worker per page. */}
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
          <Route index element={<CosechaHome />} />
          <Route path="detalles" element={<SeasonPage />} />
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
          path="labores/planilla"
          element={
            <RequirePermission action="workRecords.write" moduleName="registrar la planilla de recolección">
              <PlanillaPage />
            </RequirePermission>
          }
        />
        <Route
          path="cosecha/registro-masivo"
          element={
            <RequirePermission action="workRecords.write" moduleName="el registro de recolección masivo">
              <RegistroMasivoPage />
            </RequirePermission>
          }
        />
        {/* The old name of the same screen; links and bookmarks keep working. */}
        <Route path="cosecha/registrar-semana" element={<RedirectKeepingQuery to="/cosecha/registro-masivo" />} />
        <Route
          path="cosecha/recoleccion"
          element={
            <RequirePermission action="workRecords.write" moduleName="registrar recolección">
              <RecoleccionFormPage />
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

        {/* Units of collection. `activities.read` rather than a catalogs action:
            the server gates the route on `catalogs.read`, which is granted to
            exactly the roles `activities.read` is, and a work unit lives in the
            activity catalogue there. */}
        <Route
          path="unidades"
          element={
            <RequirePermission action="activities.read" moduleName="ver las unidades">
              <WorkUnitsPage />
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

        {/* No "create another farm" inside a farm: each farm is isolated,
            and new farms start only at /empezar on the main domain. The old
            path lands on the farm's home like any unknown one. */}
        <Route path="*" element={<Navigate to={landing} replace />} />
      </Routes>
    </AppShell>
    </TourProvider>
    </OfflineProvider>
  );
}

export function App() {
  return (
    <Routes>
      <Route path="/" element={<HomeRoute />} />
      <Route path="/entrar" element={<LoginPage />} />
      <Route path="/olvide-mi-clave" element={<ForgotPasswordPage />} />
      <Route path="/empezar" element={<SignupPage />} />
      <Route path="/registro" element={<SignupPage />} />
      <Route path="/preparando/:slug" element={<ProvisionPage />} />
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

/**
 * `/`: the marketing landing on the main domain only. On a farm's own address
 * (`{slug}.bascula.engp.io`) and on the general demo there is nothing to
 * sell: somebody signed in goes straight to `/tablero`, anybody else gets the
 * farm's front door (Entrar / Registrar / ¿Olvidó su clave?).
 */
function HomeRoute() {
  const { status } = useAuth();
  if (!showsFarmEntry()) return <LandingPage />;
  if (status === "authenticated") return <Navigate to={APP_HOME} replace />;
  return <FarmEntryPage />;
}

/** A renamed route: same screen, same query string (`?lunes=`, `?lote=`). */
function RedirectKeepingQuery({ to }: { to: string }) {
  const { search } = useLocation();
  return <Navigate to={`${to}${search}`} replace />;
}
