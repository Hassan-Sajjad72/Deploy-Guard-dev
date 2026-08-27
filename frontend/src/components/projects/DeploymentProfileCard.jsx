import DetectionWarnings from "./DetectionWarnings.jsx";
import TemplateSelectionBadge from "./TemplateSelectionBadge.jsx";
import {
  BentoGrid,
  CollapsiblePanel,
  MetricCard,
  StatusBadge,
} from "../common/Premium.jsx";

function row(label, value) {
  return (
    <>
      <dt>{label}</dt>
      <dd>{value === null || value === undefined || value === "" ? "-" : String(value)}</dd>
    </>
  );
}

export default function DeploymentProfileCard({ profile }) {
  const hasAccessError = Boolean(profile.cloneError || profile.branchError);
  const isUnsupported = Boolean(profile.unsupportedReason || profile.dockerfileRequired);
  const detectionTone = hasAccessError ? "danger" : isUnsupported ? "warning" : profile.templateMatched ? "success" : "neutral";

  return (
    <div className="grid">
      <section className="panel diagnostic-console">
        <div className="section-heading">
          <div>
            <p className="eyebrow">Stack Intelligence</p>
            <h2>Detection Summary</h2>
            <p className="muted">A safe deployment profile generated from repository manifests and framework rules.</p>
          </div>
          <div className="button-row">
            <StatusBadge status={profile.detectionStatus} tone={detectionTone} />
            <TemplateSelectionBadge template={profile.selectedTemplate} />
          </div>
        </div>

        {profile.cloneError ? (
          <div className="state error">Clone error: {profile.cloneError}</div>
        ) : null}
        {profile.branchError ? (
          <div className="state error">Branch error: {profile.branchError}</div>
        ) : null}
        {profile.unsupportedReason ? (
          <div className="state warning">{profile.unsupportedReason}</div>
        ) : null}
        {profile.selectedTemplate === "custom-dockerfile-required" && !profile.unsupportedReason ? (
          <div className="state error">
            No safe automatic template was found. Please provide a custom Dockerfile.
          </div>
        ) : null}

        <BentoGrid>
          <MetricCard label="Ecosystem" value={profile.ecosystem || "Unknown"} detail={profile.language || "Language not resolved"} tone={detectionTone} />
          <MetricCard label="Framework" value={profile.framework || "Unknown"} detail={profile.frameworkVariant || "No variant"} tone={profile.framework ? "success" : "neutral"} />
          <MetricCard label="App Directory" value={profile.appDirectory || "."} detail="Build context selected by detection" />
          <MetricCard label="Runtime" value={profile.runtimeType || (profile.staticOutput ? "static" : "server")} detail={`${profile.appRootConfidence || profile.confidence || "unknown"} app-root confidence`} />
          <MetricCard label="Health Check" value={profile.healthCheckPath || "TCP readiness"} detail={profile.healthCheckPath ? `Expected port ${profile.expectedPort || "-"}` : `Expected port ${profile.expectedPort || "-"}; ALB / is platform liveness`} />
        </BentoGrid>
      </section>

      {profile.components?.length ? <section className="panel"><div className="section-heading"><div><p className="eyebrow">Bounded topology</p><h2>Declared components</h2></div><StatusBadge status={profile.topologyStatus || "supported"} tone={profile.topologyStatus === "blocked" ? "danger" : "success"} /></div><dl className="details-list">{profile.components.map((component) => <div key={component.id}><dt>{component.role}</dt><dd>{component.framework} · {component.root} · build context {component.buildContext} · port {component.port}</dd></div>)}{profile.managedDatabase ? <div><dt>Managed database</dt><dd>{profile.managedDatabase.engine} · owned by {profile.managedDatabase.ownerComponentId}</dd></div> : null}</dl></section> : null}

      <section className="panel">
        <div className="section-heading">
          <div>
            <p className="eyebrow">Application Structure</p>
            <h2>Runtime Contract</h2>
          </div>
        </div>
        <dl className="details-list">
          {row("Ecosystem", profile.ecosystem)}
          {row("Language", profile.language)}
          {row("Framework", profile.framework)}
          {row("Framework Variant", profile.frameworkVariant)}
          {row("App Directory", profile.appDirectory)}
          {row(
            "Manifest Files",
            profile.manifestFiles?.length ? profile.manifestFiles.join(", ") : "none"
          )}
          {row("Package Manager", profile.packageManager)}
          {row("Install Command", profile.installCommand)}
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
          {row("Output Directory", profile.outputDirectory)}
          {row("Required Environment", profile.requiredEnvironmentVariables?.join(", ") || "none")}
          {row("Optional Environment", profile.optionalEnvironmentVariables?.join(", ") || "none")}
          {row("Source Files Scanned", profile.sourceFileCount)}
          {row("Has Dockerfile", profile.hasDockerfile ? "yes" : "no")}
          {row("Dockerfile Required", profile.dockerfileRequired ? "yes" : "no")}
          {row("Selected Template", profile.selectedTemplate)}
          {row("Template Matched", profile.templateMatched ? "yes" : "no")}
          {row("Confidence", profile.confidence)}
          {row("App Root Reason", profile.appRootReason)}
          {row("Commit SHA", profile.commitSha)}
        </dl>
      </section>

      <section className="panel">
        <div className="section-heading">
          <div>
            <p className="eyebrow">Template Match</p>
            <h2>Container Strategy</h2>
          </div>
          <StatusBadge
            status={profile.templateMatched ? "template matched" : "custom dockerfile required"}
            tone={profile.templateMatched ? "success" : "warning"}
          />
        </div>
        <dl className="details-list">
          {row("Selected Template", profile.selectedTemplate)}
          {row("Dockerfile Required", profile.dockerfileRequired ? "yes" : "no")}
          {row("Has Dockerfile", profile.hasDockerfile ? "yes" : "no")}
          {row("Unsupported Reason", profile.unsupportedReason)}
        </dl>
      </section>

      <DetectionWarnings errors={profile.errors} warnings={profile.warnings} />

      <CollapsiblePanel>
        <dl className="details-list">
          {row("Selected Branch", profile.branch || profile.targetBranch)}
          {row("Clone Status", hasAccessError ? "failed" : "available")}
          {row(
            "Manifest Files",
            profile.manifestFiles?.length ? profile.manifestFiles.join(", ") : "none"
          )}
          {row("Ignored Directories", ".git, node_modules, dist, build, coverage, vendor, __pycache__")}
          {row("Final Rule Matched", profile.selectedTemplate || profile.unsupportedReason)}
        </dl>
      </CollapsiblePanel>
    </div>
  );
}
