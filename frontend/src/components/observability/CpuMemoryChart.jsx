import RuntimeMetricsChart from "./RuntimeMetricsChart.jsx";

export default function CpuMemoryChart({ runtime }) {
  return (
    <>
      <RuntimeMetricsChart title="CPU Usage" metric={runtime?.cpu} />
      <RuntimeMetricsChart title="Memory Usage" metric={runtime?.memory} />
    </>
  );
}
