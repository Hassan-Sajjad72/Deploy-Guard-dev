import { Link } from "react-router-dom";
import { useProductMode } from "../../hooks/useProductMode.js";

export default function ProjectForm({ form, isSubmitting, onChange, onSubmit, submitLabel = "Create Project" }) {
  const { isDeveloperMode } = useProductMode();
  return (
    <form className="guided-form" onSubmit={onSubmit}>
      <section className="panel form-section">
        <div className="form-section-number">1</div>
        <div className="form-section-content">
        <div><p className="eyebrow">Project identity</p><h2>Name this application</h2><p className="muted">{isDeveloperMode ? "Use a short name your team will recognize in release activity and audit history." : "Use a short name you will recognize in your project list."}</p></div>
          <div className="form-grid">
            <label className="field"><span>Project name</span><input autoFocus id="name" name="name" onChange={onChange} placeholder="payments-api" required value={form.name} /><small>Required. This does not rename the GitHub repository.</small></label>
            <label className="field"><span>Description</span><input id="description" name="description" onChange={onChange} placeholder="Customer payment service" value={form.description} /><small>Optional context for people opening the project overview.</small></label>
          </div>
        </div>
      </section>

      <section className="panel form-section">
        <div className="form-section-number">2</div>
        <div className="form-section-content">
          <div><p className="eyebrow">Repository Source</p><h2>Connect the application code</h2><p className="muted">{isDeveloperMode ? "Use a complete HTTPS GitHub repository URL. Private repositories require backend GitHub access." : "Paste the GitHub link for the app you want to deploy."}</p></div>
          <label className="field"><span>GitHub repository URL</span><input id="repositoryUrl" name="repositoryUrl" onChange={onChange} placeholder="https://github.com/organization/repository" required type="url" value={form.repositoryUrl} /><small>Expected format: https://github.com/owner/repository</small></label>
        </div>
      </section>

      <section className="panel form-section">
        <div className="form-section-number">3</div>
        <div className="form-section-content">
          <div><p className="eyebrow">Release Target</p><h2>{isDeveloperMode ? "Choose the initial branch and visibility" : "Choose the branch to deploy"}</h2></div>
          <div className="form-grid">
            <label className="field"><span>Target branch</span><input id="targetBranch" name="targetBranch" onChange={onChange} value={form.targetBranch} /><small>Defaults to main. You can fetch repository branches from Setup later.</small></label>
            {isDeveloperMode ? <label className="field"><span>Application directory</span><input id="appDirectory" name="appDirectory" onChange={onChange} placeholder="apps/api" value={form.appDirectory || ""} /><small>Optional repository-relative path for a monorepo. Leave blank for automatic detection.</small></label> : null}
            {isDeveloperMode ? <label className="field"><span>Project visibility</span><select id="visibility" name="visibility" onChange={onChange} value={form.visibility}><option value="private">Private</option><option value="workspace">Workspace</option></select><small>Private restricts access to the owner and administrators.</small></label> : null}
          </div>
          {isDeveloperMode ? <div className="state muted"><strong>Application directory:</strong> An explicit path limits detection and builds to that folder. If left blank, DeployGuard selects the strongest supported app manifest automatically.</div> : null}
          <div className="state muted"><strong>{isDeveloperMode ? "Automation safety:" : "After you create it:"}</strong> {isDeveloperMode ? "DeployGuard runs detection, template generation, and pre-flight after creation. Deployment runs only through the repository's GitHub Actions workflow." : "DeployGuard prepares and checks the app automatically. Cloud resources are created only after you choose Deploy."}</div>
        </div>
      </section>

      <section className="panel next-step-preview">
        <div><p className="eyebrow">What happens next</p><h2>Create once. DeployGuard takes it from here.</h2><p className="muted">{isDeveloperMode ? "After creation, detection, template generation, pre-flight, and the internal deployment pipeline start automatically. You do not need a Dockerfile, docker-compose, Terraform, GitHub Actions, or repository AWS credentials." : "DeployGuard prepares, builds, checks, and deploys the selected app using the platform's configured environment."}</p></div>
        <div className="quick-actions"><Link className="secondary-button" to="/projects">Cancel</Link><button className="button" disabled={isSubmitting} type="submit">{isSubmitting ? "Creating project..." : submitLabel}</button></div>
      </section>
    </form>
  );
}
