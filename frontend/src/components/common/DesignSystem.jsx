import { useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Link } from "react-router-dom";
import AppIcon from "./AppIcon.jsx";

function humanize(value) {
  if (!value) return "Unknown";
  const words = String(value).replaceAll("_", " ").replaceAll("-", " ").toLowerCase();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

const TONE_CLASS = { success: "ok", ok: "ok", danger: "bad", bad: "bad", warning: "warn", warn: "warn", info: "info", neutral: "neutral" };
const toneClass = (tone) => `tone-${TONE_CLASS[tone] || "neutral"}`;

/** Maps any backend status word to a tone. Unknown words are neutral, never "success". */
export function statusTone(status) {
  const value = String(status || "").toLowerCase().replaceAll("-", "_").replaceAll(" ", "_");
  if (["failed", "failure", "failed_application", "error", "rejected", "cost_rejected", "blocked", "blocked_by_cost_limit", "unhealthy", "corrupt", "orphaned", "state_recovery_required", "state_lock_failed", "storage_failed", "backup_failed", "ecs_service_unhealthy", "ecs_deployment_failed", "rollback_failed", "dispatch_failed", "failed_permanent"].includes(value)) return "danger";
  if (["warning", "degraded", "pending", "queued", "waiting", "stale", "historical", "configuration_required", "platform_attention", "paused", "requires_approval", "approval_required", "safe_mode", "interrupted", "waiting_for_cost_approval", "waiting_for_state_lock", "pending_confirmation", "reconnecting", "retrying"].includes(value)) return "warning";
  if (["success", "succeeded", "paid", "passed", "complete", "completed", "live", "deployed", "healthy", "approved", "connected", "matched", "ready", "ready_to_start_pipeline", "no_approval_required", "available", "configured", "confirmed", "published", "active", "enabled"].includes(value)) return "success";
  if (["running", "started", "preparing", "building", "planning", "provisioning", "deploying", "verifying", "destroying", "connecting", "ready_for_detection", "ready_for_preflight", "cost_analysis_running", "state_lock_acquiring", "storage_provisioning", "backup_configuring", "ecs_deployment_queued", "ecs_task_definition_registering", "ecs_service_updating", "ecs_waiting_for_stability", "rollback_started"].includes(value)) return "info";
  return "neutral";
}

/* ---------- Focus management for dialogs and drawers ---------- */
export function useDialogFocus(onClose, { active = true } = {}) {
  const dialogRef = useRef(null);
  const onCloseRef = useRef(onClose);
  const previousFocusRef = useRef(null);
  onCloseRef.current = onClose;
  if (active && previousFocusRef.current === null && typeof document !== "undefined") previousFocusRef.current = document.activeElement;
  useEffect(() => {
    if (!active || typeof document === "undefined") return undefined;
    const previous = previousFocusRef.current;
    const bodyOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const focusableSelector = "a[href], button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex='-1'])";
    const timer = window.setTimeout(() => {
      const dialog = dialogRef.current;
      const initial = dialog?.querySelector("[autofocus]") || dialog?.querySelector(focusableSelector) || dialog;
      initial?.focus();
    }, 0);
    function onKeyDown(event) {
      if (event.key === "Escape") { event.preventDefault(); onCloseRef.current?.(); }
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
      previousFocusRef.current = null;
    };
  }, [active]);
  return dialogRef;
}

/* ---------- Actions ---------- */
const BUTTON_TONES = { primary: "btn-primary", secondary: "", ghost: "btn-ghost", danger: "btn-danger", "danger-solid": "btn-danger-solid", link: "btn-link" };

export function Button({ children, className = "", href, to, tone = "secondary", size, icon, external = false, ...props }) {
  const classes = ["btn", BUTTON_TONES[tone] ?? "", size === "sm" ? "btn-sm" : "", className].filter(Boolean).join(" ");
  const content = <>{icon ? <AppIcon name={icon} size={16} /> : null}{children}{external ? <AppIcon className="external" name="external" size={14} /> : null}</>;
  if (to) return <Link className={classes} to={to} {...props}>{content}</Link>;
  if (href) return <a className={classes} href={href} {...(external ? { rel: "noreferrer", target: "_blank" } : {})} {...props}>{content}</a>;
  return <button className={classes} type="button" {...props}>{content}</button>;
}

/** Overflow menu for secondary actions. Items: { label, onSelect, to, href, danger, disabled, title }. */
export function ActionMenu({ items = [], label = "More actions" }) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef(null);
  const menuId = useId();
  useEffect(() => {
    if (!open) return undefined;
    const onPointer = (event) => { if (!rootRef.current?.contains(event.target)) setOpen(false); };
    const onKey = (event) => { if (event.key === "Escape") { setOpen(false); rootRef.current?.querySelector("button")?.focus(); } };
    document.addEventListener("pointerdown", onPointer);
    document.addEventListener("keydown", onKey);
    window.requestAnimationFrame(() => rootRef.current?.querySelector('[role="menuitem"]:not(:disabled)')?.focus());
    return () => { document.removeEventListener("pointerdown", onPointer); document.removeEventListener("keydown", onKey); };
  }, [open]);
  const visible = items.filter(Boolean);
  if (!visible.length) return null;
  function onMenuKey(event) {
    if (!["ArrowDown", "ArrowUp"].includes(event.key)) return;
    event.preventDefault();
    const entries = [...rootRef.current.querySelectorAll('[role="menuitem"]:not(:disabled)')];
    const index = entries.indexOf(document.activeElement);
    entries[(index + (event.key === "ArrowDown" ? 1 : -1) + entries.length) % entries.length]?.focus();
  }
  return <div className="menu-root" ref={rootRef}>
    <button aria-controls={menuId} aria-expanded={open} aria-haspopup="menu" aria-label={label} className="btn btn-icon" onClick={() => setOpen((value) => !value)} title={label} type="button"><AppIcon name="more" size={18} /></button>
    {open ? <div className="menu" id={menuId} onKeyDown={onMenuKey} role="menu">
      {visible.map((item) => item.separator ? <div className="menu-sep" key={item.key || "sep"} role="separator" /> : item.to
        ? <Link className={item.danger ? "menu-danger" : ""} key={item.label} onClick={() => setOpen(false)} role="menuitem" to={item.to}>{item.icon ? <AppIcon name={item.icon} size={16} /> : null}{item.label}</Link>
        : <button className={item.danger ? "menu-danger" : ""} disabled={item.disabled} key={item.label} onClick={() => { setOpen(false); item.onSelect?.(); }} role="menuitem" title={item.title} type="button">{item.icon ? <AppIcon name={item.icon} size={16} /> : null}{item.label}</button>)}
    </div> : null}
  </div>;
}

/* ---------- Status ---------- */
/** Dot + label. Colour is never the only signal: the label always names the state. */
export function Status({ children, tone = "neutral", active = false, className = "" }) {
  return <span className={`status ${toneClass(tone)}${active ? " is-active" : ""} ${className}`.trim()}>{children}</span>;
}

export function Badge({ children, tone = "neutral" }) {
  return <span className={`badge ${toneClass(tone)}`}>{children}</span>;
}

/** Status word from the backend rendered as a status line. */
export function StatusChip({ children, status, tone }) {
  const resolvedTone = tone || statusTone(status || children);
  const label = typeof children === "string" ? humanize(children) : children || humanize(status);
  return <Status active={resolvedTone === "info"} tone={resolvedTone}>{label}</Status>;
}

/* ---------- Layout ---------- */
export function PageHeader({ actions, description, title, meta, titleAddon }) {
  return <header className="page-head">
    <div>
      <h1>{title}{titleAddon}</h1>
      {description ? <p className="page-sub">{description}</p> : null}
      {meta ? <div className="page-meta">{meta}</div> : null}
    </div>
    {actions ? <div className="page-actions">{actions}</div> : null}
  </header>;
}

export function Section({ title, count, description, actions, children, className = "", id }) {
  const headingId = id || undefined;
  return <section aria-labelledby={headingId} className={`section ${className}`.trim()}>
    {title ? <div className="section-head">
      <div><h2 id={headingId}>{title}{count !== undefined ? <span className="count">{count}</span> : null}</h2>{description ? <p>{description}</p> : null}</div>
      {actions ? <div className="actions">{actions}</div> : null}
    </div> : null}
    {children}
  </section>;
}

export function Card({ children, className = "", padded = true, ...props }) {
  return <section className={`panel${padded ? " panel-pad" : ""} ${className}`.trim()} {...props}>{children}</section>;
}

/* ---------- Feedback ---------- */
const CALLOUT_ICON = { ok: "check-circle", bad: "alert", warn: "alert", info: "info", neutral: "info" };
export function Callout({ children, tone = "info", title, actions, icon, role }) {
  const key = TONE_CLASS[tone] || "info";
  return <div className={`callout ${toneClass(tone)}`} role={role || (key === "bad" ? "alert" : key === "ok" ? "status" : undefined)}>
    <AppIcon name={icon || CALLOUT_ICON[key]} size={18} />
    <div>{title ? <strong>{title}</strong> : null}{children}{actions ? <div className="actions">{actions}</div> : null}</div>
  </div>;
}
export const Banner = Callout;

export function Skeleton({ lines = 4, label = "Loading" }) {
  return <div aria-busy="true" aria-label={label} className="skeleton" role="status">
    {Array.from({ length: lines }, (_, index) => <span key={index} />)}
  </div>;
}

export function EmptyState({ action, icon = "box", message, title = "Nothing here yet", compact = false }) {
  return <div className={`empty${compact ? " empty-compact" : ""}`}>
    <span aria-hidden="true" className="empty-icon"><AppIcon name={icon} size={20} /></span>
    <h2>{title}</h2>
    {message ? <p>{message}</p> : null}
    {action ? <div className="actions">{action}</div> : null}
  </div>;
}

/* ---------- Data ---------- */
export function DataTable({ caption, children, className = "", label = "Data table", stack = true }) {
  return <div aria-label={label} className={`table-wrap${stack ? " table-stack" : ""} ${className}`.trim()} role="region" tabIndex={0}>
    <table className="table">
      {caption ? <caption className="sr-only">{caption}</caption> : null}
      {children}
    </table>
  </div>;
}

export function CopyValue({ label = "Copy", value, visibleValue }) {
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
  return <span className="copy" title={String(value || "")}>
    <span className="copy-text">{visibleValue || value || "—"}</span>
    {value ? <button aria-label={copied ? "Copied" : `${label}: ${value}`} onClick={() => void copy()} type="button">{copied ? "Copied" : "Copy"}</button> : null}
  </span>;
}

export function Disclosure({ summary, meta, children, open, className = "" }) {
  return <details className={`disclosure ${className}`.trim()} open={open}>
    <summary>{summary}{meta ? <span className="summary-meta">{meta}</span> : null}</summary>
    <div className="disclosure-body">{children}</div>
  </details>;
}

export function Tabs({ activeId, idPrefix, items, label = "Sections", onChange }) {
  const generatedId = useId().replaceAll(":", "");
  const id = idPrefix || `tabs-${generatedId}`;
  const tabsRef = useRef(null);
  function handleKeyDown(event) {
    if (!["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home", "End"].includes(event.key)) return;
    event.preventDefault();
    const current = items.findIndex((item) => item.id === activeId);
    const forward = ["ArrowRight", "ArrowDown"].includes(event.key);
    const next = event.key === "Home" ? 0 : event.key === "End" ? items.length - 1 : forward ? (current + 1) % items.length : (current - 1 + items.length) % items.length;
    onChange(items[next].id);
    window.requestAnimationFrame(() => tabsRef.current?.querySelector(`[data-tab-id="${items[next].id}"]`)?.focus());
  }
  return <div aria-label={label} className="tabs" ref={tabsRef} role="tablist">
    {items.map((item) => <button aria-controls={`${id}-panel-${item.id}`} aria-selected={activeId === item.id} className={item.danger ? "is-danger" : ""} data-tab-id={item.id} id={`${id}-tab-${item.id}`} key={item.id} onClick={() => onChange(item.id)} onKeyDown={handleKeyDown} role="tab" tabIndex={activeId === item.id ? 0 : -1} type="button">{item.label}</button>)}
  </div>;
}

/* ---------- Overlays ---------- */
export function Modal({ children, className = "", labelledBy, onClose, wide = false }) {
  const dialogRef = useDialogFocus(onClose);
  if (typeof document === "undefined") return null;
  return createPortal(<div className="overlay" onMouseDown={(event) => event.target === event.currentTarget && onClose?.()}>
    <section aria-labelledby={labelledBy} aria-modal="true" className={`dialog${wide ? " dialog-wide" : ""} ${className}`.trim()} ref={dialogRef} role="dialog" tabIndex={-1}>{children}</section>
  </div>, document.body);
}

/** A destructive confirmation that requires typing an exact phrase. */
export function ConfirmPhraseDialog({ title, children, phrase, confirmLabel, busyLabel, busy = false, error, onConfirm, onClose, id = "confirm-dialog" }) {
  const [value, setValue] = useState("");
  const matches = value === phrase;
  return <Modal labelledBy={`${id}-title`} onClose={() => { if (!busy) onClose(); }}>
    <h2 id={`${id}-title`}>{title}</h2>
    {children}
    <label className="field"><span>Type <span className="mono">{phrase}</span> to confirm</span><input autoComplete="off" autoFocus onChange={(event) => setValue(event.target.value)} spellCheck={false} value={value} /></label>
    {error ? <Callout tone="danger">{error}</Callout> : null}
    <div className="dialog-actions"><Button disabled={busy} onClick={onClose} tone="ghost">Cancel</Button><Button aria-busy={busy || undefined} disabled={busy || !matches} onClick={() => onConfirm(value)} tone="danger-solid">{busy ? busyLabel || confirmLabel : confirmLabel}</Button></div>
  </Modal>;
}

export function ViewportPortal({ children }) {
  if (typeof document === "undefined") return null;
  return createPortal(children, document.body);
}

export function DetailsDrawer({ children, labelledBy, onClose, title }) {
  const dialogRef = useDialogFocus(onClose);
  if (typeof document === "undefined") return null;
  return createPortal(<div className="overlay overlay-drawer" onMouseDown={(event) => event.target === event.currentTarget && onClose?.()}>
    <aside aria-labelledby={labelledBy} aria-modal="true" className="drawer" ref={dialogRef} role="dialog" tabIndex={-1}>
      <header className="drawer-head"><h2 id={labelledBy}>{title}</h2><Button aria-label="Close details" onClick={onClose} tone="ghost" size="sm"><AppIcon name="close" size={16} /></Button></header>
      <div className="drawer-body">{children}</div>
    </aside>
  </div>, document.body);
}
