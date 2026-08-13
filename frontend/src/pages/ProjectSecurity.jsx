import { useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import {
  getProject,
  getProjectDetailedCurrentState,
  getSecurityScans,
} from "../api/projectApi.js";
import EmptyState from "../components/common/EmptyState.jsx";
import ErrorState from "../components/common/ErrorState.jsx";
import LoadingState from "../components/common/LoadingState.jsx";
import {
  BentoGrid,
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
  const [currentState, setCurrentState] = useState(null);
  const [scans, setScans] = useState([]);
  const [error, setError] = useState("");
  const [isLoading, setIsLoading] = useState(true);
  const runId = currentState?.latestPipeline?.id;
  const runScans = runId ? scans.filter((scan) => scan.pipelineRunId === runId) : [];
  const scan = runScans[0] || null;
  const latestClassification = scan?.rawSummary?.classification || {};
  const policy = scan?.rawSummary?.policy || {};
  const securityDeferred = currentState?.environmentModes?.trivyScanEnabled === false;

  useEffect(() => {
    loadPage();
  }, [projectId]);

  async function loadPage() {
    setError("");
    setIsLoading(true);

    try {
      const [projectResponse, stateResponse, scansResponse] = await Promise.all([
        getProject(projectId),
        getProjectDetailedCurrentState(projectId),
        getSecurityScans(projectId),
      ]);
      setProject(projectResponse.project);
      setCurrentState(stateResponse);
      setScans(scansResponse.scans || []);
    } catch (caughtError) {
      setError(caughtError.message);
    } finally {
      setIsLoading(false);
    }
  }

  if (isLoading) {
    return <LoadingState message="Loading security scans..." />;
  }

  return (
    <div className="grid">
      <PageHeader
        eyebrow="Security"
        title="Container Security"
        description={securityDeferred
          ? `${project?.name || "Project"} image scanning is disabled and deferred for the current deployment-verification phase.`
          : `${project?.name || "Project"} Dockerfile checks and the persisted Trivy result for the latest pipeline run.`}
      />

      <ProjectModuleStatusStrip moduleKey="security" projectId={projectId} />

      {error ? <ErrorState message={error} /> : null}

      <BentoGrid>
        <MetricCard label="Result" value={securityDeferred ? "Deferred" : !scan ? "No scan" : scan.scanStatus === "completed" ? scan.policyDecision?.replaceAll("_", " ") || "completed" : scan.scanStatus} detail={securityDeferred ? "No scan result has been fabricated" : runId ? `Run ID ${runId}` : "No pipeline run"} />
        <MetricCard
          label="Critical Findings"
          value={scan?.scanStatus === "completed" ? scan.criticalCount : "No data"}
          detail="Latest run scan"
          tone={scan?.criticalCount > 0 ? "danger" : "neutral"}
        />
        <MetricCard
          label="High Findings"
          value={scan?.scanStatus === "completed" ? scan.highCount : "No data"}
          detail="Latest run scan"
          tone={scan?.highCount > 0 ? "warning" : "neutral"}
        />
        <MetricCard
          label="Medium / Low"
          value={scan?.scanStatus === "completed" ? `${scan.mediumCount} / ${scan.lowCount}` : "No data"}
          detail="Persisted severity counts"
        />
        <MetricCard
          label="Application Dependencies"
          value={scan?.scanStatus === "completed" ? (latestClassification.appDependency ?? "No data") : "No data"}
          detail="Latest scan findings"
        />
        <MetricCard
          label="Base Image / OS"
          value={scan?.scanStatus === "completed" && latestClassification.baseImage !== undefined && latestClassification.osPackage !== undefined ? latestClassification.baseImage + latestClassification.osPackage : "No data"}
          detail="Latest scan findings"
        />
        <MetricCard
          label="Deployment blockers"
          value={scan?.scanStatus === "completed" ? (policy.blockingCount ?? "No data") : "No data"}
          detail="Configured policy matches"
          tone={policy.blockingCount > 0 ? "danger" : "neutral"}
        />
      </BentoGrid>

      {scan ? <section className="panel"><p className="eyebrow">Policy decision</p><h2><SecurityPolicyDecisionBadge decision={scan.policyDecision} /></h2><p>{scan.policyReason || "No blocking reason was recorded."}</p><p className="muted">Dockerfile configuration was checked before build; this Trivy result was produced from the image built by the same Run ID.</p><Link className="secondary-button" to={`/projects/${projectId}/security/scans/${scan.id}`}>View findings and remediation</Link></section> : null}

      {!scan ? (
        <EmptyState message={securityDeferred
          ? "Image security scanning is disabled and deferred for this verification phase."
          : "No security scan has run yet. Start a deployment to build and scan the image with Trivy."} />
      ) : null}

      {runScans.length ? <section className="panel">
        <h2>Latest Run Security Evidence</h2>
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
              {runScans.map((scan) => (
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
      </section> : null}
    </div>
  );
}
