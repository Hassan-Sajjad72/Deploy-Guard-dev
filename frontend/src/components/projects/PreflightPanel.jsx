import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import {
  generatePreflightReport,
  getPreflightReport,
} from "../../api/projectApi.js";
import ErrorState from "../common/ErrorState.jsx";
import { publishProjectStateChanged } from "../../utils/projectStateSync.js";

export default function PreflightPanel({ canManage, projectId }) {
  const [report, setReport] = useState(null);
  const [error, setError] = useState("");
  const [isGenerating, setIsGenerating] = useState(false);

  useEffect(() => {
    async function loadReport() {
      try {
        const response = await getPreflightReport(projectId);
        setReport(response.report);
      } catch {
        setReport(null);
      }
    }

    loadReport();
  }, [projectId]);

  async function generateReport() {
    setError("");
    setIsGenerating(true);

    try {
      const response = await generatePreflightReport(projectId);
      setReport(response.report);
      publishProjectStateChanged(projectId);
    } catch (caughtError) {
      setError(caughtError.message);
    } finally {
      setIsGenerating(false);
    }
  }

  return (
    <section className="panel">
      <div className="page-header">
        <div>
          <p className="eyebrow">Pre-flight Gate</p>
          <h2>Pre-flight Validation</h2>
          <p className="muted">
            {report ? `Latest result: ${String(report.validationStatus).replaceAll("_", " ")}` : "No pre-flight report has been generated. Detection must complete before validation."}
          </p>
        </div>
        <div className="quick-actions">
          <Link className="secondary-button" to={`/projects/${projectId}/preflight`}>
            View Report
          </Link>
          {canManage ? (
            <button
              className="secondary-button"
              disabled={isGenerating}
              onClick={generateReport}
              type="button"
            >
              {isGenerating ? "Generating..." : "Generate Pre-flight Report"}
            </button>
          ) : null}
        </div>
      </div>
      {error ? <ErrorState message={error} /> : null}
    </section>
  );
}
