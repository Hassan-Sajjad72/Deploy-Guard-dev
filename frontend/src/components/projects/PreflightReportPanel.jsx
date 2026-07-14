import DockerfilePreview from "./DockerfilePreview.jsx";
import EnvironmentSummaryCard from "./EnvironmentSummaryCard.jsx";
import TemplateSummaryCard from "./TemplateSummaryCard.jsx";
import ValidationChecklist from "./ValidationChecklist.jsx";
import DetectionWarnings from "./DetectionWarnings.jsx";

export default function PreflightReportPanel({ report }) {
  const data = report.report || {};

  return (
    <div className="grid">
      <section className="panel">
        <h2>Detected Stack</h2>
        <dl className="details-list">
          <dt>Ecosystem</dt>
          <dd>{data.detectedStack?.ecosystem || "-"}</dd>
          <dt>Framework</dt>
          <dd>{data.detectedStack?.framework || "-"}</dd>
          <dt>Variant</dt>
          <dd>{data.detectedStack?.frameworkVariant || "-"}</dd>
          <dt>Package Manager</dt>
          <dd>{data.detectedStack?.packageManager || "-"}</dd>
          <dt>Runtime</dt>
          <dd>{data.detectedStack?.runtimeVersion || "-"}</dd>
        </dl>
      </section>
      <section className="panel">
        <h2>Deployment Profile</h2>
        <dl className="details-list">
          <dt>Build Command</dt>
          <dd>{data.deploymentProfile?.buildCommand || "-"}</dd>
          <dt>Start Command</dt>
          <dd>{data.deploymentProfile?.startCommand || "-"}</dd>
          <dt>Expected Port</dt>
          <dd>{data.deploymentProfile?.expectedPort || "-"}</dd>
          <dt>Health Check</dt>
          <dd>{data.deploymentProfile?.healthCheckPath || "/"}</dd>
          <dt>Database Required</dt>
          <dd>{data.deploymentProfile?.requiresDatabase ? "yes" : "no"}</dd>
        </dl>
      </section>
      <TemplateSummaryCard template={data.template} />
      <DockerfilePreview
        dockerfile={data.dockerfile}
        generatedDockerfile={report.generatedDockerfile}
      />
      <EnvironmentSummaryCard summary={data.environmentVariables} />
      <ValidationChecklist validations={data.validations || []} />
      <DetectionWarnings errors={report.errors} warnings={report.warnings} />
    </div>
  );
}
