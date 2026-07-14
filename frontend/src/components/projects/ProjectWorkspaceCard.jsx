import { useState } from "react";
import { Link } from "react-router-dom";
import { StatusBadge, formatStatus } from "../common/Premium.jsx";
import AppIcon from "../common/AppIcon.jsx";

function formatDate(value) {
  return value
    ? new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(new Date(value))
    : "Unknown";
}

export default function ProjectWorkspaceCard({ project, currentState }) {
  const [copied, setCopied] = useState(false);
  const detection = currentState?.modules?.detection;
  const stack = detection?.status === "passed" ? detection.message : "Not detected";
  const repository = project.repositoryFullName || project.repositoryUrl || "";

  async function copyRepository() {
    if (!repository || !navigator.clipboard) return;
    try {
      await navigator.clipboard.writeText(repository);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      setCopied(false);
    }
  }

  return (
    <article className="workspace-card">
      <div className="workspace-card-header">
        <div className="project-title-lockup"><span className="project-glyph"><AppIcon name="box" size={16} /></span><div><h2>{project.name}</h2><small>{project.targetBranch || "No branch"}</small></div></div>
        <StatusBadge status={currentState?.overallStatus || "unavailable"} />
      </div>
      <div className="repository-line" title={repository}>
        <span>{repository || "Repository not connected"}</span>
        <strong>{project.targetBranch || "No branch"}</strong>
        {repository ? <button aria-label="Copy repository" className="copy-button" onClick={copyRepository} type="button">{copied ? "Copied" : "Copy"}</button> : null}
      </div>
      <div className="workspace-card-stage"><span>Current stage</span><strong>{currentState?.currentStepLabel || formatStatus(currentState?.currentStage || "not_started")}</strong><small>{stack}</small></div>
      <div aria-label={`${currentState?.progressPercentage ?? 0}% deployment progress`} aria-valuemax="100" aria-valuemin="0" aria-valuenow={currentState?.progressPercentage ?? 0} className="progress-track compact-progress" role="progressbar"><span style={{ width: `${currentState?.progressPercentage ?? 0}%` }} /></div>
      <div className="workspace-card-footer">
        <span>{currentState?.liveDeployment?.available ? "Live deployment" : formatDate(project.updatedAt || project.createdAt)}</span>
        <Link className="text-link" to={`/projects/${project.id}`}>Open Project <AppIcon name="arrow" size={14} /></Link>
      </div>
    </article>
  );
}
