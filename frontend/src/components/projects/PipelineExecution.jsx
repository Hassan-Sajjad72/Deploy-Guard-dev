import { useState } from "react";
import { Link } from "react-router-dom";
import { Button, Callout, DataTable, DetailsDrawer, Disclosure, EmptyState, Status } from "../common/DesignSystem.jsx";
import Time from "../common/Time.jsx";
import { pipelineStageDisplayStatus, pipelineStageDurationEnd } from "../../utils/pipelineStageTiming.js";
import { operationResult, operationTypeLabel } from "../../utils/failurePresentation.js";
import { productText } from "../../utils/productTerms.js";
import { formatDateTime, formatElapsed } from "../../utils/time.js";
import PipelineGraph from "./PipelineGraph.jsx";

function operationEnd(operation) {
  return operation?.completedAt || operation?.failedAt || null;
}

function stageDurationLabel(stage, operation) {
  const displayStatus = pipelineStageDisplayStatus(stage, operation);
  if (displayStatus === "unavailable") return "Not recorded";
  if (stage.status === "skipped") return "Skipped";
  if (stage.status === "pending") return "Waiting";
  return formatElapsed(stage.startedAt, pipelineStageDurationEnd(stage, operation)) || "—";
}

function shortSha(value) {
  return value ? String(value).slice(0, 7) : "—";
}

function isFailed(operation) {
  return ["failed", "dispatch_failed"].includes(operation?.status);
}

/**
 * Deployment attempts and their stage evidence. Diagnosis and recovery live on
 * Troubleshoot and Overview; this view records what ran and links there.
 */
export default function PipelineExecution({ currentState, operations = [], projectId }) {
  const [details, setDetails] = useState(null);
  const latest = operations[0] || null;
  const stages = latest?.workflowStages || [];

  // Before the first request there is no run, graph, or history to show: one empty state replaces three.
  if (!latest) {
    return <EmptyState icon="pipeline" message="Every deployment, rollback and destroy appears here with its stages and logs once it starts." title="No deployments yet" action={<Button to={`/projects/${projectId}`}>Go to overview</Button>} />;
  }

  const result = operationResult(latest);
  const running = ["running", "queued"].includes(String(latest.status).toLowerCase());
  const elapsed = formatElapsed(latest.createdAt, operationEnd(latest) || (running ? new Date().toISOString() : null));

  return <div className="deployments" data-pipeline-execution="true">
    <section aria-labelledby="latest-attempt-title" className="panel latest-run">
      <header className="latest-run-head">
        <div className="latest-run-title">
          <Status active={running} className="status-lg" tone={result.tone}>{result.label}</Status>
          <h2 className="sr-only" id="latest-attempt-title">Latest attempt</h2>
          <p className="latest-run-identity">{operationTypeLabel(latest)} · attempt {latest.attempt} · <span className="mono">{shortSha(latest.commitSha || currentState?.commit)}</span>{currentState?.branch ? <> · {currentState.branch}</> : null}</p>
          <p className="muted latest-run-time">Started <Time value={latest.createdAt} />{elapsed ? <> · {running ? "running for" : "took"} {elapsed}</> : null}</p>
        </div>
        {latest.workflowUrl ? <Button external href={latest.workflowUrl} size="sm">View run on GitHub</Button> : null}
      </header>

      {isFailed(latest) ? <p className="latest-run-note"><strong>{latest.dispatchFailure ? "The run never started." : `Failed during ${productText(latest.failedStageLabel || latest.stageLabel) || "a stage"}.`}</strong><Link className="link" to={`/projects/${projectId}/troubleshooting?operation=${latest.id}`}>See what went wrong</Link></p> : null}

      <div className="latest-run-stages">
        {latest.dispatchFailure ? <p className="muted">GitHub Actions did not create a run, so there are no stages to show.</p>
          : stages.length ? <PipelineGraph durationLabel={(stage) => stageDurationLabel(stage, latest)} operation={latest} stages={stages} />
            : <p className="muted">{latest.workflowStagesUnavailable ? "Step details are temporarily unavailable from GitHub Actions. The result and run link above are still accurate." : "Step details appear once GitHub Actions reports them."}</p>}
      </div>

      <div className="latest-run-advanced">
        <Disclosure summary="Run identifiers">
          <dl className="facts">
            <div><dt>GitHub Actions run</dt><dd className="mono">{latest.workflowRunId || "Not created"}</dd></div>
            <div><dt>Workflow status</dt><dd>{latest.workflowStatus || "—"}</dd></div>
            <div><dt>Operation</dt><dd className="mono">{latest.id}</dd></div>
            <div><dt>Generation</dt><dd className="mono">{latest.generationId || "Not created"}</dd></div>
          </dl>
        </Disclosure>
      </div>
    </section>

    <section aria-labelledby="deployment-history" className="section">
      <div className="section-head"><h2 id="deployment-history">History<span className="count">{operations.length}</span></h2><p>Every attempt is kept, including retries and runs that never started.</p></div>
      <DataTable caption="Deployment history" label="Deployment history">
        <thead><tr><th>Result</th><th>Type</th><th>Attempt</th><th>Commit</th><th>Started</th><th>Duration</th><th><span className="sr-only">Details</span></th></tr></thead>
        <tbody>{operations.map((operation) => {
          const row = operationResult(operation);
          return <tr key={operation.id}>
            <td data-label="Result"><Status active={row.tone === "info"} tone={row.tone}>{row.label}</Status></td>
            <td data-label="Type">{operationTypeLabel(operation)}{operation.retryOfOperationId ? <span className="cell-sub">Retry</span> : null}</td>
            <td data-label="Attempt" className="num">{operation.attempt}</td>
            <td data-label="Commit"><span className="mono" title={operation.commitSha || ""}>{shortSha(operation.commitSha)}</span></td>
            <td data-label="Started"><Time value={operation.createdAt} /></td>
            <td data-label="Duration" className="num">{formatElapsed(operation.createdAt, operationEnd(operation)) || "—"}</td>
            <td className="cell-end" data-label=""><Button onClick={() => setDetails(operation)} size="sm" tone="ghost">Details</Button></td>
          </tr>;
        })}</tbody>
      </DataTable>
    </section>

    {details ? <DetailsDrawer labelledBy="pipeline-attempt-details" onClose={() => setDetails(null)} title={`Attempt ${details.attempt}`}>
      <Status tone={operationResult(details).tone}>{operationResult(details).label}</Status>
      <dl className="facts-list">
        <div><dt>Type</dt><dd>{operationTypeLabel(details)}</dd></div>
        <div><dt>Stage reached</dt><dd>{productText(details.failedStageLabel || details.stageLabel) || "—"}</dd></div>
        <div><dt>Requested</dt><dd>{formatDateTime(details.createdAt || details.startedAt || details.failedAt)}</dd></div>
        <div><dt>Finished</dt><dd>{formatDateTime(operationEnd(details))}</dd></div>
        <div><dt>Commit</dt><dd className="mono">{details.commitSha || "—"}</dd></div>
        <div><dt>Generation</dt><dd className="mono">{details.generationId || "Not created — the attempt stopped before runtime"}</dd></div>
        <div><dt>GitHub Actions run</dt><dd className="mono">{details.dispatchFailure ? "Not created" : details.workflowRunId || "—"}</dd></div>
        {details.destroyVerificationStatus === "pending" ? <div><dt>Deletion check</dt><dd>{details.destroyVerificationUnresolved?.length ? `Still present: ${details.destroyVerificationUnresolved.join(", ")}` : "Verifying that every resource is gone."}</dd></div> : null}
      </dl>
      {details.errorMessage ? <Callout title="Failure reason" tone="danger"><p>{productText(details.errorMessage)}</p></Callout> : null}
      {details.safeLog ? <Disclosure summary="Failure log (sanitized)"><pre className="code">{details.safeLog}</pre></Disclosure> : null}
      <div className="actions">
        {isFailed(details) ? <Button to={`/projects/${projectId}/troubleshooting?operation=${details.id}`}>See what went wrong</Button> : null}
        {details.workflowUrl ? <Button external href={details.workflowUrl} tone="ghost">View run on GitHub</Button> : null}
      </div>
    </DetailsDrawer> : null}
  </div>;
}
