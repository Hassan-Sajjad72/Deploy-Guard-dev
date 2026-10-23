import ArtifactSummaryCard from "./ArtifactSummaryCard.jsx";
import PipelineEventsTimeline from "./PipelineEventsTimeline.jsx";

export default function PipelineRunPanel({ events, projectId, selectedRun }) {
  return (
    <div className="grid two-column-grid">
      <ArtifactSummaryCard run={selectedRun} />
      <PipelineEventsTimeline events={events} projectId={projectId} />
    </div>
  );
}
