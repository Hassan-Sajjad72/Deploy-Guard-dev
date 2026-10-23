import { Link } from "react-router-dom";

export default function ProjectForm({ form, isSubmitting, onChange, onSubmit, submitLabel = "Create Workspace" }) {
  return (
    <form className="guided-form" onSubmit={onSubmit}>
      <section className="panel form-section">
        <div className="form-section-number">1</div>
        <div className="form-section-content">
          <div><p className="eyebrow">Workspace Identity</p><h2>Name this application workspace</h2><p className="muted">Use a short name your team will recognize in release activity and audit history.</p></div>
          <div className="form-grid">
            <label className="field"><span>Project name</span><input autoFocus id="name" name="name" onChange={onChange} placeholder="payments-api" required value={form.name} /><small>Required. This does not rename the GitHub repository.</small></label>
            <label className="field"><span>Description</span><input id="description" name="description" onChange={onChange} placeholder="Customer payment service" value={form.description} /><small>Optional context for people opening the project overview.</small></label>
          </div>
        </div>
      </section>

      <section className="panel form-section">
        <div className="form-section-number">2</div>
        <div className="form-section-content">
          <div><p className="eyebrow">Repository Source</p><h2>Connect the application code</h2><p className="muted">Use a complete HTTPS GitHub repository URL. Private repositories require backend GitHub access.</p></div>
          <label className="field"><span>GitHub repository URL</span><input id="repositoryUrl" name="repositoryUrl" onChange={onChange} placeholder="https://github.com/organization/repository" required type="url" value={form.repositoryUrl} /><small>Expected format: https://github.com/owner/repository</small></label>
        </div>
      </section>

      <section className="panel form-section">
        <div className="form-section-number">3</div>
        <div className="form-section-content">
          <div><p className="eyebrow">Release Target</p><h2>Choose the initial branch and visibility</h2></div>
          <div className="form-grid">
            <label className="field"><span>Target branch</span><input id="targetBranch" name="targetBranch" onChange={onChange} value={form.targetBranch} /><small>Defaults to main. You can fetch repository branches from Setup later.</small></label>
            <label className="field"><span>Workspace visibility</span><select id="visibility" name="visibility" onChange={onChange} value={form.visibility}><option value="private">Private</option><option value="workspace">Workspace</option></select><small>Private restricts access to the owner and administrators.</small></label>
          </div>
          <div className="state muted"><strong>Application directory:</strong> DeployGuard detects monorepo subdirectories automatically during stack detection. Environment variables can be added from the project workspace after creation.</div>
          <div className="state muted"><strong>Automation safety:</strong> DeployGuard starts detection, template generation, pre-flight, and its worker pipeline after creation. Infrastructure deployment still respects the backend Terraform Apply switch.</div>
        </div>
      </section>

      <section className="panel next-step-preview">
        <div><p className="eyebrow">What happens next</p><h2>Create once. DeployGuard takes it from here.</h2><p className="muted">After creation, detection, template generation, pre-flight, and the internal deployment pipeline start automatically. You do not need a Dockerfile, docker-compose, Terraform, GitHub Actions, or repository AWS credentials.</p></div>
        <div className="quick-actions"><Link className="secondary-button" to="/projects">Cancel</Link><button className="button" disabled={isSubmitting} type="submit">{isSubmitting ? "Creating workspace..." : submitLabel}</button></div>
      </section>
    </form>
  );
}
