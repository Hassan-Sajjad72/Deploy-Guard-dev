import { useEffect, useState } from "react";
import { getProjectCurrentState } from "../../api/projectApi.js";
import { CollapsiblePanel, StatusBadge } from "../common/Premium.jsx";

export default function ProjectModuleStatusStrip({ moduleKey, projectId }) {
  const [state, setState] = useState(null);

  useEffect(() => {
    let mounted = true;
    getProjectCurrentState(projectId).then((response) => mounted && setState(response)).catch(() => mounted && setState(null));
    return () => { mounted = false; };
  }, [projectId]);

  const module = state?.modules?.[moduleKey];
  if (!module) return null;

  return (
    <div className="module-context-wrap">
      <section className="module-context-bar"><StatusBadge status={module.status} /><span>{module.message}</span></section>
      <CollapsiblePanel summary="Developer details"><dl className="developer-detail-grid"><div><dt>Terraform Apply</dt><dd>{state.environmentModes.terraformApplyEnabled ? "Enabled" : "Disabled"}</dd></div><div><dt>FinOps</dt><dd>{state.environmentModes.finopsMockMode ? "Mock" : "Real"}</dd></div><div><dt>State</dt><dd>{state.environmentModes.stateMockMode ? "Mock" : "Remote"}</dd></div><div><dt>External CI</dt><dd>{state.environmentModes.githubActionsRequired ? "Required" : "Optional"}</dd></div></dl></CollapsiblePanel>
    </div>
  );
}
