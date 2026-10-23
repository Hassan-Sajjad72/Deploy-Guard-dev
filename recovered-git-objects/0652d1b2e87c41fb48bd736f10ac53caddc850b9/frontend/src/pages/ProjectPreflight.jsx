import { useEffect, useState } from "react";
import { useParams } from "react-router-dom";
import {
  generatePreflightReport,
  getPreflightReport,
  getProject,
  getProjectCurrentState,
} from "../api/projectApi.js";
import EmptyState from "../components/common/EmptyState.jsx";
import ErrorState from "../components/common/ErrorState.jsx";
import LoadingState from "../components/common/LoadingState.jsx";
import { PageHeader } from "../components/common/Premium.jsx";
import PreflightReportPanel from "../components/projects/PreflightReportPanel.jsx";
import EnvironmentVariablesPanel from "../components/projects/EnvironmentVariablesPanel.jsx";
import DatabaseTierSettings from "../components/projects/DatabaseTierSettings.jsx";

export default function ProjectPreflight() {
  const { projectId } = useParams();
  const [report, setReport] = useState(null);
  const [canManage, setCanManage] = useState(false);
  const [currentState, setCurrentState] = useState(null);
  const [error, setError] = useState("");
  const [isLoading, setIsLoading] = useState(true);
  const [isGenerating, setIsGenerating] = useState(false);

  useEffect(() => {
    loadReport();
  }, [projectId]);

  async function loadReport() {
    setError("");
    setIsLoading(true);

    try {
      const [projectResponse, stateResponse] = await Promise.all([getProject(projectId), getProjectCurrentState(projectId)]);
      setCanManage(Boolean(projectResponse.project.canManage));
      setCurrentState(stateResponse);

      try {
        const reportResponse = await getPreflightReport(projectId);
        setReport(reportResponse.report);
      } catch {
        setReport(null);
      }
    } catch (caughtError) {
      setError(caughtError.message);
    } finally {
      setIsLoading(false);
    }
  }

  async function generateReport() {
    setError("");
    setIsGenerating(true);

    try {
      const response = await generatePreflightReport(projectId);
      setReport(response.report);
    } catch (caughtError) {
      setError(caughtError.message);
    } finally {
      setIsGenerating(false);
    }
  }

  if (isLoading) {
    return <LoadingState message="Loading pre-flight report..." />;
  }

  return (
    <div className="grid">
      <PageHeader
        eyebrow="Pre-flight Gate"
        title="Pre-flight Validation"
        description="Review repository evidence, generated Dockerfile details, commands, ports, environment requirements, and readiness before a run."
        actions={
          canManage ? (
          <button
            className="button"
            disabled={isGenerating}
            onClick={generateReport}
            type="button"
          >
            {isGenerating ? "Generating report..." : "Generate Pre-flight Report"}
          </button>
          ) : null
        }
      />


      {error ? <ErrorState message={error} /> : null}
      {report?.report?.readiness?.decision === "ready" ? <div className="state success"><strong>Ready to deploy.</strong> The deployment contract and required environment variables are valid.</div> : null}
      {!report && !error ? (
        <EmptyState message="No pre-flight report has been generated yet." />
      ) : null}
      {report ? <PreflightReportPanel report={report} /> : null}
      {currentState?.deploymentContract?.databaseRequired ? <DatabaseTierSettings canManage={canManage} detection={currentState} projectId={projectId} /> : null}
      {report?.report?.environmentVariables?.missing?.length ? <EnvironmentVariablesPanel canManage={canManage} onSaved={(updated) => updated && setReport(updated)} projectId={projectId} /> : null}
    </div>
  );
}
