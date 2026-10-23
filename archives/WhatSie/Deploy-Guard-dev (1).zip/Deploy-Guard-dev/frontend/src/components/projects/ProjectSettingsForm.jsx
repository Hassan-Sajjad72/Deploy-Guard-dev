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
        <h2>Project</h2>
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
        <button className="button" disabled={disabled || isSubmitting} type="submit">
          Save Project
        </button>
      </form>

      <form className="form-stack panel" onSubmit={onSaveRepository}>
        <h2>Repository</h2>
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
        <button className="button" disabled={disabled || isSubmitting} type="submit">
          Save Repository
        </button>
      </form>

      <button
        className="danger-button"
        disabled={disabled || isSubmitting}
        onClick={onArchive}
        type="button"
      >
        Archive Project
      </button>
    </div>
  );
}
