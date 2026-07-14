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
import {
  BentoGrid,
  CollapsiblePanel,
  MetricCard,
  PageHeader,
} from "../components/common/Premium.jsx";
import SecurityPolicyDecisionBadge from "../components/security/SecurityPolicyDecisionBadge.jsx";
import ProjectModuleStatusStrip from "../components/projects/ProjectModuleStatusStrip.jsx";

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
  const latestClassification = scans[0]?.rawSummary?.classification || {};
  const latestPolicy = scans[0]?.rawSummary?.policy || {};

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
      <PageHeader
        eyebrow="Security"
        title="Trivy Security Gate"
        description={`${project?.name || "Project"} image vulnerability scan history, severity counts, and policy decisions.`}
      />

      <ProjectModuleStatusStrip moduleKey="security" projectId={projectId} />

      {error ? <ErrorState message={error} /> : null}

      <BentoGrid>
        <MetricCard label="Scans" value={scans.length} detail="Recorded image security scans" />
        <MetricCard
          label="Critical Findings"
          value={scans[0]?.criticalCount ?? "-"}
          detail="Latest scan"
          tone={scans[0]?.criticalCount > 0 ? "danger" : "success"}
        />
        <MetricCard
          label="High Findings"
          value={scans[0]?.highCount ?? "-"}
          detail="Latest scan"
          tone={scans[0]?.highCount > 0 ? "warning" : "success"}
        />
        <MetricCard
          label="Policy"
          value={scans[0]?.policyDecision?.replaceAll("_", " ") || "No scan"}
          detail="Latest policy decision"
        />
        <MetricCard
          label="Application Dependencies"
          value={scans[0] ? (latestClassification.appDependency ?? 0) : "-"}
          detail="Latest scan findings"
        />
        <MetricCard
          label="Base Image / OS"
          value={scans[0] ? (latestClassification.baseImage || 0) + (latestClassification.osPackage || 0) : "-"}
          detail="Warning-only by default"
        />
        <MetricCard
          label="Policy Blockers"
          value={scans[0] ? (latestPolicy.blockingCount ?? 0) : "-"}
          detail="Findings that stop this run"
          tone={latestPolicy.blockingCount > 0 ? "danger" : "success"}
        />
      </BentoGrid>

      {scans[0] ? <section className="panel"><p className="eyebrow">Policy behavior</p><h2>Actionable security gate</h2><p className="muted">Fixable Critical application dependencies block deployment. High, base-image/OS, and no-fix findings are warnings under the recommended default policy; backend configuration can make policy stricter.</p></section> : null}

      <CollapsiblePanel summary="Manual security tools">
      <section className="panel">
        <div className="section-heading">
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
      </CollapsiblePanel>

      {scans.length === 0 ? (
        <EmptyState message="No security scan has run yet. Start a pipeline to build and scan the image with Trivy." />
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
