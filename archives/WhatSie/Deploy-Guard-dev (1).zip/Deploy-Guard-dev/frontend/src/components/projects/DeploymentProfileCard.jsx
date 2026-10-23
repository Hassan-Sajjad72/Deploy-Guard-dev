import DetectionWarnings from "./DetectionWarnings.jsx";
import TemplateSelectionBadge from "./TemplateSelectionBadge.jsx";

function row(label, value) {
  return (
    <>
      <dt>{label}</dt>
      <dd>{value === null || value === undefined || value === "" ? "-" : String(value)}</dd>
    </>
  );
}

export default function DeploymentProfileCard({ profile }) {
  return (
    <div className="grid">
      <section className="panel">
        <div className="page-header">
          <div>
            <h2>Deployment Profile</h2>
            <p className="muted">Status: {profile.detectionStatus}</p>
          </div>
          <TemplateSelectionBadge template={profile.selectedTemplate} />
        </div>
        {profile.selectedTemplate === "custom-dockerfile-required" ? (
          <div className="state error">
            No safe automatic template was found. Please provide a custom Dockerfile.
          </div>
        ) : null}
        <dl className="details-list">
          {row("Ecosystem", profile.ecosystem)}
          {row("Language", profile.language)}
          {row("Framework", profile.framework)}
          {row("Framework Variant", profile.frameworkVariant)}
          {row("Package Manager", profile.packageManager)}
          {row("Runtime Version", profile.runtimeVersion)}
          {row("Build Command", profile.buildCommand)}
          {row("Start Command", profile.startCommand)}
          {row("Expected Port", profile.expectedPort)}
          {row("Health Check", profile.healthCheckPath)}
          {row("Database Required", profile.requiresDatabase ? "yes" : "no")}
          {row("Database Type", profile.databaseType)}
          {row(
            "Persistent Storage",
            profile.requiresPersistentStorage ? "yes" : "no"
          )}
          {row("Static Output", profile.staticOutput ? "yes" : "no")}
          {row("Has Dockerfile", profile.hasDockerfile ? "yes" : "no")}
          {row("Dockerfile Required", profile.dockerfileRequired ? "yes" : "no")}
          {row("Selected Template", profile.selectedTemplate)}
          {row("Confidence", profile.confidence)}
          {row("Commit SHA", profile.commitSha)}
        </dl>
      </section>
      <DetectionWarnings errors={profile.errors} warnings={profile.warnings} />
    </div>
  );
}
