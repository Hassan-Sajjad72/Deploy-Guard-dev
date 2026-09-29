import { useEffect, useMemo, useRef, useState } from "react";
import AppIcon from "../common/AppIcon.jsx";
import { StatusChip } from "../common/DesignSystem.jsx";
import { DEVELOPER_DEPLOYMENT_PHASES, DEVELOPER_DESTROY_PHASES, PIPELINE_PHASE_STAGE_KEYS } from "../../utils/developerDeploymentPresentation.js";
import { pipelineStageDisplayStatus } from "../../utils/pipelineStageTiming.js";
import { productText } from "../../utils/productTerms.js";

const DEPLOY_ORDER = ["source", "build", "publish", "deploy", "verify", "finalize"];
const DESTROY_ORDER = ["destroy", "verify", "finalize"];

function tone(status) {
  if (["completed", "passed", "success", "succeeded"].includes(status)) return "done";
  if (status === "failed") return "failed";
  if (status === "running") return "running";
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

function StageIcon({ status }) {
  const value = tone(status);
  if (value === "done") return <AppIcon name="check" size={12} />;
  if (value === "failed") return <AppIcon name="close" size={12} />;
  return null;
}

/**
 * Execution graph: the GitHub Actions stages of one operation grouped into
 * lifecycle phases (columns) joined by connectors. Selecting a stage opens its
 * recorded evidence. Presentation only — stage data is used as returned.
 */
export default function PipelineGraph({ durationLabel, formatDate, operation, stages }) {
  const destroy = operation?.deploymentAction === "destroy";
  const columns = useMemo(() => {
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

  const defaultIndex = useMemo(() => {
    const all = columns.flatMap((column) => column.entries);
    return (all.find((entry) => entry.displayStatus === "failed")
      || all.find((entry) => entry.displayStatus === "running")
      || [...all].reverse().find((entry) => tone(entry.displayStatus) === "done")
      || all[0])?.index ?? null;
  }, [columns]);
  const [selectedIndex, setSelectedIndex] = useState(defaultIndex);
  useEffect(() => { setSelectedIndex(defaultIndex); }, [defaultIndex, operation?.id]);
  const selected = columns.flatMap((column) => column.entries).find((entry) => entry.index === selectedIndex) || null;
  // Completion pop: only for stages observed changing to done, never on a fresh load.
  const previousTones = useRef(null);
  const [justCompleted, setJustCompleted] = useState(() => new Set());
  useEffect(() => {
    const tones = new Map(columns.flatMap((column) => column.entries).map((entry) => [`${entry.stage.key}-${entry.index}`, tone(entry.displayStatus)]));
    const before = previousTones.current;
    previousTones.current = tones;
    if (!before) return undefined;
    const done = [...tones].filter(([key, value]) => value === "done" && before.has(key) && before.get(key) !== "done").map(([key]) => key);
    if (!done.length) return undefined;
    setJustCompleted(new Set(done));
    const timer = window.setTimeout(() => setJustCompleted(new Set()), 450);
    return () => window.clearTimeout(timer);
  }, [columns]);

  return <div className="pipeline-graph">
    <ol aria-label="Execution graph" className="pg-columns dg-dark">
      {columns.map((column) => <li className={`pg-column is-${column.status}`} key={column.key}>
        <div className="pg-column-head"><span aria-hidden="true" className="pg-phase-dot" /><strong>{column.label}</strong><small>{column.entries.length} step{column.entries.length === 1 ? "" : "s"}</small></div>
        <ul className="pg-nodes">{column.entries.map(({ stage, index, displayStatus }) => <li key={`${stage.key}-${index}`}>
          <button aria-pressed={selectedIndex === index} className={`pg-node is-${tone(displayStatus)}${justCompleted.has(`${stage.key}-${index}`) ? " just-completed" : ""}`} onClick={() => setSelectedIndex(index)} type="button">
            <span aria-hidden="true" className="pg-node-icon"><StageIcon status={displayStatus} /></span>
            <span className="pg-node-copy"><strong>{productText(stage.label)}</strong><small>{durationLabel(stage)}</small></span>
          </button>
        </li>)}</ul>
      </li>)}
    </ol>
    {selected ? <section aria-live="polite" aria-label="Selected stage evidence" className="pg-detail">
      <header><div><p className="eyebrow">Stage evidence</p><h3>{productText(selected.stage.label)}</h3></div><StatusChip status={selected.displayStatus} /></header>
      <dl>
        <div><dt>Duration</dt><dd>{durationLabel(selected.stage)}</dd></div>
        <div><dt>Started</dt><dd>{formatDate(selected.stage.startedAt)}</dd></div>
        <div><dt>Completed</dt><dd>{formatDate(selected.stage.completedAt)}</dd></div>
        <div><dt>Source</dt><dd>GitHub Actions workflow job</dd></div>
      </dl>
      {selected.stage.failureReason ? <p className="pg-failure">{productText(selected.stage.failureReason)}</p> : null}
      {selected.stage.jobUrl ? <a className="pg-job-link" href={selected.stage.jobUrl} rel="noreferrer" target="_blank">Open GitHub Actions job <AppIcon name="arrow" size={14} /></a> : null}
    </section> : null}
  </div>;
}
