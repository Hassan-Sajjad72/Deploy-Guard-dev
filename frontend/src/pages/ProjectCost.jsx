import { useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import {
  createCostEstimate,
  getCostEstimates,
  getCostSettings,
  getProject,
  updateCostSettings,
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
import CostPolicyBanner from "../components/finops/CostPolicyBanner.jsx";
import CostSettingsForm from "../components/finops/CostSettingsForm.jsx";
import CostSummaryCard from "../components/finops/CostSummaryCard.jsx";
import ProjectModuleStatusStrip from "../components/projects/ProjectModuleStatusStrip.jsx";
import { useToast } from "../hooks/useToast.js";

function formatDate(value) {
  return value
    ? new Intl.DateTimeFormat(undefined, {
        dateStyle: "medium",
        timeStyle: "short",
      }).format(new Date(value))
    : "-";
}

function money(value, currency = "USD") {
  return new Intl.NumberFormat(undefined, {
    currency,
    style: "currency",
  }).format(Number(value || 0));
}

export default function ProjectCost() {
  const { projectId } = useParams();
  const { notify } = useToast();
  const [project, setProject] = useState(null);
  const [estimates, setEstimates] = useState([]);
  const [settings, setSettings] = useState(null);
  const [error, setError] = useState("");
  const [isLoading, setIsLoading] = useState(true);
  const [isGenerating, setIsGenerating] = useState(false);
  const [isSavingSettings, setIsSavingSettings] = useState(false);

  useEffect(() => {
    loadPage();
  }, [projectId]);

  async function loadPage() {
    setError("");
    setIsLoading(true);

    try {
      const [projectResponse, estimatesResponse, settingsResponse] = await Promise.all([
        getProject(projectId),
        getCostEstimates(projectId),
        getCostSettings(projectId),
      ]);
      setProject(projectResponse.project);
      setEstimates(estimatesResponse.estimates || []);
      setSettings(settingsResponse.settings);
    } catch (caughtError) {
      setError(caughtError.message);
    } finally {
      setIsLoading(false);
    }
  }

  async function generateEstimate() {
    setError("");
    setIsGenerating(true);

    try {
      const response = await createCostEstimate(projectId);
      setEstimates((current) => [response.estimate, ...current]);
      notify("Cost estimate generated. Review the source, tier policy, and resource breakdown.", "success");
    } catch (caughtError) {
      setError(caughtError.message);
      notify(caughtError.message, "danger");
    } finally {
      setIsGenerating(false);
    }
  }

  async function saveSettings(nextSettings) {
    setError("");
    setIsSavingSettings(true);

    try {
      const response = await updateCostSettings(projectId, nextSettings);
      setSettings(response.settings);
    } catch (caughtError) {
      setError(caughtError.message);
    } finally {
      setIsSavingSettings(false);
    }
  }

  if (isLoading) {
    return <LoadingState message="Loading cost analysis..." />;
  }

  if (error && !project) {
    return <ErrorState message={error} />;
  }

  const latestEstimate = estimates[0] || null;

  return (
    <div className="grid">
      <PageHeader
        eyebrow="FinOps"
        title="Cost Gate"
        description={`${project?.name || "Project"} monthly AWS estimate, tier limits, policy result, and resource breakdown.`}
      />

      <ProjectModuleStatusStrip moduleKey="finops" projectId={projectId} />

      {error ? <ErrorState message={error} /> : null}
      <CostPolicyBanner estimate={latestEstimate} />
      <BentoGrid>
        <MetricCard
          label="Monthly Estimate"
          value={latestEstimate ? money(latestEstimate.totalMonthlyCost, latestEstimate.currency) : "-"}
          detail={latestEstimate?.source || "Generate an estimate to populate this gate"}
          tone={latestEstimate ? "success" : "neutral"}
        />
        <MetricCard
          label="Policy Result"
          value={latestEstimate?.status?.replaceAll("_", " ") || "Not generated"}
          detail={latestEstimate?.blockedReason || "Blocking policy results are resolved through settings and automation retry"}
        />
        <MetricCard
          label="Tier Limit"
          value={settings?.monthlyLimit ? money(settings.monthlyLimit, latestEstimate?.currency) : "-"}
          detail={settings?.subscriptionTier || latestEstimate?.subscriptionTier || "No tier loaded"}
        />
      </BentoGrid>
      <CostSummaryCard estimate={latestEstimate} />
      {project?.canManage ? <CollapsiblePanel summary="Manual cost tools"><div className="panel"><p className="muted">The deployment pipeline normally generates cost estimates automatically after Terraform plan.</p><button className="secondary-button" disabled={isGenerating} onClick={generateEstimate} type="button">{isGenerating ? "Generating..." : "Generate Cost Estimate"}</button></div></CollapsiblePanel> : null}
      <CostSettingsForm
        canManage={Boolean(project?.canManage)}
        isSaving={isSavingSettings}
        onSave={saveSettings}
        settings={settings}
      />

      {estimates.length === 0 ? (
        <EmptyState message="No cost estimates have been generated yet." />
      ) : null}

      <section className="panel">
        <h2>Estimate History</h2>
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Status</th>
                <th>Source</th>
                <th>Total</th>
                <th>Tier</th>
                <th>Pipeline Run</th>
                <th>Created</th>
              </tr>
            </thead>
            <tbody>
              {estimates.map((estimate) => (
                <tr key={estimate.id}>
                  <td>
                    <Link
                      className="ghost-button"
                      to={`/projects/${projectId}/costs/${estimate.id}`}
                    >
                      {estimate.status?.replaceAll("_", " ")}
                    </Link>
                  </td>
                  <td>{estimate.source}</td>
                  <td>{money(estimate.totalMonthlyCost, estimate.currency)}</td>
                  <td>{estimate.subscriptionTier}</td>
                  <td className="wrap-cell">{estimate.pipelineRunId || "-"}</td>
                  <td>{formatDate(estimate.createdAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}
