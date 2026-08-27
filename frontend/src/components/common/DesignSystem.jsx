import { useEffect, useId, useRef, useState } from "react";
import { Link } from "react-router-dom";
import AppIcon from "./AppIcon.jsx";

function humanize(value) {
  if (!value) return "Unknown";
  return String(value)
    .replaceAll("_", " ")
    .replaceAll("-", " ")
    .replace(/\b\w/g, (letter) => letter.toUpperCase());
}

export function statusTone(status) {
  const value = String(status || "").toLowerCase().replaceAll("-", "_").replaceAll(" ", "_");
  if (["failed", "failure", "failed_application", "error", "rejected", "cost_rejected", "blocked", "blocked_by_cost_limit", "unhealthy", "corrupt", "orphaned", "state_recovery_required", "state_lock_failed", "storage_failed", "backup_failed", "ecs_service_unhealthy", "ecs_deployment_failed", "rollback_failed"].includes(value)) return "danger";
  if (["warning", "pending", "queued", "waiting", "stale", "historical", "configuration_required", "platform_attention", "unavailable", "paused", "cancelled", "requires_approval", "approval_required", "disabled", "disabled_by_config", "safe_mode", "interrupted", "waiting_for_cost_approval", "waiting_for_state_lock"].includes(value)) return "warning";
  if (["success", "passed", "complete", "completed", "live", "deployed", "healthy", "approved", "connected", "matched", "ready", "destroyed", "ready_to_start_pipeline", "no_approval_required", "skipped"].includes(value)) return "success";
  if (["running", "started", "preparing", "building", "planning", "provisioning", "deploying", "verifying", "destroying", "active", "ready_for_detection", "ready_for_preflight", "cost_analysis_running", "state_lock_acquiring", "storage_provisioning", "backup_configuring", "ecs_deployment_queued", "ecs_task_definition_registering", "ecs_service_updating", "ecs_waiting_for_stability", "rollback_started"].includes(value)) return "info";
  return "neutral";
}

function useDialogFocus(onClose) {
  const dialogRef = useRef(null);
  useEffect(() => {
    const previous = document.activeElement;
    const bodyOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const focusableSelector = "a[href], button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex='-1'])";
    const timer = window.setTimeout(() => {
      const dialog = dialogRef.current;
      const initial = dialog?.querySelector("[autofocus]") || dialog?.querySelector(focusableSelector) || dialog;
      initial?.focus();
    }, 0);
    function onKeyDown(event) {
      if (event.key === "Escape") onClose?.();
      if (event.key !== "Tab" || !dialogRef.current) return;
      const focusable = [...dialogRef.current.querySelectorAll(focusableSelector)].filter((element) => !element.hasAttribute("disabled") && element.getAttribute("aria-hidden") !== "true");
      if (!focusable.length) { event.preventDefault(); dialogRef.current.focus(); return; }
      const first = focusable[0];
      const last = focusable.at(-1);
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    }
    function containFocus(event) { if (dialogRef.current && !dialogRef.current.contains(event.target)) dialogRef.current.focus(); }
    window.addEventListener("keydown", onKeyDown);
    document.addEventListener("focusin", containFocus);
    return () => {
      window.clearTimeout(timer);
      window.removeEventListener("keydown", onKeyDown);
      document.removeEventListener("focusin", containFocus);
      document.body.style.overflow = bodyOverflow;
      previous?.focus?.();
    };
  }, [onClose]);
  return dialogRef;
}

export function Button({ children, className = "", href, to, tone = "primary", ...props }) {
  const classes = `ds-button ds-button-${tone} ${className}`.trim();
  if (to) return <Link className={classes} to={to} {...props}>{children}</Link>;
  if (href) return <a className={classes} href={href} {...props}>{children}</a>;
  return <button className={classes} type="button" {...props}>{children}</button>;
}

export function Card({ children, className = "", tone = "default", ...props }) {
  return <section className={`ds-card glass-surface ds-card-${tone} ${className}`.trim()} {...props}>{children}</section>;
}

export function MetricCard({ detail, label, tone = "neutral", value }) {
  return <section className={`metric-card glass-surface-secondary ds-metric-card tone-${tone}`}>
    <span className="metric-label">{label}</span>
    <strong>{value ?? "—"}</strong>
    {detail ? <p>{detail}</p> : null}
  </section>;
}

export function StatusChip({ children, status, tone }) {
  const resolvedTone = tone || statusTone(status || children);
  return <span className={`status-badge ds-status-chip tone-${resolvedTone}`}>
    <span aria-hidden="true" className="status-dot" />
    {children || humanize(status)}
  </span>;
}

export function PageHeader({ actions, context, description, eyebrow, status, title }) {
  return <header className="page-header premium-page-header ds-page-header">
    <div className="page-heading">
      {eyebrow ? <p className="eyebrow">{eyebrow}</p> : null}
      <div className="header-title-row"><h1>{title}</h1>{status ? <StatusChip status={status} /> : null}</div>
      {description ? <p className="muted">{description}</p> : null}
      {context ? <p className="page-context">{context}</p> : null}
    </div>
    {actions ? <div className="quick-actions">{actions}</div> : null}
  </header>;
}

export function ActionBar({ children, className = "", label = "Available actions" }) {
  return <div aria-label={label} className={`ds-action-bar glass-control-bar ${className}`.trim()} role="group">{children}</div>;
}

export function DataRow({ label, value, technical = false }) {
  return <div className="ds-data-row"><dt>{label}</dt><dd className={technical ? "ds-technical-value" : undefined}>{value ?? "Unavailable"}</dd></div>;
}

export function IssueCard({ action, children, severity = "warning", title }) {
  const icon = severity === "danger" ? "shield" : severity === "success" ? "check" : "activity";
  return <article className={`ds-issue-card tone-${severity}`}>
    <span aria-hidden="true" className="ds-issue-icon"><AppIcon name={icon} size={18} /></span>
    <div className="ds-issue-copy"><div className="ds-issue-heading"><strong>{title}</strong><StatusChip tone={severity}>{severity === "danger" ? "Blocker" : severity === "success" ? "Ready" : "Warning"}</StatusChip></div>{children}{action ? <div className="ds-issue-action">{action}</div> : null}</div>
  </article>;
}

export function ReadinessSummary({ children, level = "blocked", message, requiredInputs = [] }) {
  const tone = level === "ready" ? "success" : level === "warning" ? "warning" : level === "input_required" ? "warning" : "danger";
  const label = level === "warning" ? "READY_WITH_WARNINGS" : level === "ready" ? "READY" : level === "input_required" ? "INPUT_REQUIRED" : "BLOCKED";
  const title = level === "ready" ? "Ready to deploy" : level === "warning" ? "Ready with warnings" : level === "input_required" ? "Configuration required" : "Deployment blocked";
  return <section aria-labelledby="deployment-readiness-title" aria-live="polite" className={`deployment-readiness deployment-readiness-${level} ds-readiness-summary tone-${tone}`}>
    <header className="ds-readiness-heading"><span aria-hidden="true" className="ds-readiness-icon"><AppIcon name={tone === "danger" ? "shield" : tone === "success" ? "check" : "activity"} size={22} /></span><div><p className="eyebrow">Deployment readiness</p><h3 id="deployment-readiness-title">{title}</h3></div><StatusChip tone={tone}>{label}</StatusChip></header>
    <p className="ds-readiness-message">{message}</p>
    {requiredInputs.length ? <div className="ds-required-inputs"><strong>Action required</strong><p>Provide: {requiredInputs.join(", ")}.</p></div> : null}
    {children ? <div className="ds-readiness-content">{children}</div> : null}
  </section>;
}

export function Modal({ children, labelledBy, onClose }) {
  const dialogRef = useDialogFocus(onClose);
  return <div className="ds-modal-backdrop" onMouseDown={(event) => event.target === event.currentTarget && onClose?.()}>
    <section aria-labelledby={labelledBy} aria-modal="true" className="ds-modal glass-modal" ref={dialogRef} role="dialog" tabIndex={-1}>{children}</section>
  </div>;
}

export function Banner({ children, tone = "info", title }) {
  return <section className={`ds-banner ds-banner-${tone}`} role={tone === "danger" ? "alert" : undefined}>
    <AppIcon name={tone === "danger" ? "shield" : tone === "success" ? "check" : "activity"} size={18} />
    <div>{title ? <strong>{title}</strong> : null}{children}</div>
  </section>;
}

export function Skeleton({ lines = 3, label = "Loading" }) {
  return <div aria-label={label} aria-live="polite" className="ds-skeleton" role="status">
    {Array.from({ length: lines }, (_, index) => <span key={index} />)}
  </div>;
}

export function EmptyState({ action, icon = "box", message = "No records are available yet.", title = "Nothing to show yet" }) {
  return <section className="state empty-state ds-empty-state">
    <span aria-hidden="true" className="empty-state-mark"><AppIcon name={icon} size={20} /></span>
    <div><strong>{title}</strong><p>{message}</p>{action ? <div className="empty-state-action">{action}</div> : null}</div>
  </section>;
}

export function DataTable({ caption, children, className = "", label = "Data table" }) {
  return <div aria-label={label} className={`ds-data-table-wrap ${className}`.trim()} tabIndex={0}>
    <table className="ds-data-table">
      {caption ? <caption>{caption}</caption> : null}
      {children}
    </table>
  </div>;
}

export function CopyValue({ label = "Copy value", value, visibleValue }) {
  const [copied, setCopied] = useState(false);
  async function copy() {
    try {
      await navigator.clipboard.writeText(String(value || ""));
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1600);
    } catch {
      setCopied(false);
    }
  }
  return <span className="ds-copy-value" title={String(value || "")}>
    <span className="ds-copy-text">{visibleValue || value || "—"}</span>
    <button aria-label={copied ? "Copied" : label} className="ds-copy-button" disabled={!value} onClick={() => void copy()} type="button">{copied ? "Copied" : "Copy"}</button>
  </span>;
}

export function ChartCard({ children, description, emptyMessage = "No verified numeric series is available.", hasData, title }) {
  return <Card className="ds-chart-card">
    <div className="ds-chart-heading"><div><h2>{title}</h2>{description ? <p>{description}</p> : null}</div></div>
    {hasData ? children : <EmptyState icon="activity" message={emptyMessage} title="Chart unavailable" />}
  </Card>;
}

export function Tabs({ activeId, idPrefix, items, label = "Sections", onChange }) {
  const generatedId = useId().replaceAll(":", "");
  const id = idPrefix || `tabs-${generatedId}`;
  const tabsRef = useRef(null);
  function handleKeyDown(event) {
    if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
    event.preventDefault();
    const current = items.findIndex((item) => item.id === activeId);
    const next = event.key === "Home" ? 0 : event.key === "End" ? items.length - 1 : event.key === "ArrowRight" ? (current + 1) % items.length : (current - 1 + items.length) % items.length;
    onChange(items[next].id);
    window.requestAnimationFrame(() => tabsRef.current?.querySelector(`[data-tab-id="${items[next].id}"]`)?.focus());
  }
  return <div aria-label={label} className="ds-tabs glass-tabs" ref={tabsRef} role="tablist">
    {items.map((item) => <button aria-controls={`${id}-panel-${item.id}`} aria-selected={activeId === item.id} className={activeId === item.id ? "is-active" : ""} data-tab-id={item.id} id={`${id}-tab-${item.id}`} key={item.id} onClick={() => onChange(item.id)} onKeyDown={handleKeyDown} role="tab" tabIndex={activeId === item.id ? 0 : -1} type="button">{item.icon ? <AppIcon name={item.icon} size={16} /> : null}{item.label}</button>)}
  </div>;
}

export function DetailsDrawer({ children, labelledBy, onClose, title }) {
  const dialogRef = useDialogFocus(onClose);
  return <div className="ds-drawer-backdrop" onMouseDown={(event) => event.target === event.currentTarget && onClose?.()}>
    <aside aria-labelledby={labelledBy} aria-modal="true" className="ds-details-drawer glass-modal" ref={dialogRef} role="dialog" tabIndex={-1}>
      <header><h2 id={labelledBy}>{title}</h2><button aria-label="Close details" className="ds-drawer-close" onClick={onClose} type="button">Close</button></header>
      <div className="ds-drawer-body">{children}</div>
    </aside>
  </div>;
}

export function StageRail({ phases = [] }) {
  return <ol aria-label="Deployment phases" className="ds-stage-rail">
    {phases.map((phase) => <li className={`is-${phase.status}`} data-phase={phase.key} data-status={phase.status} key={phase.key}>
      <span aria-hidden="true">{phase.status === "passed" ? <AppIcon name="check" size={12} /> : null}</span>
      <small>{phase.label}</small>
    </li>)}
  </ol>;
}
