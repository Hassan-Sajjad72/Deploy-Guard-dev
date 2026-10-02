import { useMemo, useState } from "react";
import AppIcon from "../common/AppIcon.jsx";
import { DEVELOPER_DEPLOYMENT_PHASES, DEVELOPER_DESTROY_PHASES, PIPELINE_PHASE_STAGE_KEYS } from "../../utils/developerDeploymentPresentation.js";
import { pipelineStageDisplayStatus } from "../../utils/pipelineStageTiming.js";
import { productText } from "../../utils/productTerms.js";

const DEPLOY_ORDER = ["source", "build", "publish", "deploy", "verify", "finalize"];
const DESTROY_ORDER = ["destroy", "verify", "finalize"];

function tone(status) {
  if (["completed", "passed", "success", "succeeded"].includes(status)) return "done";
  if (status === "failed") return "failed";
  if (status === "running") return "running";
  if (status === "skipped") return "skipped";
  return "idle";
}

function phaseStatus(entries) {
  const tones = entries.map((entry) => tone(entry.displayStatus));
  if (tones.includes("failed")) return "failed";
  if (tones.includes("running")) return "running";
  if (tones.length && tones.every((value) => value === "done")) return "done";
  if (tones.includes("done")) return "partial";
  return "idle";
}

const STATUS_TEXT = { done: "Done", failed: "Failed", running: "Running", partial: "Partly done", idle: "Not run", skipped: "Skipped" };

function StepIcon({ value }) {
  if (value === "done") return <AppIcon name="check" size={13} />;
  if (value === "failed") return <AppIcon name="close" size={13} />;
  if (value === "running") return <span className="inline-spinner" />;
  return null;
}

/**
 * Stage list: the GitHub Actions steps of one operation grouped into
 * lifecycle phases. Phases with a failure or a running step open by default.
 * Presentation only — stage data is used as returned.
 */
export default function PipelineGraph({ durationLabel, operation, stages }) {
  const destroy = operation?.deploymentAction === "destroy";
  const phases = useMemo(() => {
    const order = destroy ? DESTROY_ORDER : DEPLOY_ORDER;
    const labels = Object.fromEntries((destroy ? DEVELOPER_DESTROY_PHASES : DEVELOPER_DEPLOYMENT_PHASES).map((phase) => [phase.key, phase.label]));
    const groups = [];
    let current = null;
    stages.forEach((stage, index) => {
      const key = order.find((phase) => PIPELINE_PHASE_STAGE_KEYS[phase]?.includes(stage.key)) || current?.key || order[0];
      if (!current || current.key !== key) {
        current = groups.find((group) => group.key === key) || null;
        if (!current) { current = { key, label: labels[key] || key, entries: [] }; groups.push(current); }
      }
      current.entries.push({ stage, index, displayStatus: pipelineStageDisplayStatus(stage, operation) });
    });
    return groups.map((group) => ({ ...group, status: phaseStatus(group.entries) }));
  }, [destroy, operation, stages]);
  const [toggled, setToggled] = useState(() => new Set());
  const isOpen = (phase) => toggled.has(phase.key) !== ["failed", "running"].includes(phase.status);

  return <ol aria-label="Deployment stages" className="stage-list">
    {phases.map((phase) => {
      const open = isOpen(phase);
      return <li className={`stage-phase is-${phase.status}`} key={phase.key}>
        <button aria-expanded={open} className="stage-phase-head" onClick={() => setToggled((current) => { const next = new Set(current); if (next.has(phase.key)) next.delete(phase.key); else next.add(phase.key); return next; })} type="button">
          <span aria-hidden="true" className="stage-icon"><StepIcon value={phase.status === "partial" ? "idle" : phase.status} /></span>
          <strong>{phase.label}</strong>
          <span className="stage-phase-meta">{STATUS_TEXT[phase.status]} · {phase.entries.length} step{phase.entries.length === 1 ? "" : "s"}</span>
          <AppIcon className="stage-chevron" name="chevron-down" size={16} />
        </button>
        {open ? <ol className="stage-steps">
          {phase.entries.map(({ stage, index, displayStatus }) => {
            const value = tone(displayStatus);
            return <li className={`stage-step is-${value}`} key={`${stage.key}-${index}`}>
              <span aria-hidden="true" className="stage-icon is-small"><StepIcon value={value} /></span>
              <span className="stage-step-label">{productText(stage.label)}<span className="sr-only"> — {STATUS_TEXT[value]}</span></span>
              <span className="stage-step-time">{durationLabel(stage)}</span>
              {stage.jobUrl ? <a aria-label={`Open the GitHub Actions job for ${productText(stage.label)}`} className="stage-step-link" href={stage.jobUrl} rel="noreferrer" target="_blank"><AppIcon name="external" size={14} /></a> : <span />}
              {stage.failureReason ? <pre className="code stage-failure">{productText(stage.failureReason)}</pre> : null}
            </li>;
          })}
        </ol> : null}
      </li>;
    })}
  </ol>;
}
