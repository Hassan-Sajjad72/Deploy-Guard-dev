import { Navigate, Route, Routes } from "react-router-dom";
import AppLayout from "../components/layout/AppLayout.jsx";
import AdminUsers from "../pages/AdminUsers.jsx";
import AuditLogs from "../pages/AuditLogs.jsx";
import Dashboard from "../pages/Dashboard.jsx";
import Forbidden from "../pages/Forbidden.jsx";
import GithubConnecting from "../pages/GithubConnecting.jsx";
import Landing from "../pages/Landing.jsx";
import Login from "../pages/Login.jsx";
import Signup from "../pages/Signup.jsx";
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
import Billing from "../pages/Billing.jsx";
import ProjectTroubleshooting from "../pages/ProjectTroubleshooting.jsx";
import BillingErrorBoundary from "../components/common/BillingErrorBoundary.jsx";
import ProjectSettingsErrorBoundary from "../components/common/ProjectSettingsErrorBoundary.jsx";
import AdminCloudCleanup from "../pages/AdminCloudCleanup.jsx";
import ProjectRecovery from "../pages/ProjectRecovery.jsx";
import DeploymentRequirements from "../pages/DeploymentRequirements.jsx";
import ProjectEnvironmentRoute from "./ProjectEnvironmentRoute.jsx";

export default function AppRoutes() {
  return (
    <Routes>
      <Route element={<Landing />} path="/" />
      <Route element={<Login />} path="/login" />
      <Route element={<Signup />} path="/signup" />
      <Route element={<GithubConnecting />} path="/auth/github" />
      <Route element={<Forbidden />} path="/403" />

      <Route element={<ProtectedRoute />}>
        <Route element={<AppLayout />}>
          <Route element={<Dashboard />} path="/dashboard" />
          <Route element={<AuditLogs />} path="/activity" />
          <Route element={<Navigate replace to="/activity" />} path="/audit-logs" />
          <Route element={<Projects />} path="/projects" />
          <Route element={<BillingErrorBoundary><Billing /></BillingErrorBoundary>} path="/billing" />
          <Route element={<ProjectDetails />} path="/projects/:projectId" />
          <Route element={<ProjectRecovery />} path="/projects/:projectId/recovery" />
          <Route element={<DeploymentRequirements />} path="/projects/:projectId/requirements" />
          <Route element={<ProjectDetection />} path="/projects/:projectId/detection" />
          <Route element={<ProjectPipeline />} path="/projects/:projectId/pipeline" />
          <Route element={<ProjectPipelineLogs />} path="/projects/:projectId/logs" />
          <Route element={<ProjectMetrics />} path="/projects/:projectId/observability/metrics" />
          <Route element={<ProjectPreflight />} path="/projects/:projectId/preflight" />
          <Route element={<ProjectSettingsErrorBoundary><ProjectSettings /></ProjectSettingsErrorBoundary>} path="/projects/:projectId/settings" />
          <Route element={<ProjectEnvironmentRoute><ProjectEnvVars /></ProjectEnvironmentRoute>} path="/projects/:projectId/env" />
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
          <Route element={<AdminCloudCleanup />} path="/admin/cloud-cleanup" />
          <Route element={<ProjectTroubleshooting />} path="/projects/:projectId/troubleshooting" />
          <Route element={<ProjectInfrastructure />} path="/projects/:projectId/infrastructure" />
          <Route element={<ProjectOrchestration />} path="/projects/:projectId/orchestration" />
          <Route element={<ProjectObservability />} path="/projects/:projectId/observability" />
          <Route element={<ProjectLogs />} path="/projects/:projectId/observability/logs" />
          <Route element={<ProjectReleases />} path="/projects/:projectId/orchestration/releases" />
          <Route element={<ProjectRollback />} path="/projects/:projectId/orchestration/rollback" />
          <Route element={<ProjectSecurity />} path="/projects/:projectId/security" />
          <Route element={<ProjectStateManagement />} path="/projects/:projectId/state" />
          <Route element={<ProjectStorage />} path="/projects/:projectId/storage" />
          <Route element={<ProjectCost />} path="/projects/:projectId/costs" />
          <Route element={<CostEstimateDetails />} path="/projects/:projectId/costs/:estimateId" />
          <Route element={<SecurityScanDetails />} path="/projects/:projectId/security/scans/:scanId" />
        </Route>
      </Route>

      <Route element={<Navigate replace to="/" />} path="*" />
    </Routes>
  );
}
