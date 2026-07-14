import { Link } from "react-router-dom";
import AppIcon from "../common/AppIcon.jsx";
import { StatusBadge, formatStatus } from "../common/Premium.jsx";

export default function DeploymentRecoveryCenter({
  compact = false,
  currentState,
  isHistorical = false,
  isPending = false,
  onCancel,
  onRetry,
  projectId,
  selectedRun,
}) {
  const latest = selectedRun || currentState?.latestPipeline;
  const status = currentState?.overallStatus === "paused"
    ? "paused"
    : latest?.status === "cancelled"
      ? "cancelled"
      : currentState?.overallStatus || latest?.status || "failed";
  const isPaused = status === "paused";
  const stage = currentState?.failedStage || currentState?.blockedBy?.stage || currentState?.currentStep || latest?.currentStage;
  const reason = currentState?.blockedBy?.userMessage || currentState?.userFacingStatus || latest?.errorMessage || "The run stopped before deployment completed.";
  const technicalError = latest?.failureMessage || latest?.errorMessage || currentState?.blockedBy?.reason;
  const hasRun = Boolean(latest?.id);
  const recoveryHref = hasRun ? `/projects/${projectId}/pipeline` : currentState?.nextAction?.enabled ? currentState.nextAction.href : null;
  const nextAction = currentState?.nextAction;
  const actionIsCurrentPipeline = nextAction?.href === `/projects/${projectId}/pipeline`;
  const actionHref = actionIsCurrentPipeline ? `/projects/${projectId}/pipeline` : nextAction?.href;

  if (compact) {
    return (
      <section className={`recovery-summary-card panel-flat ${isPaused ? "recovery-paused" : ""}`}>
        <div className="run-recovery-heading"><span className="recovery-icon">{isPaused ? "Ⅱ" : "!"}</span><StatusBadge status={status} /></div>
        <div><p className="eyebrow">{isPaused ? "Deployment paused" : "Deployment recovery"}</p><h2>{isPaused ? "Paused safely" : stage ? `${formatStatus(stage)} needs attention` : "Run needs attention"}</h2><p className="recovery-summary-reason">{reason}</p></div>
        <div className="run-recovery-actions">
          {recoveryHref ? <Link className="button" to={recoveryHref}>{hasRun ? "Open Pipeline" : currentState?.nextAction?.label || "Continue"}<AppIcon name="arrow" size={14} /></Link> : null}
        </div>
      </section>
    );
  }

  const canRetry = !isHistorical && (currentState?.runControls?.canRetry || latest?.canRetry) && onRetry;
  const canCancel = !isHistorical && (currentState?.runControls?.canCancel || latest?.canCancel) && onCancel;
  const showPrimaryAction = !isHistorical && nextAction?.enabled && nextAction.type !== "none" && actionHref && !(canRetry && nextAction.type === "start_pipeline");

  return (
    <section className={`deployment-recovery-center panel-flat ${isPaused ? "recovery-paused" : ""}`}>
      <div className="run-recovery-heading"><span className="recovery-icon">{isPaused ? "Ⅱ" : "!"}</span><StatusBadge status={status} /></div>
      <div><p className="eyebrow">{isHistorical ? "Historical run" : isPaused ? "Deployment paused" : "Deployment recovery center"}</p><h2>{isPaused ? "Paused safely" : stage ? `${formatStatus(stage)} needs attention` : "Run needs attention"}</h2><p className="run-recovery-reason">{reason}</p></div>
      {technicalError && technicalError !== reason ? <div className="recovery-log-snippet"><span>Sanitized technical detail</span><code>{technicalError}</code></div> : null}
      {isHistorical ? <p className="developer-note">This previous run is view-only. Return to the latest run to perform recovery actions.</p> : null}
      {!isHistorical && currentState?.nextAction?.disabledReason ? <p className="action-disabled-reason">{currentState.nextAction.disabledReason}</p> : null}
      <div className="run-recovery-actions">
        {showPrimaryAction ? (actionHref.startsWith("#") ? <a className="button" href={actionHref}><AppIcon name="arrow" size={15} />{nextAction.label}</a> : <Link className="button" to={actionHref}><AppIcon name="arrow" size={15} />{nextAction.label}</Link>) : null}
        {canRetry ? <button aria-label="Retry automation as a fresh run" className="button" disabled={isPending} onClick={onRetry} type="button"><AppIcon name="deploy" size={15} />Retry Automation</button> : null}
        {canCancel ? <button aria-label="Cancel this deployment run" className="danger-text-button" disabled={isPending} onClick={onCancel} type="button">Cancel Run</button> : null}
      </div>
    </section>
  );
}
