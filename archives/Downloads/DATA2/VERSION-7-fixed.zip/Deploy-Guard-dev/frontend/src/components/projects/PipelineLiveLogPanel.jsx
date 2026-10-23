import { useEffect, useMemo, useRef, useState } from "react";

function time(value) {
  return value ? new Intl.DateTimeFormat(undefined, { hour: "2-digit", minute: "2-digit", second: "2-digit" }).format(new Date(value)) : "--:--:--";
}

export default function PipelineLiveLogPanel({ events = [] }) {
  const outputRef = useRef(null);
  const [autoScroll, setAutoScroll] = useState(true);
  const [query, setQuery] = useState("");
  const [level, setLevel] = useState("all");
  const visibleEvents = useMemo(() => events.filter((event) => {
    const matchesLevel = level === "all" || String(event.status || "").toLowerCase() === level;
    const haystack = `${event.stage} ${event.message} ${event.status}`.toLowerCase();
    return matchesLevel && haystack.includes(query.trim().toLowerCase());
  }), [events, level, query]);

  useEffect(() => {
    if (autoScroll && outputRef.current) outputRef.current.scrollTop = outputRef.current.scrollHeight;
  }, [autoScroll, events]);

  async function copyLogs() {
    if (!navigator.clipboard) return;
    await navigator.clipboard.writeText(visibleEvents.map((event) => `${time(event.createdAt)} [${event.status}] ${event.message}`).join("\n")).catch(() => undefined);
  }

  return (
    <section className="panel-flat live-log-panel">
      <div className="compact-section-heading"><div><p className="eyebrow">Live output</p><h2>Deployment logs</h2></div><div className="quick-actions"><button className="subtle-button" onClick={() => setAutoScroll((current) => !current)} type="button">{autoScroll ? "Pause follow" : "Follow latest"}</button><button className="subtle-button" disabled={!visibleEvents.length} onClick={copyLogs} type="button">Copy</button></div></div>
      <div className="log-toolbar"><label><span className="sr-only">Search logs</span><input onChange={(event) => setQuery(event.target.value)} placeholder="Search stage or message…" type="search" value={query} /></label><label><span className="sr-only">Filter log level</span><select onChange={(event) => setLevel(event.target.value)} value={level}><option value="all">All levels</option><option value="failed">Errors</option><option value="warning">Warnings</option><option value="success">Success</option><option value="running">Running</option></select></label><span className="muted">{visibleEvents.length} / {events.length} events</span></div>
      <div aria-live="polite" className="log-output live-log-output" ref={outputRef} role="log">{visibleEvents.map((event) => <div className={`log-line log-${event.status}`} key={event.id}><time>{time(event.createdAt)}</time><span>[{String(event.status || "info").toUpperCase()}]</span><strong>{event.stage}</strong><p>{event.message}</p></div>)}{!visibleEvents.length ? <p className="muted">{events.length ? "No events match this filter." : "No pipeline events yet. Worker output will appear after the run starts."}</p> : null}</div>
    </section>
  );
}
