import RuntimeMetricsChart from "./RuntimeMetricsChart.jsx";

export default function AlbLatencyCard({ runtime }) {
  return (
    <>
      <RuntimeMetricsChart title="HTTP Latency" metric={runtime?.httpLatency} />
      <RuntimeMetricsChart title="Request Rate" metric={runtime?.requestRate} />
    </>
  );
}
