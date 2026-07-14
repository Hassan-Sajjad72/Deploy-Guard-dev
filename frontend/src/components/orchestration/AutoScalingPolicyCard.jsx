import { useEffect, useState } from "react";

export default function AutoScalingPolicyCard({ canManage, onUpdate, scaling }) {
  const [minTasks, setMinTasks] = useState(1);
  const [maxTasks, setMaxTasks] = useState(3);
  const [cpuTargetPercent, setCpuTargetPercent] = useState(60);

  useEffect(() => {
    setMinTasks(Number(scaling?.minTasks || 1));
    setMaxTasks(Number(scaling?.maxTasks || 3));
    setCpuTargetPercent(Number(scaling?.cpuTargetPercent || 60));
  }, [scaling]);

  function submit(event) {
    event.preventDefault();
    onUpdate({ minTasks, maxTasks, cpuTargetPercent });
  }

  return (
    <section className="panel">
      <h2>Auto Scaling</h2>
      <form className="form-stack" onSubmit={submit}>
        <dl className="details-list">
          <dt>Desired</dt>
          <dd>{scaling?.desiredCount || 1}</dd>
          <dt>Status</dt>
          <dd>{scaling?.status || "not_configured"}</dd>
        </dl>
        <div className="option-grid">
          <label className="field">
            <span>Min Tasks</span>
            <input disabled={!canManage} min="1" onChange={(e) => setMinTasks(Number(e.target.value))} type="number" value={minTasks} />
          </label>
          <label className="field">
            <span>Max Tasks</span>
            <input disabled={!canManage} min="1" onChange={(e) => setMaxTasks(Number(e.target.value))} type="number" value={maxTasks} />
          </label>
          <label className="field">
            <span>CPU Target</span>
            <input disabled={!canManage} max="90" min="10" onChange={(e) => setCpuTargetPercent(Number(e.target.value))} type="number" value={cpuTargetPercent} />
          </label>
        </div>
        {canManage ? <button className="secondary-button" type="submit">Update Scaling</button> : <p className="muted">Readonly users cannot update scaling.</p>}
      </form>
    </section>
  );
}
