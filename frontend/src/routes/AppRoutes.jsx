import { Navigate, Route, Routes, useParams } from "react-router-dom";
import AppLayout from "../components/layout/AppLayout.jsx";
import AdminUsers from "../pages/AdminUsers.jsx";
import Forbidden from "../pages/Forbidden.jsx";
import GithubConnecting from "../pages/GithubConnecting.jsx";
import Landing from "../pages/Landing.jsx";
import NewProject from "../pages/NewProject.jsx";
import ProjectDetails from "../pages/ProjectDetails.jsx";
import ProjectInfrastructure from "../pages/ProjectInfrastructure.jsx";
import ProjectMetrics from "../pages/ProjectMetrics.jsx";
import ProjectPipeline from "../pages/ProjectPipeline.jsx";
import ProjectSettings from "../pages/ProjectSettings.jsx";
import ProjectTroubleshooting from "../pages/ProjectTroubleshooting.jsx";
import Projects from "../pages/Projects.jsx";
import ProtectedRoute from "./ProtectedRoute.jsx";
import RoleProtectedRoute from "./RoleProtectedRoute.jsx";
import AdminProtectedRoute from "./AdminProtectedRoute.jsx";
import AdminLayout from "../components/layout/AdminLayout.jsx";
import AdminLogin from "../pages/AdminLogin.jsx";
import About from "../pages/About.jsx";
import Dashboard from "../pages/Dashboard.jsx";

export default function AppRoutes() {
  return (
    <Routes>
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
          <Route element={<ProjectDetails />} path="/projects/:projectId" />
          <Route element={<ProjectPipeline />} path="/projects/:projectId/pipeline" />
          <Route element={<ProjectInfrastructure />} path="/projects/:projectId/infrastructure" />
          <Route element={<ProjectMetrics />} path="/projects/:projectId/monitoring" />
          {/* Retired URLs resolve to the normal project page. */}
          <Route element={<LegacyProjectRedirect />} path="/projects/:projectId/environment" />
          <Route element={<LegacyProjectRedirect />} path="/projects/:projectId/env" />
          <Route element={<ProjectSettings />} path="/projects/:projectId/settings" />
          <Route element={<LegacyProjectRedirect section="/infrastructure" />} path="/projects/:projectId/costs" />
          <Route element={<ProjectTroubleshooting />} path="/projects/:projectId/troubleshooting" />
          <Route element={<LegacyProjectRedirect />} path="/projects/:projectId/state-management" />
          <Route element={<LegacyProjectRedirect section="/infrastructure" />} path="/projects/:projectId/storage" />
          <Route element={<LegacyProjectRedirect />} path="/projects/:projectId/orchestration" />
          <Route element={<LegacyProjectRedirect />} path="/projects/:projectId/rollback" />
          <Route element={<LegacyProjectRedirect />} path="/projects/:projectId/releases" />
          <Route element={<LegacyProjectRedirect />} path="/projects/:projectId/requirements/*" />
          <Route element={<LegacyProjectRedirect section="/pipeline" />} path="/projects/:projectId/logs/*" />
          <Route element={<LegacyProjectRedirect section="/infrastructure" />} path="/projects/:projectId/costs/*" />
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
    </Routes>
  );
}

function LegacyProjectRedirect({ section = "" }) {
  const { projectId } = useParams();
  return <Navigate replace to={`/projects/${projectId}${section}`} />;
}
