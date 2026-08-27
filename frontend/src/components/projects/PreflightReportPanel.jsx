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
        <h2>Repository Evidence</h2>
        <dl className="details-list">
          <dt>Repository</dt>
          <dd>{data.project?.repositoryFullName || data.project?.repositoryUrl || "No data available"}</dd>
          <dt>Branch</dt>
          <dd>{data.project?.targetBranch || "No data available"}</dd>
          <dt>Commit</dt>
          <dd>{data.project?.commitSha || "No data available"}</dd>
          <dt>Empty repository</dt>
          <dd>{data.repositoryInspection?.emptyRepository === true ? "Yes" : data.repositoryInspection?.emptyRepository === false ? "No" : "No data available"}</dd>
          <dt>Readiness</dt>
          <dd>{data.readiness?.decision ? data.readiness.decision.replaceAll("_", " ") : "No data available"}</dd>
          <dt>Application root</dt>
          <dd>{data.repositoryInspection?.appRoot || "."}</dd>
          <dt>Root confidence</dt>
          <dd>{data.repositoryInspection?.appRootConfidence || "-"}</dd>
          <dt>Root decision</dt>
          <dd>{data.repositoryInspection?.appRootReason || "-"}</dd>
          <dt>Detected candidates</dt>
          <dd>{data.repositoryInspection?.detectedCandidates?.length ? data.repositoryInspection.detectedCandidates.map((candidate) => `${candidate.directory} (${candidate.score})`).join(", ") : "None"}</dd>
        </dl>
      </section>
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
          <dt>Runtime type</dt>
          <dd>{data.deploymentProfile?.runtimeType || "-"}</dd>
        </dl>
      </section>
      <section className="panel">
        <h2>Deployment Profile</h2>
        <dl className="details-list">
          <dt>Build Command</dt>
          <dd>{data.deploymentProfile?.buildCommand || "-"}</dd>
          <dt>Install Command</dt>
          <dd>{data.deploymentProfile?.installCommand || "-"}</dd>
          <dt>Start Command</dt>
          <dd>{data.deploymentProfile?.startCommand || "-"}</dd>
          <dt>Expected Port</dt>
          <dd>{data.deploymentProfile?.expectedPort || "-"}</dd>
          <dt>Health Check</dt>
          <dd>{data.deploymentProfile?.healthCheckPath || "TCP readiness (no proven HTTP endpoint)"}</dd>
          <dt>Database Required</dt>
          <dd>{data.deploymentProfile?.requiresDatabase ? "yes" : "no"}</dd>
          <dt>Output Directory</dt>
          <dd>{data.deploymentProfile?.outputDirectory || "-"}</dd>
        </dl>
      </section>
      <section className="panel">
        <h2>ECS Runtime Plan</h2>
        <dl className="details-list">
          <dt>Container port</dt><dd>{data.ecsRuntimePlan?.containerPort || "-"}</dd>
          <dt>ALB target port</dt><dd>{data.ecsRuntimePlan?.albTargetPort || "-"}</dd>
          <dt>Health path</dt><dd>{data.ecsRuntimePlan?.healthCheckPath || "TCP readiness; ALB uses / only for platform liveness"}</dd>
          <dt>Runtime command</dt><dd>{data.ecsRuntimePlan?.runtimeCommand || "-"}</dd>
          <dt>PORT injection</dt><dd>{data.ecsRuntimePlan?.injectPortEnvironment ? "enabled" : "not required"}</dd>
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
