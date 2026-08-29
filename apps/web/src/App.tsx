import { Navigate, Route, Routes } from "react-router-dom";
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
import { WorkRecordsPage } from "./features/workrecords/WorkRecordsPage";
import { WorkRecordFormPage } from "./features/workrecords/WorkRecordFormPage";
import { InventoryPage } from "./features/inventory/InventoryPage";
import { SalesPage } from "./features/sales/SalesPage";
import { ExpensesPage } from "./features/expenses/ExpensesPage";
import { ConfigPage } from "./features/config/ConfigPage";
import { SuperAdminPage } from "./features/admin/SuperAdminPage";

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

        <Route
          path="parcelas"
          element={
            <RequirePermission action="plots.read" moduleName="ver las parcelas">
              <PlotsPage />
            </RequirePermission>
          }
        />
        <Route
          path="parcelas/nueva"
          element={
            <RequirePermission action="plots.write" moduleName="crear parcelas">
              <PlotFormPage />
            </RequirePermission>
          }
        />
        <Route path="parcelas/:id" element={<PlotDetailPage />} />
        {/* The map is `plots.read`, not `plots.write`: a weigher may look at
            the boundary of the lot he is standing in. The editor itself goes
            read-only without `plots.write`, and the server refuses the PUT
            with its own action, `plots.boundary.write`. */}
        <Route
          path="parcelas/:id/mapa"
          element={
            <RequirePermission action="plots.read" moduleName="ver el mapa de la parcela">
              <PlotMapPage />
            </RequirePermission>
          }
        />
        <Route
          path="parcelas/:id/editar"
          element={
            <RequirePermission action="plots.write" moduleName="modificar parcelas">
              <PlotFormPage />
            </RequirePermission>
          }
        />

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

        <Route
          path="actividades"
          element={
            <RequirePermission action="activities.read" moduleName="ver las actividades">
              <ActivitiesPage />
            </RequirePermission>
          }
        />

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
