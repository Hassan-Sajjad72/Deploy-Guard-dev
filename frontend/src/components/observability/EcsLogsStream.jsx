import { useEffect, useRef, useState } from "react";
import { getObservabilityLogStreamUrl } from "../../api/projectApi.js";

export default function EcsLogsStream({ projectId, filters }) {
  const [lines, setLines] = useState([]);
  const [status, setStatus] = useState("stopped");
  const sourceRef = useRef(null);

  function start() {
    stop();
    setLines([]);
    setStatus("connecting");
    const source = new EventSource(getObservabilityLogStreamUrl(projectId, filters), { withCredentials: true });
    sourceRef.current = source;
    source.addEventListener("connected", () => setStatus("connected"));
    source.addEventListener("heartbeat", () => setStatus("streaming"));
    source.addEventListener("log_line", (event) => {
      const payload = JSON.parse(event.data);
      setLines((current) => [...current.slice(-199), payload]);
    });
    source.addEventListener("error", (event) => {
      setStatus("error");
      if (event.data) {
        setLines((current) => [...current, JSON.parse(event.data)]);
      }
    });
    source.addEventListener("completed", () => setStatus("completed"));
  }

  function stop() {
    sourceRef.current?.close();
    sourceRef.current = null;
    setStatus("stopped");
  }

  useEffect(() => () => stop(), []);

  return (
    <section className="panel">
      <h2>Live ECS Logs</h2>
      <div className="button-row">
        <button className="primary-button" onClick={start} type="button">Start Stream</button>
        <button className="secondary-button" onClick={stop} type="button">Stop</button>
        <span className={`status-pill status-${status}`}>{status}</span>
      </div>
      <pre className="log-output">
        {lines.map((line, index) => `[${line.timestamp || "-"}] ${line.message || line.error || ""}`).join("\n")}
      </pre>
    </section>
  );
}
