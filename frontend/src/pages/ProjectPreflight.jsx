import { useEffect, useState } from "react";
import { useParams } from "react-router-dom";
import {
  generatePreflightReport,
  getPreflightReport,
  getProject,
} from "../api/projectApi.js";
import EmptyState from "../components/common/EmptyState.jsx";
import ErrorState from "../components/common/ErrorState.jsx";
import LoadingState from "../components/common/LoadingState.jsx";
import { PageHeader } from "../components/common/Premium.jsx";
import PreflightReportPanel from "../components/projects/PreflightReportPanel.jsx";

export default function ProjectPreflight() {
  const { projectId } = useParams();
  const [report, setReport] = useState(null);
  const [canManage, setCanManage] = useState(false);
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
      const projectResponse = await getProject(projectId);
      setCanManage(Boolean(projectResponse.project.canManage));

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
        title="Deployment Validation"
        description="Review generated Dockerfile details, commands, ports, environment safety, and validation gates before a run."
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
      {!report && !error ? (
        <EmptyState message="No pre-flight report has been generated yet." />
      ) : null}
      {report ? <PreflightReportPanel report={report} /> : null}
    </div>
  );
}
