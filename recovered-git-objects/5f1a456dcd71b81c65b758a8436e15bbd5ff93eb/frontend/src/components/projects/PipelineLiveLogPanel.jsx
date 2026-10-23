import { useMemo, useState } from "react";
import { StatusBadge } from "../common/Premium.jsx";
import { useProductMode } from "../../hooks/useProductMode.js";

function dateTime(value) { return value ? new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "medium" }).format(new Date(value)) : "—"; }
function shortTime(value) { return value ? new Intl.DateTimeFormat(undefined, { hour: "2-digit", minute: "2-digit", second: "2-digit" }).format(new Date(value)) : "—"; }
function duration(value) { if (value === null || value === undefined) return "—"; if (value < 1000) return `${value}ms`; const seconds = Math.round(value / 1000); return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${seconds % 60}s`; }
function eventStage(event) { return event.userFacingStageKey || event.userFacingStageName || event.internalStageKey || event.stage || "pipeline"; }
function eventStageLabel(event) { return event.userFacingStageName || String(event.internalStageKey || event.stage || "Pipeline").replaceAll("_", " "); }
function normalizeStatus(value) {
  if (value === "success") return "passed";
  if (["started", "queued", "waiting"].includes(value)) return "running";
  return value || "pending";
}

function groupStatus(events) {
  const statuses = events.map((event) => normalizeStatus(event.status));
  if (statuses.includes("failed") || statuses.includes("cancelled")) return "failed";
  if (statuses.includes("blocked")) return "blocked";
  const latestStatus = normalizeStatus(events.at(-1)?.status);
  if (latestStatus === "running") return "running";
  if (latestStatus === "warning") return "warning";
  if (latestStatus === "skipped") return "skipped";
  if (statuses.includes("warning")) return "warning";
  if (statuses.includes("skipped")) return "skipped";
  if (statuses.includes("passed")) return "passed";
  return "pending";
}

export default function PipelineLiveLogPanel({ events = [], id }) {
  const { isDeveloperMode } = useProductMode();
  const [query, setQuery] = useState("");
  const [level, setLevel] = useState("all");
  const [stage, setStage] = useState("all");
  const stages = useMemo(() => {
    const unique = new Map();
    events.forEach((event) => { const key = eventStage(event); if (!unique.has(key)) unique.set(key, eventStageLabel(event)); });
    return [...unique.entries()].map(([key, label]) => ({ key, label }));
  }, [events]);
  const visibleEvents = useMemo(() => events.filter((event) => {
    const status = String(event.status || "").toLowerCase();
    const matchesLevel = level === "all" || status === level || normalizeStatus(status) === level;
    const matchesStage = stage === "all" || eventStage(event) === stage;
    const haystack = `${eventStageLabel(event)} ${event.internalStageKey || event.stage} ${event.message} ${event.status} ${JSON.stringify(event.metadata || {})}`.toLowerCase();
    return matchesLevel && matchesStage && haystack.includes(query.trim().toLowerCase());
  }), [events, level, query, stage]);
  const groups = useMemo(() => {
    const grouped = new Map();
    visibleEvents.forEach((event) => {
      const key = eventStage(event);
      if (!grouped.has(key)) grouped.set(key, { key, label: eventStageLabel(event), events: [] });
      grouped.get(key).events.push(event);
    });
    return [...grouped.values()].map((group) => {
      const ordered = [...group.events].sort((a, b) => new Date(a.timestamp || a.createdAt) - new Date(b.timestamp || b.createdAt));
      const first = ordered[0]; const last = ordered.at(-1); const status = groupStatus(ordered);
      const startedAt = first?.timestamp || first?.createdAt || null;
      const endedAt = ["passed", "failed", "blocked", "skipped", "warning"].includes(status) ? last?.timestamp || last?.createdAt || null : null;
      const durationMs = ordered.map((event) => event.durationMs).find((value) => typeof value === "number") ?? (startedAt && endedAt ? Math.max(0, new Date(endedAt) - new Date(startedAt)) : null);
      const error = [...ordered].reverse().find((event) => ["failed", "blocked", "cancelled"].includes(event.status));
      return { ...group, events: ordered, status, startedAt, endedAt, durationMs, error };
    });
  }, [visibleEvents]);

  return <section className="panel-flat stage-event-panel" id={id}>
    <div className="compact-section-heading"><div><p className="eyebrow">Structured lifecycle evidence</p><h2>Events by stage</h2><p className="muted">Persisted, sanitized pipeline events—not raw worker stdout or fabricated logs.</p></div></div>
    <div className="log-toolbar"><label><span className="sr-only">Search events</span><input onChange={(event) => setQuery(event.target.value)} placeholder="Search event messages or technical details…" type="search" value={query} /></label><label><span className="sr-only">Filter stage</span><select onChange={(event) => setStage(event.target.value)} value={stage}><option value="all">All reached stages</option>{stages.map((item) => <option key={item.key} value={item.key}>{item.label}</option>)}</select></label><label><span className="sr-only">Filter status</span><select onChange={(event) => setLevel(event.target.value)} value={level}><option value="all">All statuses</option><option value="failed">Failed</option><option value="blocked">Blocked</option><option value="running">Running</option><option value="warning">Warning</option><option value="success">Success</option><option value="skipped">Skipped</option></select></label><span className="muted">{visibleEvents.length} / {events.length} events</span></div>
    <div className="pipeline-event-groups">{groups.map((group, index) => <article className={`pipeline-event-stage stage-${group.status}`} key={group.key}><header><span className="simple-stage-marker">{["passed", "warning", "skipped"].includes(group.status) ? "✓" : index + 1}</span><div><h3>{group.label}</h3><p>{group.events.length} persisted event{group.events.length === 1 ? "" : "s"}</p></div><StatusBadge status={group.status} /><dl><div><dt>Started</dt><dd>{shortTime(group.startedAt)}</dd></div><div><dt>{group.status === "failed" ? "Failed" : "Finished"}</dt><dd>{shortTime(group.endedAt)}</dd></div><div><dt>Duration</dt><dd>{duration(group.durationMs)}</dd></div></dl></header>{group.error ? <div className="stage-error-callout"><strong>Failure at {isDeveloperMode ? group.error.internalStageKey || group.error.stage : group.label}</strong><p>{group.error.message}</p></div> : null}<ol>{group.events.map((event) => <li className={`pipeline-event-item event-${event.status}`} key={event.id}><time dateTime={event.timestamp || event.createdAt}>{dateTime(event.timestamp || event.createdAt)}</time><StatusBadge status={normalizeStatus(event.status)}>{event.status}</StatusBadge><div><strong>{event.message}</strong>{isDeveloperMode ? <><small>Internal stage: {event.internalStageKey || event.stage}</small>{event.metadata && Object.keys(event.metadata).length ? <details><summary>Sanitized technical details</summary><pre>{JSON.stringify(event.metadata, null, 2)}</pre></details> : null}</> : null}</div></li>)}</ol></article>)}{!groups.length ? <p className="muted">{events.length ? "No events match these filters." : "No events have been persisted for this run."}</p> : null}</div>
  </section>;
}
