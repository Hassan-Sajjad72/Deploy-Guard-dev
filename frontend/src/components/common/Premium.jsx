import { Link } from "react-router-dom";

export function formatStatus(value) {
  if (!value) return "Unknown";
  return String(value)
    .replaceAll("_", " ")
    .replaceAll("-", " ")
    .replace(/\b\w/g, (letter) => letter.toUpperCase());
}

export function statusTone(status) {
  const normalized = String(status || "").toLowerCase().replaceAll("-", "_").replaceAll(" ", "_");
  const danger = new Set(["failed", "failure", "error", "rejected", "cost_rejected", "blocked", "blocked_by_cost_limit", "unhealthy", "corrupt", "orphaned", "state_recovery_required", "state_lock_failed", "storage_failed", "backup_failed", "ecs_service_unhealthy", "ecs_deployment_failed", "rollback_failed"]);
  const warning = new Set(["paused", "cancelled", "queued", "waiting", "pending", "warning", "requires_approval", "approval_required", "disabled", "disabled_by_config", "safe_mode", "interrupted", "waiting_for_cost_approval", "waiting_for_state_lock"]);
  const success = new Set(["success", "passed", "complete", "completed", "deployed", "healthy", "approved", "connected", "matched", "ready", "ready_to_start_pipeline", "no_approval_required", "skipped"]);
  const info = new Set(["running", "started", "planning", "provisioning", "deploying", "active", "ready_for_detection", "ready_for_preflight", "cost_analysis_running", "state_lock_acquiring", "storage_provisioning", "backup_configuring", "ecs_deployment_queued", "ecs_task_definition_registering", "ecs_service_updating", "ecs_waiting_for_stability", "rollback_started"]);
  if (danger.has(normalized)) return "danger";
  if (warning.has(normalized)) return "warning";
  if (success.has(normalized)) return "success";
  if (info.has(normalized)) return "info";
  return "neutral";
}

export function StatusBadge({ children, status, tone }) {
  const resolvedTone = tone || statusTone(status || children);
  return (
    <span className={`status-badge tone-${resolvedTone}`}>
      <span aria-hidden="true" className="status-dot" />
      {children || formatStatus(status)}
    </span>
  );
}

export function PageHeader({ actions, eyebrow, title, description, status, context }) {
  return (
    <div className="page-header premium-page-header">
      <div className="page-heading">
        {eyebrow ? <p className="eyebrow">{eyebrow}</p> : null}
        <div className="header-title-row">
          <h1>{title}</h1>
          {status ? <StatusBadge status={status} /> : null}
        </div>
        {description ? <p className="muted">{description}</p> : null}
        {context ? <p className="page-context">{context}</p> : null}
      </div>
      {actions ? <div className="quick-actions">{actions}</div> : null}
    </div>
  );
}

export function BentoGrid({ children, className = "" }) {
  return <div className={`bento-grid ${className}`}>{children}</div>;
}

export function MetricCard({ label, value, detail, tone = "neutral" }) {
  return (
    <section className={`metric-card tone-${tone}`}>
      <span className="metric-label">{label}</span>
      <strong>{value ?? "-"}</strong>
      {detail ? <p>{detail}</p> : null}
    </section>
  );
}

export function ReadinessCard({ actionTo, detail, label, status, tone }) {
  const content = (
    <>
      <div className="readiness-marker" aria-hidden="true" />
      <div>
        <div className="readiness-title-row">
          <h3>{label}</h3>
          <StatusBadge status={status} tone={tone} />
        </div>
        {detail ? <p>{detail}</p> : null}
      </div>
    </>
  );

  if (actionTo) {
    return (
      <Link className="readiness-card interactive-link" to={actionTo}>
        {content}
      </Link>
    );
  }

  return <section className="readiness-card">{content}</section>;
}

export function NextActionCard({ action, reason, to }) {
  const inner = (
    <>
      <p className="eyebrow">Next Action</p>
      <h2>{action}</h2>
      <p>{reason}</p>
    </>
  );

  return to ? (
    <Link className="next-action-card interactive-link" to={to}>
      {inner}
    </Link>
  ) : (
    <section className="next-action-card">{inner}</section>
  );
}

export function DeploymentFlowMap({ stages = [] }) {
  return (
    <ol className="deployment-flow-map" aria-label="Deployment lifecycle">
      {stages.map((stage, index) => (
        <li className={`flow-stage status-${stage.status}`} key={stage.stage}>
          <span className="flow-stage-number">{index + 1}</span>
          <div>
            <div className="flow-stage-title">
              <strong>{stage.label}</strong>
              <StatusBadge status={stage.status} />
            </div>
            <p>{stage.message}</p>
            {stage.blockedReason ? <small>Blocked by {formatStatus(stage.blockedByStage)}: {stage.blockedReason}</small> : null}
          </div>
        </li>
      ))}
    </ol>
  );
}

export function RecentActivityTimeline({ activity = [] }) {
  return (
    <ol className="timeline compact-timeline">
      {activity.map((event) => (
        <li className={`timeline-item event-${event.status}`} key={event.id}>
          <div>
            <div className="timeline-title-row">
              <strong>{formatStatus(event.stage)}</strong>
              <StatusBadge status={event.status} />
            </div>
            <p>{event.message}</p>
          </div>
          <time className="muted">{formatDateTime(event.createdAt)}</time>
        </li>
      ))}
      {!activity.length ? <li className="timeline-item"><p>No meaningful pipeline activity has been recorded yet.</p></li> : null}
    </ol>
  );
}

export function SafeModeBanner({ children }) {
  return (
    <section className="config-banner safe-mode-banner">
      <div>
        <p className="eyebrow">Safe Mode Active</p>
        <h2>Terraform apply is controlled by the backend gate.</h2>
        <p>
          {children ||
            "The pipeline can validate, build, scan, estimate, and plan until the apply gate allows real AWS provisioning."}
        </p>
      </div>
    </section>
  );
}

export function FlowStrip({ steps }) {
  return (
    <ol className="flow-strip" aria-label="Deployment flow">
      {steps.map((step) => (
        <li key={step}>{step}</li>
      ))}
    </ol>
  );
}

export function CollapsiblePanel({ children, summary = "Advanced Diagnostics" }) {
  return (
    <details className="collapsible-panel">
      <summary>{summary}</summary>
      <div>{children}</div>
    </details>
  );
}

function formatDateTime(value) {
  return value
    ? new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(new Date(value))
    : "-";
}
