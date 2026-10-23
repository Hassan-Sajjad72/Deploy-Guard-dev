import { Navigate, Route, Routes } from "react-router-dom";
import AppLayout from "../components/layout/AppLayout.jsx";
import AdminUsers from "../pages/AdminUsers.jsx";
import AuditLogs from "../pages/AuditLogs.jsx";
import Dashboard from "../pages/Dashboard.jsx";
import Forbidden from "../pages/Forbidden.jsx";
import Login from "../pages/Login.jsx";
import NewProject from "../pages/NewProject.jsx";
import ProjectDetection from "../pages/ProjectDetection.jsx";
import ProjectDetails from "../pages/ProjectDetails.jsx";
import ProjectEnvVars from "../pages/ProjectEnvVars.jsx";
import ProjectPipeline from "../pages/ProjectPipeline.jsx";
import ProjectPreflight from "../pages/ProjectPreflight.jsx";
import ProjectSecurity from "../pages/ProjectSecurity.jsx";
import ProjectSettings from "../pages/ProjectSettings.jsx";
import Projects from "../pages/Projects.jsx";
import SecurityScanDetails from "../pages/SecurityScanDetails.jsx";
import Signup from "../pages/Signup.jsx";
import ProtectedRoute from "./ProtectedRoute.jsx";
import RoleProtectedRoute from "./RoleProtectedRoute.jsx";

export default function AppRoutes() {
  return (
    <Routes>
      <Route element={<Navigate replace to="/dashboard" />} path="/" />
      <Route element={<Login />} path="/login" />
      <Route element={<Signup />} path="/signup" />
      <Route element={<Forbidden />} path="/403" />

      <Route element={<ProtectedRoute />}>
        <Route element={<AppLayout />}>
          <Route element={<Dashboard />} path="/dashboard" />
          <Route element={<AuditLogs />} path="/audit-logs" />
          <Route element={<Projects />} path="/projects" />
          <Route element={<ProjectDetails />} path="/projects/:projectId" />
          <Route element={<ProjectDetection />} path="/projects/:projectId/detection" />
          <Route element={<ProjectPipeline />} path="/projects/:projectId/pipeline" />
          <Route element={<ProjectPreflight />} path="/projects/:projectId/preflight" />
          <Route element={<ProjectSecurity />} path="/projects/:projectId/security" />
          <Route
            element={<SecurityScanDetails />}
            path="/projects/:projectId/security/scans/:scanId"
          />
          <Route element={<ProjectSettings />} path="/projects/:projectId/settings" />
          <Route element={<ProjectEnvVars />} path="/projects/:projectId/env" />
        </Route>
      </Route>

      <Route element={<RoleProtectedRoute roles={["admin", "developer"]} />}>
        <Route element={<AppLayout />}>
          <Route element={<NewProject />} path="/projects/new" />
        </Route>
      </Route>

      <Route element={<RoleProtectedRoute roles={["admin"]} />}>
        <Route element={<AppLayout />}>
          <Route element={<AdminUsers />} path="/admin/users" />
        </Route>
      </Route>

      <Route element={<Navigate replace to="/dashboard" />} path="*" />
    </Routes>
  );
}
