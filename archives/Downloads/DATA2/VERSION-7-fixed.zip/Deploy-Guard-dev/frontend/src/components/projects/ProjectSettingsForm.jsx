export default function ProjectSettingsForm({
  disabled,
  form,
  isSubmitting,
  onArchive,
  onChange,
  onSaveProject,
  onSaveRepository,
}) {
  return (
    <div className="grid">
      <form className="form-stack panel" onSubmit={onSaveProject}>
        <div><p className="eyebrow">Workspace Identity</p><h2>Project details</h2><p className="muted">These fields describe the workspace; they do not alter the source repository.</p></div>
        <div className="field">
          <label htmlFor="name">Name</label>
          <input
            disabled={disabled}
            id="name"
            name="name"
            onChange={onChange}
            value={form.name}
          />
        </div>
        <div className="field">
          <label htmlFor="description">Description</label>
          <input
            disabled={disabled}
            id="description"
            name="description"
            onChange={onChange}
            value={form.description}
          />
        </div>
        <div className="field">
          <label htmlFor="visibility">Visibility</label>
          <select
            disabled={disabled}
            id="visibility"
            name="visibility"
            onChange={onChange}
            value={form.visibility}
          >
            <option value="private">private</option>
            <option value="workspace">workspace</option>
          </select>
        </div>
        <button className="secondary-button" disabled={disabled || isSubmitting} type="submit">
          Update Workspace
        </button>
      </form>

      <form className="form-stack panel" onSubmit={onSaveRepository}>
        <div><p className="eyebrow">Repository Connection</p><h2>GitHub source</h2><p className="muted">Use an HTTPS GitHub URL. Private repository access depends on the backend token configuration.</p></div>
        <div className="field">
          <label htmlFor="repositoryUrl">GitHub repository URL</label>
          <input
            disabled={disabled}
            id="repositoryUrl"
            name="repositoryUrl"
            onChange={onChange}
            value={form.repositoryUrl}
          />
        </div>
        <button className="secondary-button" disabled={disabled || isSubmitting} type="submit">
          Update Repository
        </button>
      </form>

      <section className="panel danger-zone"><div><p className="eyebrow">Danger Zone</p><h2>Archive this workspace</h2><p className="muted">Archiving removes the project from active workspace lists. A confirmation is required.</p></div><button className="danger-button" disabled={disabled || isSubmitting} onClick={onArchive} type="button">Archive Project</button></section>
    </div>
  );
}
