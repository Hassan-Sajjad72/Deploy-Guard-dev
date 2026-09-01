import { useRef, useState } from "react";
import AppIcon from "../common/AppIcon.jsx";
import {
  Button,
  Card,
  ChartCard,
  DataTable,
  DetailsDrawer,
  StatusChip,
} from "../common/DesignSystem.jsx";
import ErrorState from "../common/ErrorState.jsx";
import { retryGithubActionsDeployment } from "../../api/projectApi.js";
import { useToast } from "../../hooks/useToast.js";

function date(value) {
  return value ? new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(new Date(value)) : "Unavailable";
}

function compactDate(value) {
  return value ? new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }).format(new Date(value)).replace(",", " ·") : "Unavailable";
}

function duration(startedAt, endedAt) {
  if (!startedAt || !endedAt) return "Unavailable";
  const milliseconds = Math.max(0, new Date(endedAt).getTime() - new Date(startedAt).getTime());
  if (milliseconds < 1_000) return "Under 1 second";
  const seconds = Math.round(milliseconds / 1_000);
  return seconds < 60 ? `${seconds} seconds` : `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}

function operationEnd(operation) {
  return operation?.completedAt || operation?.failedAt || null;
}

function stageDurationLabel(stage) {
  return stage.status === "skipped" ? "Not run" : stage.status === "pending" ? "Not started" : duration(stage.startedAt, stage.completedAt || new Date().toISOString());
}

function resultLabel(operation) {
  if (operation?.deploymentAction === "destroy" && operation?.destroyVerificationStatus === "pending") return "Verification pending";
  const value = String(operation?.status || "").toLowerCase();
  if (value === "completed") return "Succeeded";
  if (value === "failed") return "Failed";
  if (value === "dispatch_failed") return "Dispatch failed";
  if (value === "running") return "Running";
  if (value === "queued") return "Queued";
  return operation?.status ? String(operation.status).replaceAll("_", " ") : "Unavailable";
}

function stageIcon(stage) {
  if (/aws|oidc/i.test(stage?.key)) return "shield";
  if (/checkout|release/i.test(stage?.key)) return "github";
  if (/image|docker|ecr/i.test(stage?.key)) return "box";
  if (/terraform|destroy/i.test(stage?.key)) return "infrastructure";
  if (/health|result/i.test(stage?.key)) return "activity";
  return "pipeline";
}

function compactCommit(value) {
  return value ? String(value).slice(0, 12) : "Unavailable";
}

function operationType(operation) {
  if (operation?.deploymentAction === "destroy") return "Destroy";
  if (operation?.deploymentAction === "rollback") return "Rollback";
  return "Deploy";
}

/**
 * Technical execution belongs here, not on Overview. Its stage list is the
 * read-only GitHub Actions job evidence returned for each operation.
 */
export default function PipelineExecution({ canManage = false, currentState, onRefresh, operations = [], projectId }) {
  const { notify } = useToast();
  const retrying = useRef(false);
  const [retryBusy, setRetryBusy] = useState(false);
  const [error, setError] = useState("");
  const [details, setDetails] = useState(null);
  const latest = operations[0] || null;
  const stages = latest?.workflowStages || [];
  const timedStages = stages.filter((stage) => stage.status !== "skipped" && Number.isFinite(stage.durationMs) && stage.durationMs > 0);
  const longestStage = Math.max(1, ...timedStages.map((stage) => stage.durationMs));
  const latestFailed = latest?.status === "failed";

  async function retry() {
    if (!canManage || !currentState.canRetry || !latestFailed || retrying.current) return;
    retrying.current = true;
    setRetryBusy(true);
    setError("");
    try {
      const response = await retryGithubActionsDeployment(projectId);
      await onRefresh();
      const rejected = response.deployment?.state === "rejected";
      if (rejected) setError(response.deployment?.message || "Retry was recorded but not dispatched.");
      notify(response.deployment?.message || "Retry dispatched to GitHub Actions.", rejected ? "danger" : "success");
    } catch (caught) {
      setError(caught.message);
    } finally {
      retrying.current = false;
      setRetryBusy(false);
    }
  }

  return <div className="pipeline-execution" data-pipeline-execution="true">
    <Card className="pipeline-identity-card" aria-label="Deployment execution summary"><div><p className="eyebrow">Latest deployment</p><h2>{latest ? `Attempt ${latest.attempt}` : "Not started"}</h2><p>{latest ? `${compactCommit(latest.commitSha || currentState.commit)} · ${currentState.branch || "Branch unavailable"}` : "No deployment request has been made."}</p></div><StatusChip status={latest?.destroyVerificationStatus === "pending" ? "warning" : latest?.status}>{resultLabel(latest)}</StatusChip>{latest ? <dl><div><dt>Operation</dt><dd>{operationType(latest)}</dd></div><div><dt>Duration</dt><dd>{duration(latest.createdAt, operationEnd(latest))}</dd></div><div><dt>Completed</dt><dd>{compactDate(operationEnd(latest) || latest.createdAt)}</dd></div></dl> : null}</Card>

    {error ? <ErrorState message={error} onRetry={() => void retry()} /> : null}

    <Card className="pipeline-timeline-card">
      <div className="pipeline-section-heading"><div><p className="eyebrow">GitHub Actions execution</p><h2>Technical pipeline timeline</h2><p>Only stages returned by the selected GitHub Actions run are shown. Expand a stage for its recorded evidence.</p></div>{latest?.workflowUrl ? <Button href={latest.workflowUrl} rel="noreferrer" target="_blank" tone="secondary">Open GitHub Actions</Button> : null}</div>
      {latest?.dispatchFailure ? <p className="pipeline-unavailable"><strong>GitHub Actions run was not created.</strong> DeployGuard stopped during dispatch: {latest.errorMessage || "The persisted dispatch failure has no additional safe detail."}</p> : stages.length ? <ol aria-label="GitHub Actions workflow stages" className="pipeline-stage-timeline">
        {stages.map((stage) => <li className={`pipeline-stage-row is-${stage.status}`} key={`${stage.key}-${stage.startedAt || "pending"}`}>
          <span aria-hidden="true" className="pipeline-stage-icon"><AppIcon name={stageIcon(stage)} size={18} /></span>
          <div className="pipeline-stage-main"><div className="pipeline-stage-title"><strong>{stage.label}</strong><StatusChip status={stage.status} /></div><p>{stageDurationLabel(stage)}</p></div>
          <div className="pipeline-stage-times"><span>Started {date(stage.startedAt)}</span><span>Completed {date(stage.completedAt)}</span></div>
          <details className="pipeline-stage-evidence"><summary>Evidence</summary><p>Source: GitHub Actions workflow job.</p>{stage.jobUrl ? <a href={stage.jobUrl} rel="noreferrer" target="_blank">Open GitHub Actions job</a> : null}{stage.failureReason ? <p className="pipeline-stage-failure">{stage.failureReason}</p> : null}</details>
        </li>)}
      </ol> : <p className="pipeline-unavailable">{latest ? "GitHub Actions step metadata has not been collected yet. The operation status and run link remain available." : "No deployment request has been made yet."}</p>}
      {latest ? <details className="pipeline-advanced"><summary>Advanced run details</summary><dl><div><dt>GitHub Actions run</dt><dd>{latest.workflowRunId || "Unavailable"}</dd></div><div><dt>Workflow status</dt><dd>{latest.workflowStatus || "Unavailable"}</dd></div><div><dt>Operation identifier</dt><dd>{latest.id}</dd></div></dl></details> : null}
      {latestFailed && canManage && currentState.canRetry ? <div className="pipeline-retry-action"><Button disabled={retryBusy} onClick={() => void retry()}>{retryBusy ? "Retrying…" : `Retry failed ${operationType(latest).toLowerCase()}`}</Button></div> : null}
    </Card>

    {timedStages.length ? <ChartCard description="Stage duration from GitHub Actions timestamps." hasData title="Where deployment time was spent">
      <ol aria-label="GitHub Actions stage durations" className="pipeline-duration-chart">{timedStages.map((stage) => <li key={`${stage.key}-${stage.startedAt || "timing"}`}><div><span>{stage.label}</span><strong>{duration(stage.startedAt, stage.completedAt)}</strong></div><span className="pipeline-duration-bar"><i style={{ width: `${Math.max(2, Math.round((stage.durationMs / longestStage) * 100))}%` }} /></span></li>)}</ol>
    </ChartCard> : null}

    <Card className="pipeline-history-card"><div className="pipeline-section-heading"><div><p className="eyebrow">Attempt history</p><h2>Deployment attempts</h2><p>Each row is a persisted DeployGuard operation. Retry lineage is retained, including failures before GitHub creates a run.</p></div></div>
      <DataTable caption="Deployment attempt history" className="responsive-record-table" label="Deployment attempt history"><thead><tr><th>Attempt</th><th>Generation</th><th>Type</th><th>Result</th><th>Commit</th><th>Duration</th><th>Time</th><th aria-label="Details" /></tr></thead><tbody>{operations.map((operation) => <tr key={operation.id}><td data-label="Attempt">Attempt {operation.attempt}{operation.retryOfOperationId ? <small className="pipeline-retry-lineage">Retry</small> : null}</td><td data-label="Generation" title={operation.generationId || ""}>{compactCommit(operation.generationId)}</td><td data-label="Type">{operationType(operation)}</td><td data-label="Result"><StatusChip status={operation.destroyVerificationStatus === "pending" ? "warning" : operation.status}>{resultLabel(operation)}</StatusChip></td><td data-label="Commit" title={operation.commitSha || ""}>{compactCommit(operation.commitSha)}</td><td data-label="Duration">{duration(operation.createdAt, operationEnd(operation))}</td><td data-label="Time">{date(operation.createdAt)}</td><td data-label="Details"><Button onClick={() => setDetails(operation)} tone="ghost">Details</Button></td></tr>)}{!operations.length ? <tr><td colSpan="8">No deployment request has been made yet.</td></tr> : null}</tbody></DataTable>
    </Card>

    {details ? <DetailsDrawer labelledBy="pipeline-attempt-details" onClose={() => setDetails(null)} title={`Attempt ${details.attempt} details`}><dl className="pipeline-attempt-details"><div><dt>Generation</dt><dd>{details.generationId || "Not created — deployment failed before runtime generation."}</dd></div><div><dt>Type</dt><dd>{operationType(details)}</dd></div><div><dt>Result</dt><dd>{resultLabel(details)}</dd></div><div><dt>Stage</dt><dd>{details.stageLabel || "Unavailable"}</dd></div>{details.dispatchFailure ? <div><dt>GitHub Actions run</dt><dd>Not created</dd></div> : null}{details.errorMessage ? <div><dt>Safe failure reason</dt><dd>{details.errorMessage}</dd></div> : null}{details.destroyVerificationStatus === "pending" ? <div><dt>Destroy verification</dt><dd>{details.destroyVerificationUnresolved?.length ? `Unresolved: ${details.destroyVerificationUnresolved.join(", ")}` : "Read-only verification is pending."}</dd></div> : null}<div><dt>Requested</dt><dd>{date(details.createdAt || details.startedAt || details.failedAt)}</dd></div><div><dt>Completed</dt><dd>{date(operationEnd(details))}</dd></div><div><dt>Commit</dt><dd>{details.commitSha || "Unavailable"}</dd></div>{!details.dispatchFailure ? <div><dt>GitHub Actions run</dt><dd>{details.workflowRunId || "Unavailable"}</dd></div> : null}{details.workflowUrl ? <div><dt>Evidence</dt><dd><a href={details.workflowUrl} rel="noreferrer" target="_blank">Open GitHub Actions run</a></dd></div> : null}</dl></DetailsDrawer> : null}
  </div>;
}
