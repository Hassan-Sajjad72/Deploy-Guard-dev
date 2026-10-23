import { useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import {
  getProject,
  getSecurityScans,
  triggerSecurityScan,
} from "../api/projectApi.js";
import EmptyState from "../components/common/EmptyState.jsx";
import ErrorState from "../components/common/ErrorState.jsx";
import LoadingState from "../components/common/LoadingState.jsx";
import SecurityPolicyDecisionBadge from "../components/security/SecurityPolicyDecisionBadge.jsx";

function formatDate(value) {
  return value
    ? new Intl.DateTimeFormat(undefined, {
        dateStyle: "medium",
        timeStyle: "short",
      }).format(new Date(value))
    : "-";
}

export default function ProjectSecurity() {
  const { projectId } = useParams();
  const [project, setProject] = useState(null);
  const [scans, setScans] = useState([]);
  const [imageName, setImageName] = useState("");
  const [error, setError] = useState("");
  const [isLoading, setIsLoading] = useState(true);
  const [isScanning, setIsScanning] = useState(false);

  useEffect(() => {
    loadPage();
  }, [projectId]);

  async function loadPage() {
    setError("");
    setIsLoading(true);

    try {
      const [projectResponse, scansResponse] = await Promise.all([
        getProject(projectId),
        getSecurityScans(projectId),
      ]);
      setProject(projectResponse.project);
      setScans(scansResponse.scans || []);
    } catch (caughtError) {
      setError(caughtError.message);
    } finally {
      setIsLoading(false);
    }
  }

  async function runScan(event) {
    event.preventDefault();
    setError("");
    setIsScanning(true);

    try {
      const response = await triggerSecurityScan(projectId, {
        imageName: imageName.trim() || undefined,
      });
      setScans((current) => [response.scan, ...current]);
      setImageName("");
    } catch (caughtError) {
      setError(caughtError.message);
    } finally {
      setIsScanning(false);
    }
  }

  if (isLoading) {
    return <LoadingState message="Loading security scans..." />;
  }

  return (
    <div className="grid">
      <div className="page-header">
        <div>
          <h1>Security Scans</h1>
          <p className="muted">{project?.name || "Project"} vulnerability gates.</p>
        </div>
        <div className="quick-actions">
          <Link className="secondary-button" to={`/projects/${projectId}`}>
            Project Details
          </Link>
          <Link className="secondary-button" to={`/projects/${projectId}/pipeline`}>
            Pipeline
          </Link>
        </div>
      </div>

      {error ? <ErrorState message={error} /> : null}

      <section className="panel">
        <div className="page-header">
          <div>
            <h2>Run Security Scan</h2>
            <p className="muted">
              {project?.canManage
                ? "Scan the latest built image or provide a local image tag."
                : "Readonly users can view scan results."}
            </p>
          </div>
        </div>
        {project?.canManage ? (
          <form className="form-stack" onSubmit={runScan}>
            <label className="field">
              <span>Image name</span>
              <input
                onChange={(event) => setImageName(event.target.value)}
                placeholder="mini-paas/app:abc123"
                value={imageName}
              />
            </label>
            <button className="button" disabled={isScanning} type="submit">
              {isScanning ? "Scanning..." : "Run Security Scan"}
            </button>
          </form>
        ) : null}
      </section>

      {scans.length === 0 ? (
        <EmptyState message="No security scans have been recorded yet." />
      ) : null}

      <section className="panel">
        <h2>Scan History</h2>
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Status</th>
                <th>Image</th>
                <th>Critical</th>
                <th>High</th>
                <th>Medium</th>
                <th>Low</th>
                <th>Policy</th>
                <th>Created</th>
              </tr>
            </thead>
            <tbody>
              {scans.map((scan) => (
                <tr key={scan.id}>
                  <td>{scan.scanStatus}</td>
                  <td className="wrap-cell">
                    <Link
                      className="ghost-button"
                      to={`/projects/${projectId}/security/scans/${scan.id}`}
                    >
                      {scan.imageUri || scan.imageName}
                    </Link>
                  </td>
                  <td>{scan.criticalCount}</td>
                  <td>{scan.highCount}</td>
                  <td>{scan.mediumCount}</td>
                  <td>{scan.lowCount}</td>
                  <td>
                    <SecurityPolicyDecisionBadge decision={scan.policyDecision} />
                  </td>
                  <td>{formatDate(scan.createdAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}
