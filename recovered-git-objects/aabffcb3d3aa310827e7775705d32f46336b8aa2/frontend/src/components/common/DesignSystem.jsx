import { Link } from "react-router-dom";
import AppIcon from "./AppIcon.jsx";
import { StatusBadge } from "./Premium.jsx";

export function Button({ children, className = "", href, to, tone = "primary", ...props }) {
  const classes = `ds-button ds-button-${tone} ${className}`.trim();
  if (to) return <Link className={classes} to={to} {...props}>{children}</Link>;
  if (href) return <a className={classes} href={href} {...props}>{children}</a>;
  return <button className={classes} type="button" {...props}>{children}</button>;
}

export function Card({ children, className = "", tone = "default", ...props }) {
  return <section className={`ds-card ds-card-${tone} ${className}`.trim()} {...props}>{children}</section>;
}

export function StatusChip(props) {
  return <StatusBadge {...props} />;
}

export function Modal({ children, labelledBy, onClose }) {
  return <div className="ds-modal-backdrop" onMouseDown={(event) => event.target === event.currentTarget && onClose?.()}>
    <section aria-labelledby={labelledBy} aria-modal="true" className="ds-modal" role="dialog">{children}</section>
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

export function StageRail({ phases = [] }) {
  return <ol aria-label="Deployment phases" className="ds-stage-rail">
    {phases.map((phase) => <li className={`is-${phase.status}`} data-phase={phase.key} data-status={phase.status} key={phase.key}>
      <span aria-hidden="true">{phase.status === "passed" ? <AppIcon name="check" size={12} /> : null}</span>
      <small>{phase.label}</small>
    </li>)}
  </ol>;
}
