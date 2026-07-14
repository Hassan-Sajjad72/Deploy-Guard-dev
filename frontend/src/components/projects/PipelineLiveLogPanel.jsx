import { useEffect, useMemo, useRef, useState } from "react";

function time(value) {
  return value ? new Intl.DateTimeFormat(undefined, { hour: "2-digit", minute: "2-digit", second: "2-digit" }).format(new Date(value)) : "--:--:--";
}

export default function PipelineLiveLogPanel({ currentStage, events = [], failedStage, id }) {
  const outputRef = useRef(null);
  const [autoScroll, setAutoScroll] = useState(true);
  const [query, setQuery] = useState("");
  const [level, setLevel] = useState("all");
  const [stage, setStage] = useState("all");
  const stages = useMemo(() => [...new Set(events.map((event) => event.userFacingStageName || event.stage).filter(Boolean))], [events]);
  const resolvedFailedStage = useMemo(() => stages.find((item) => item === failedStage || item.includes(failedStage) || String(failedStage || "").includes(item)) || null, [failedStage, stages]);
  const resolvedCurrentStage = useMemo(() => stages.find((item) => item === currentStage || item.includes(currentStage) || String(currentStage || "").includes(item)) || null, [currentStage, stages]);
  const visibleEvents = useMemo(() => events.filter((event) => {
    const matchesLevel = level === "all" || String(event.status || "").toLowerCase() === level;
    const eventStage = event.userFacingStageName || event.stage;
    const matchesStage = stage === "all" || eventStage === stage;
    const haystack = `${eventStage} ${event.message} ${event.status}`.toLowerCase();
    return matchesLevel && matchesStage && haystack.includes(query.trim().toLowerCase());
  }), [events, level, query, stage]);

  useEffect(() => {
    if (autoScroll && outputRef.current) outputRef.current.scrollTop = outputRef.current.scrollHeight;
  }, [autoScroll, events]);

  useEffect(() => {
    const focus = resolvedFailedStage || resolvedCurrentStage;
    if (focus) setStage(focus);
  }, [resolvedCurrentStage, resolvedFailedStage]);

  async function copyLogs() {
    if (!navigator.clipboard) return;
    await navigator.clipboard.writeText(visibleEvents.map((event) => `${time(event.createdAt)} [${event.status}] ${event.message}`).join("\n")).catch(() => undefined);
  }

  return (
    <section className="panel-flat live-log-panel" id={id}>
      <div className="compact-section-heading"><div><p className="eyebrow">Structured lifecycle</p><h2>Pipeline Events</h2><p className="muted">Detailed worker logs are not available yet. Showing sanitized pipeline events.</p></div><div className="quick-actions"><button className="subtle-button" onClick={() => setAutoScroll((current) => !current)} type="button">{autoScroll ? "Pause follow" : "Follow latest"}</button><button className="subtle-button" disabled={!visibleEvents.length} onClick={copyLogs} type="button">Copy Events</button></div></div>
      <div className="event-quick-filters" aria-label="Stage event shortcuts">{resolvedFailedStage ? <button className={stage === resolvedFailedStage ? "filter-pill active" : "filter-pill"} onClick={() => setStage(resolvedFailedStage)} type="button">Failed stage</button> : null}{resolvedCurrentStage ? <button className={stage === resolvedCurrentStage ? "filter-pill active" : "filter-pill"} onClick={() => setStage(resolvedCurrentStage)} type="button">Current stage</button> : null}<button className={stage === "all" ? "filter-pill active" : "filter-pill"} onClick={() => setStage("all")} type="button">All stages</button></div>
      <div className="log-toolbar"><label><span className="sr-only">Search events</span><input onChange={(event) => setQuery(event.target.value)} placeholder="Search stage or message…" type="search" value={query} /></label><label><span className="sr-only">Filter event stage</span><select onChange={(event) => setStage(event.target.value)} value={stage}><option value="all">All stages</option>{stages.map((item) => <option key={item} value={item}>{item.replaceAll("_", " ")}</option>)}</select></label><label><span className="sr-only">Filter event status</span><select onChange={(event) => setLevel(event.target.value)} value={level}><option value="all">All statuses</option><option value="failed">Errors</option><option value="warning">Warnings</option><option value="success">Success</option><option value="running">Running</option></select></label><span className="muted">{visibleEvents.length} / {events.length} events</span></div>
      <div aria-live="polite" className="log-output live-log-output" ref={outputRef} role="log">{visibleEvents.map((event) => <details className={`log-line log-${event.status}`} key={event.id}><summary><time>{time(event.timestamp || event.createdAt)}</time><span>[{String(event.status || "info").toUpperCase()}]</span><strong>{event.userFacingStageName || event.stage}</strong><p>{event.message}</p></summary><div className="event-technical-detail"><small>Internal stage: {event.internalStageKey || event.stage}</small>{event.durationMs !== null && event.durationMs !== undefined ? <small>Duration: {event.durationMs}ms</small> : null}</div></details>)}{!visibleEvents.length ? <p className="muted">{events.length ? "No events match this filter." : "No pipeline events yet. Events will appear after the run starts."}</p> : null}</div>
    </section>
  );
}
