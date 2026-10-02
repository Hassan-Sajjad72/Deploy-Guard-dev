import { useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { destroyGithubActionsDeployment } from "../../api/projectApi.js";
import { useToast } from "../../hooks/useToast.js";
import { DESTROY_CONFIRMATION_PHRASE } from "../../utils/deploymentConfirmation.js";
import { overviewLifecycleActions } from "../../utils/overviewLifecyclePresentation.js";
import { Button, ConfirmPhraseDialog } from "../common/DesignSystem.jsx";

/**
 * Destroy is offered exactly when the canonical lifecycle presenter offers it;
 * this component only owns its placement and typed confirmation.
 */
export default function DestroyInfrastructure({ canManage, currentState, projectId, onDestroyed }) {
  const { notify } = useToast();
  const navigate = useNavigate();
  const dispatching = useRef(false);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const available = Boolean(currentState) && overviewLifecycleActions(currentState, canManage).some((action) => action.command === "destroy");
  async function destroy(phrase) {
    if (dispatching.current || phrase !== DESTROY_CONFIRMATION_PHRASE) return;
    dispatching.current = true;
    setBusy(true); setError("");
    try {
      const response = await destroyGithubActionsDeployment(projectId, phrase);
      setOpen(false);
      notify(response.deployment?.message || "Destroy started.", "success");
      await onDestroyed?.();
      navigate(`/projects/${projectId}/pipeline`);
    } catch (caught) {
      setError(caught.message);
    } finally {
      dispatching.current = false;
      setBusy(false);
    }
  }
  return <div className="danger-row">
    <div><h3>Destroy infrastructure</h3><p>Takes your app offline and removes every AWS resource this project owns. Deployment history and settings are kept, so you can deploy again later.</p>{!available ? <p className="field-hint">{canManage ? "Available while the app is live." : "Only project developers can destroy infrastructure."}</p> : null}</div>
    <Button disabled={!available} onClick={() => { setError(""); setOpen(true); }} tone="danger">Destroy infrastructure</Button>
    {open ? <ConfirmPhraseDialog busy={busy} busyLabel="Destroying…" confirmLabel="Destroy infrastructure" error={error} id="destroy" onClose={() => setOpen(false)} onConfirm={(phrase) => void destroy(phrase)} phrase={DESTROY_CONFIRMATION_PHRASE} title="Destroy this project's infrastructure?">
      <p>Every recorded release generation and the resources it owns are removed by exact identity. Shared platform networking, the cluster and the load balancer are not touched. Your app will be offline until you deploy again.</p>
    </ConfirmPhraseDialog> : null}
  </div>;
}
