import { useEffect, useState } from "react";
import { getProjectDetailedCurrentState } from "../../api/projectApi.js";
import { StatusBadge } from "../common/Premium.jsx";

export default function ProjectModuleStatusStrip({ moduleKey, projectId }) {
  const [state, setState] = useState(null);

  useEffect(() => {
    let mounted = true;
    getProjectDetailedCurrentState(projectId).then((response) => mounted && setState(response)).catch(() => mounted && setState(null));
    return () => { mounted = false; };
  }, [projectId]);

  const module = state?.modules?.[moduleKey];
  if (!module) return null;

  return (
    <div className="module-context-wrap">
      <section className="module-context-bar"><StatusBadge status={module.status} /><span>{module.message}</span></section>
    </div>
  );
}
