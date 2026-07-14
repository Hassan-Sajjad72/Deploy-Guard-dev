import { Navigate, Route, Routes } from "react-router-dom";
import AppLayout from "../components/layout/AppLayout.jsx";
import AdminUsers from "../pages/AdminUsers.jsx";
import AuditLogs from "../pages/AuditLogs.jsx";
import Dashboard from "../pages/Dashboard.jsx";
import Forbidden from "../pages/Forbidden.jsx";
import GithubConnecting from "../pages/GithubConnecting.jsx";
import Landing from "../pages/Landing.jsx";
import NewProject from "../pages/NewProject.jsx";
import CostEstimateDetails from "../pages/CostEstimateDetails.jsx";
import ProjectCost from "../pages/ProjectCost.jsx";
import ProjectDetection from "../pages/ProjectDetection.jsx";
import ProjectDetails from "../pages/ProjectDetails.jsx";
import ProjectEnvVars from "../pages/ProjectEnvVars.jsx";
import ProjectInfrastructure from "../pages/ProjectInfrastructure.jsx";
import ProjectPipeline from "../pages/ProjectPipeline.jsx";
import ProjectPipelineLogs from "../pages/ProjectPipelineLogs.jsx";
import ProjectPreflight from "../pages/ProjectPreflight.jsx";
import ProjectOrchestration from "../pages/ProjectOrchestration.jsx";
import ProjectLogs from "../pages/ProjectLogs.jsx";
import ProjectMetrics from "../pages/ProjectMetrics.jsx";
import ProjectObservability from "../pages/ProjectObservability.jsx";
import ProjectReleases from "../pages/ProjectReleases.jsx";
import ProjectRollback from "../pages/ProjectRollback.jsx";
import ProjectSecurity from "../pages/ProjectSecurity.jsx";
import ProjectSettings from "../pages/ProjectSettings.jsx";
import ProjectStateManagement from "../pages/ProjectStateManagement.jsx";
import ProjectStorage from "../pages/ProjectStorage.jsx";
import Projects from "../pages/Projects.jsx";
import SecurityScanDetails from "../pages/SecurityScanDetails.jsx";
import ProtectedRoute from "./ProtectedRoute.jsx";
import RoleProtectedRoute from "./RoleProtectedRoute.jsx";
import DeveloperModeOnly from "./DeveloperModeOnly.jsx";

export default function AppRoutes() {
  return (
    <Routes>
      <Route element={<Landing />} path="/" />
      <Route element={<Navigate replace to="/" />} path="/login" />
      <Route element={<Navigate replace to="/" />} path="/signup" />
      <Route element={<GithubConnecting />} path="/auth/github" />
      <Route element={<Forbidden />} path="/403" />

      <Route element={<ProtectedRoute />}>
        <Route element={<AppLayout />}>
          <Route element={<Dashboard />} path="/dashboard" />
          <Route element={<DeveloperModeOnly><AuditLogs /></DeveloperModeOnly>} path="/audit-logs" />
          <Route element={<Projects />} path="/projects" />
          <Route element={<ProjectDetails />} path="/projects/:projectId" />
          <Route element={<DeveloperModeOnly><ProjectDetection /></DeveloperModeOnly>} path="/projects/:projectId/detection" />
          <Route element={<ProjectPipeline />} path="/projects/:projectId/pipeline" />
          <Route element={<ProjectPipelineLogs />} path="/projects/:projectId/logs" />
          <Route element={<DeveloperModeOnly><ProjectInfrastructure /></DeveloperModeOnly>} path="/projects/:projectId/infrastructure" />
          <Route element={<DeveloperModeOnly><ProjectOrchestration /></DeveloperModeOnly>} path="/projects/:projectId/orchestration" />
          <Route element={<DeveloperModeOnly><ProjectObservability /></DeveloperModeOnly>} path="/projects/:projectId/observability" />
          <Route element={<DeveloperModeOnly><ProjectLogs /></DeveloperModeOnly>} path="/projects/:projectId/observability/logs" />
          <Route element={<DeveloperModeOnly><ProjectMetrics /></DeveloperModeOnly>} path="/projects/:projectId/observability/metrics" />
          <Route element={<DeveloperModeOnly><ProjectReleases /></DeveloperModeOnly>} path="/projects/:projectId/orchestration/releases" />
          <Route element={<DeveloperModeOnly><ProjectRollback /></DeveloperModeOnly>} path="/projects/:projectId/orchestration/rollback" />
          <Route element={<DeveloperModeOnly><ProjectPreflight /></DeveloperModeOnly>} path="/projects/:projectId/preflight" />
          <Route element={<DeveloperModeOnly><ProjectSecurity /></DeveloperModeOnly>} path="/projects/:projectId/security" />
          <Route element={<DeveloperModeOnly><ProjectStateManagement /></DeveloperModeOnly>} path="/projects/:projectId/state" />
          <Route element={<DeveloperModeOnly><ProjectStorage /></DeveloperModeOnly>} path="/projects/:projectId/storage" />
          <Route element={<DeveloperModeOnly><ProjectCost /></DeveloperModeOnly>} path="/projects/:projectId/costs" />
          <Route
            element={<DeveloperModeOnly><CostEstimateDetails /></DeveloperModeOnly>}
            path="/projects/:projectId/costs/:estimateId"
          />
          <Route
            element={<DeveloperModeOnly><SecurityScanDetails /></DeveloperModeOnly>}
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
          <Route element={<DeveloperModeOnly><AdminUsers /></DeveloperModeOnly>} path="/admin/users" />
        </Route>
      </Route>

      <Route element={<Navigate replace to="/" />} path="*" />
    </Routes>
  );
}
