import { Link } from "react-router-dom";
import AppIcon from "../common/AppIcon.jsx";

export default function CurrentStateAction({ action, isPending = false, onExecute, title = "Next action" }) {
  if (!action) return null;

  const canExecute = action.enabled && action.type !== "none";
  const control = canExecute && onExecute
    ? <button aria-label={action.label} className="button" disabled={isPending} onClick={onExecute} type="button"><AppIcon name="arrow" size={15} />{isPending ? "Working…" : action.label}</button>
    : canExecute && action.href
      ? <Link className="button" to={action.href}><AppIcon name="arrow" size={15} />{action.label}</Link>
      : null;

  return (
    <section className="current-state-action panel-flat">
      <p className="eyebrow">{title}</p>
      <h2>{action.label}</h2>
      <p>{action.description || action.message}</p>
      {control}
      {!canExecute && action.disabledReason ? <p className="action-disabled-reason" role="status">{action.disabledReason}</p> : null}
    </section>
  );
}
