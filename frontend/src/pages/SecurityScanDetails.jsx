import { useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import {
  getProject,
  getSecurityScan,
  getSecurityScanFindings,
} from "../api/projectApi.js";
import ErrorState from "../components/common/ErrorState.jsx";
import LoadingState from "../components/common/LoadingState.jsx";
import RemediationList from "../components/security/RemediationList.jsx";
import SecurityScanSummaryCard from "../components/security/SecurityScanSummaryCard.jsx";
import VulnerabilityFindingsTable from "../components/security/VulnerabilityFindingsTable.jsx";
import VulnerabilitySeverityChart from "../components/security/VulnerabilitySeverityChart.jsx";

export default function SecurityScanDetails() {
  const { projectId, scanId } = useParams();
  const [project, setProject] = useState(null);
  const [scan, setScan] = useState(null);
  const [findings, setFindings] = useState([]);
  const [pagination, setPagination] = useState({ page: 1, totalPages: 1 });
  const [filters, setFilters] = useState({
    severity: "",
    packageName: "",
    vulnerabilityId: "",
    origin: "",
    fixability: "",
    policyAction: "",
    page: 1,
    limit: 20,
  });
  const [error, setError] = useState("");
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    loadPage();
  }, [projectId, scanId]);

  useEffect(() => {
    if (scan) {
      loadFindings();
    }
  }, [filters.page]);

  async function loadPage() {
    setError("");
    setIsLoading(true);

    try {
      const [projectResponse, scanResponse] = await Promise.all([
        getProject(projectId),
        getSecurityScan(projectId, scanId),
      ]);
      setProject(projectResponse.project);
      setScan(scanResponse.scan);
      const findingsResponse = await getSecurityScanFindings(projectId, scanId, filters);
      setFindings(findingsResponse.findings || []);
      setPagination(findingsResponse.pagination || { page: 1, totalPages: 1 });
    } catch (caughtError) {
      setError(caughtError.message);
    } finally {
      setIsLoading(false);
    }
  }

  async function loadFindings(nextFilters = filters) {
    setError("");

    try {
      const response = await getSecurityScanFindings(projectId, scanId, nextFilters);
      setFindings(response.findings || []);
      setPagination(response.pagination || { page: 1, totalPages: 1 });
    } catch (caughtError) {
      setError(caughtError.message);
    }
  }

  async function applyFilters(event) {
    event.preventDefault();
    const nextFilters = { ...filters, page: 1 };
    setFilters(nextFilters);
    await loadFindings(nextFilters);
  }

  if (isLoading) {
    return <LoadingState message="Loading security scan..." />;
  }

  if (error && !scan) {
    return <ErrorState message={error} />;
  }

  return (
    <div className="grid">
      <div className="page-header">
        <div>
          <h1>Security Scan Details</h1>
          <p className="muted">{project?.name || "Project"} · {scan.imageUri || scan.imageName}</p>
        </div>
        <div className="quick-actions">
          <Link className="secondary-button" to={`/projects/${projectId}/security`}>
            Security Scans
          </Link>
          <Link className="secondary-button" to={`/projects/${projectId}/pipeline`}>
            Pipeline
          </Link>
        </div>
      </div>

      {error ? <ErrorState message={error} /> : null}

      <div className="state info">This report shows the persisted Trivy image scan and configured policy decision for Run ID {scan.pipelineRunId || "not available"}.</div>

      <div className="grid two-column-grid">
        <SecurityScanSummaryCard scan={scan} />
        <VulnerabilitySeverityChart scan={scan} />
      </div>

      <section className="panel">
        <h2>Filters</h2>
        <form className="filters" onSubmit={applyFilters}>
          <label className="field">
            <span>Severity</span>
            <select
              onChange={(event) =>
                setFilters((current) => ({ ...current, severity: event.target.value }))
              }
              value={filters.severity}
            >
              <option value="">All</option>
              <option value="CRITICAL">Critical</option>
              <option value="HIGH">High</option>
              <option value="MEDIUM">Medium</option>
              <option value="LOW">Low</option>
              <option value="UNKNOWN">Unknown</option>
            </select>
          </label>
          <label className="field">
            <span>Origin</span>
            <select onChange={(event) => setFilters((current) => ({ ...current, origin: event.target.value }))} value={filters.origin}>
              <option value="">All origins</option>
              <option value="app_dependency">Application dependency</option>
              <option value="base_image">Base image</option>
              <option value="os_package">OS package</option>
              <option value="unknown">Unknown</option>
            </select>
          </label>
          <label className="field">
            <span>Fixability</span>
            <select onChange={(event) => setFilters((current) => ({ ...current, fixability: event.target.value }))} value={filters.fixability}>
              <option value="">All findings</option>
              <option value="fix_available">Fix available</option>
              <option value="no_fix_available">No fix available</option>
              <option value="unknown">Unknown</option>
            </select>
          </label>
          <label className="field">
            <span>Package</span>
            <input
              onChange={(event) =>
                setFilters((current) => ({
                  ...current,
                  packageName: event.target.value,
                }))
              }
              value={filters.packageName}
            />
          </label>
          <label className="field">
            <span>CVE</span>
            <input
              onChange={(event) =>
                setFilters((current) => ({
                  ...current,
                  vulnerabilityId: event.target.value,
                }))
              }
              value={filters.vulnerabilityId}
            />
          </label>
          <button className="button" type="submit">
            Apply
          </button>
        </form>
      </section>

      <RemediationList findings={findings} />
      <VulnerabilityFindingsTable findings={findings} />

      <div className="pagination">
        <button
          className="secondary-button"
          disabled={pagination.page <= 1}
          onClick={() =>
            setFilters((current) => ({ ...current, page: current.page - 1 }))
          }
          type="button"
        >
          Previous
        </button>
        <span className="muted">
          Page {pagination.page} of {pagination.totalPages || 1}
        </span>
        <button
          className="secondary-button"
          disabled={pagination.page >= pagination.totalPages}
          onClick={() =>
            setFilters((current) => ({ ...current, page: current.page + 1 }))
          }
          type="button"
        >
          Next
        </button>
      </div>
    </div>
  );
}
