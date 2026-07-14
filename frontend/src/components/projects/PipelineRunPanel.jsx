import ArtifactSummaryCard from "./ArtifactSummaryCard.jsx";

export default function PipelineRunPanel({ selectedRun }) {
  return (
    <div className="grid">
      <ArtifactSummaryCard run={selectedRun} />
    </div>
  );
}
