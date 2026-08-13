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

function statusTone(status) {
  const value = String(status || "").toLowerCase().replaceAll("-", "_").replaceAll(" ", "_");
  if (["failed", "failure", "failed_application", "error", "rejected", "blocked", "unhealthy"].includes(value)) return "danger";
  if (["warning", "pending", "queued", "waiting", "stale", "historical", "configuration_required", "platform_attention", "unavailable"].includes(value)) return "warning";
  if (["success", "passed", "completed", "live", "healthy", "ready", "destroyed"].includes(value)) return "success";
  if (["running", "preparing", "building", "deploying", "verifying", "destroying", "active"].includes(value)) return "info";
  return "neutral";
}

function useDialogFocus(onClose) {
  const dialogRef = useRef(null);
  useEffect(() => {
    const previous = document.activeElement;
    const timer = window.setTimeout(() => dialogRef.current?.focus(), 0);
    function onKeyDown(event) {
      if (event.key === "Escape") onClose?.();
    }
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.clearTimeout(timer);
      window.removeEventListener("keydown", onKeyDown);
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
  return <section className={`ds-card ds-card-${tone} ${className}`.trim()} {...props}>{children}</section>;
}

export function MetricCard({ detail, label, tone = "neutral", value }) {
  return <section className={`metric-card ds-metric-card tone-${tone}`}>
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

export function Modal({ children, labelledBy, onClose }) {
  const dialogRef = useDialogFocus(onClose);
  return <div className="ds-modal-backdrop" onMouseDown={(event) => event.target === event.currentTarget && onClose?.()}>
    <section aria-labelledby={labelledBy} aria-modal="true" className="ds-modal" ref={dialogRef} role="dialog" tabIndex={-1}>{children}</section>
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

export function Tabs({ activeId, items, label = "Sections", onChange }) {
  const id = useId();
  return <div aria-label={label} className="ds-tabs" role="tablist">
    {items.map((item) => <button aria-controls={`${id}-${item.id}`} aria-selected={activeId === item.id} className={activeId === item.id ? "is-active" : ""} key={item.id} onClick={() => onChange(item.id)} role="tab" type="button">{item.icon ? <AppIcon name={item.icon} size={16} /> : null}{item.label}</button>)}
  </div>;
}

export function DetailsDrawer({ children, labelledBy, onClose, title }) {
  const dialogRef = useDialogFocus(onClose);
  return <div className="ds-drawer-backdrop" onMouseDown={(event) => event.target === event.currentTarget && onClose?.()}>
    <aside aria-labelledby={labelledBy} aria-modal="true" className="ds-details-drawer" ref={dialogRef} role="dialog" tabIndex={-1}>
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
