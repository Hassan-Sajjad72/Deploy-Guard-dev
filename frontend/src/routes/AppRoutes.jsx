import { lazy, Suspense } from "react";
import { Navigate, Route, Routes, useParams } from "react-router-dom";
import AppLayout from "../components/layout/AppLayout.jsx";
import LoadingState from "../components/common/LoadingState.jsx";
import ProtectedRoute from "./ProtectedRoute.jsx";
import RoleProtectedRoute from "./RoleProtectedRoute.jsx";
import AdminProtectedRoute from "./AdminProtectedRoute.jsx";
import AdminLayout from "../components/layout/AdminLayout.jsx";

const About = lazy(() => import("../pages/About.jsx"));
const AdminLogin = lazy(() => import("../pages/AdminLogin.jsx"));
const AdminUsers = lazy(() => import("../pages/AdminUsers.jsx"));
const Dashboard = lazy(() => import("../pages/Dashboard.jsx"));
const Forbidden = lazy(() => import("../pages/Forbidden.jsx"));
const GithubConnecting = lazy(() => import("../pages/GithubConnecting.jsx"));
const Landing = lazy(() => import("../pages/Landing.jsx"));
const NewProject = lazy(() => import("../pages/NewProject.jsx"));
const ProjectDetails = lazy(() => import("../pages/ProjectDetails.jsx"));
const ProjectInfrastructure = lazy(() => import("../pages/ProjectInfrastructure.jsx"));
const ProjectMetrics = lazy(() => import("../pages/ProjectMetrics.jsx"));
const ProjectPipeline = lazy(() => import("../pages/ProjectPipeline.jsx"));
const ProjectSettings = lazy(() => import("../pages/ProjectSettings.jsx"));
const ProjectTroubleshooting = lazy(() => import("../pages/ProjectTroubleshooting.jsx"));
const Projects = lazy(() => import("../pages/Projects.jsx"));
const Billing = lazy(() => import("../pages/Billing.jsx"));

export default function AppRoutes() {
  return (
    <Suspense fallback={<LoadingState message="Loading page…" />}><Routes>
      <Route element={<Landing />} path="/" />
      <Route element={<About />} path="/about" />
      <Route element={<Navigate replace to="/" />} path="/login" />
      <Route element={<Navigate replace to="/" />} path="/signup" />
      <Route element={<GithubConnecting />} path="/auth/github" />
      <Route element={<Forbidden />} path="/403" />
      <Route element={<AdminLogin />} path="/admin/login" />

      <Route element={<ProtectedRoute />}>
        <Route element={<AppLayout />}>
          <Route element={<Dashboard />} path="/dashboard" />
          <Route element={<Projects />} path="/projects" />
          <Route element={<Billing />} path="/billing" />
          <Route element={<ProjectDetails />} path="/projects/:projectId" />
          <Route element={<ProjectPipeline />} path="/projects/:projectId/pipeline" />
          <Route element={<ProjectInfrastructure />} path="/projects/:projectId/infrastructure" />
          <Route element={<ProjectMetrics />} path="/projects/:projectId/monitoring" />
          {/* Historical bookmarks resolve to the current owning surface. */}
          <Route element={<LegacyProjectRedirect section="/settings" />} path="/projects/:projectId/environment" />
          <Route element={<LegacyProjectRedirect section="/settings" />} path="/projects/:projectId/env" />
          <Route element={<ProjectSettings />} path="/projects/:projectId/settings" />
          <Route element={<LegacyProjectRedirect section="/infrastructure" />} path="/projects/:projectId/costs" />
          <Route element={<ProjectTroubleshooting />} path="/projects/:projectId/troubleshooting" />
          <Route element={<LegacyProjectRedirect section="/infrastructure" />} path="/projects/:projectId/state-management" />
          <Route element={<LegacyProjectRedirect section="/infrastructure" />} path="/projects/:projectId/storage" />
          <Route element={<LegacyProjectRedirect section="/infrastructure" />} path="/projects/:projectId/orchestration" />
          <Route element={<LegacyProjectRedirect section="/pipeline" />} path="/projects/:projectId/rollback" />
          <Route element={<LegacyProjectRedirect section="/pipeline" />} path="/projects/:projectId/releases" />
          <Route element={<LegacyProjectRedirect section="/settings" />} path="/projects/:projectId/requirements/*" />
          <Route element={<LegacyProjectRedirect section="/pipeline" />} path="/projects/:projectId/logs/*" />
          <Route element={<LegacyProjectRedirect section="/monitoring" />} path="/projects/:projectId/observability/*" />
          <Route element={<LegacyProjectRedirect section="/pipeline" />} path="/projects/:projectId/orchestration/*" />
        </Route>
      </Route>

      <Route element={<RoleProtectedRoute roles={["developer"]} />}>
        <Route element={<AppLayout />}>
          <Route element={<NewProject />} path="/deploy" />
          <Route element={<Navigate replace to="/deploy" />} path="/projects/new" />
        </Route>
      </Route>

      <Route element={<AdminProtectedRoute />}>
        <Route element={<AdminLayout />}>
          <Route element={<AdminUsers />} path="/admin" />
          <Route element={<Navigate replace to="/admin" />} path="/admin/users" />
          <Route element={<Navigate replace to="/admin" />} path="/activity" />
          <Route element={<Navigate replace to="/admin" />} path="/audit-logs" />
        </Route>
      </Route>

      <Route element={<Navigate replace to="/" />} path="*" />
    </Routes></Suspense>
  );
}

function LegacyProjectRedirect({ section = "" }) {
  const { projectId } = useParams();
  return <Navigate replace to={`/projects/${projectId}${section}`} />;
}
