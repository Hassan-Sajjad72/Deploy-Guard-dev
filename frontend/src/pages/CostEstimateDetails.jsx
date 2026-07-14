import { useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import {
  approveCostEstimate,
  getCostEstimate,
  getProject,
  getProjectCurrentState,
  rejectCostEstimate,
} from "../api/projectApi.js";
import ErrorState from "../components/common/ErrorState.jsx";
import LoadingState from "../components/common/LoadingState.jsx";
import CostApprovalPanel from "../components/finops/CostApprovalPanel.jsx";
import CostBreakdownTable from "../components/finops/CostBreakdownTable.jsx";
import CostPolicyBanner from "../components/finops/CostPolicyBanner.jsx";
import CostSummaryCard from "../components/finops/CostSummaryCard.jsx";

export default function CostEstimateDetails() {
  const { projectId, estimateId } = useParams();
  const [project, setProject] = useState(null);
  const [estimate, setEstimate] = useState(null);
  const [manualApprovalsEnabled, setManualApprovalsEnabled] = useState(false);
  const [error, setError] = useState("");
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    loadPage();
  }, [projectId, estimateId]);

  async function loadPage() {
    setError("");
    setIsLoading(true);

    try {
      const [projectResponse, estimateResponse, stateResponse] = await Promise.all([
        getProject(projectId),
        getCostEstimate(projectId, estimateId),
        getProjectCurrentState(projectId),
      ]);
      setProject(projectResponse.project);
      setEstimate(estimateResponse.estimate);
      setManualApprovalsEnabled(Boolean(stateResponse.automationStatus?.manualApprovalsEnabled));
    } catch (caughtError) {
      setError(caughtError.message);
    } finally {
      setIsLoading(false);
    }
  }

  async function approve() {
    const response = await approveCostEstimate(projectId, estimateId);
    setEstimate(response.estimate);
  }

  async function reject(reason) {
    const response = await rejectCostEstimate(projectId, estimateId, reason);
    setEstimate(response.estimate);
  }

  if (isLoading) {
    return <LoadingState message="Loading cost estimate..." />;
  }

  if (error && !estimate) {
    return <ErrorState message={error} />;
  }

  return (
    <div className="grid">
      <div className="page-header">
        <div>
          <h1>Cost Estimate Details</h1>
          <p className="muted">{project?.name || "Project"}</p>
        </div>
        <div className="quick-actions">
          <Link className="secondary-button" to={`/projects/${projectId}/costs`}>
            Cost Analysis
          </Link>
          <Link className="secondary-button" to={`/projects/${projectId}/pipeline`}>
            Pipeline
          </Link>
        </div>
      </div>

      {error ? <ErrorState message={error} /> : null}
      <CostPolicyBanner estimate={estimate} />
      <div className="grid two-column-grid">
        <CostSummaryCard estimate={estimate} />
        {manualApprovalsEnabled ? <CostApprovalPanel
          canManage={Boolean(project?.canManage)}
          estimate={estimate}
          onApprove={approve}
          onReject={reject}
        /> : <section className="panel"><p className="eyebrow">Automated Policy</p><h2>{estimate?.status === "approval_required" ? "Adjust policy and retry" : "No manual action required"}</h2><p className="muted">DeployGuard’s automated flow does not pause for approval clicks. If this estimate blocks the run, update the project cost settings and retry from Pipeline.</p><Link className="secondary-button" to={`/projects/${projectId}/pipeline`}>Open Run Controls</Link></section>}
      </div>
      <CostBreakdownTable
        breakdowns={estimate?.breakdowns || []}
        currency={estimate?.currency || "USD"}
      />
    </div>
  );
}
