export default function ProjectForm({
  form,
  isSubmitting,
  onChange,
  onSubmit,
  submitLabel = "Save project",
}) {
  return (
    <form className="form-stack panel" onSubmit={onSubmit}>
      <div className="field">
        <label htmlFor="name">Name</label>
        <input
          id="name"
          name="name"
          onChange={onChange}
          required
          value={form.name}
        />
      </div>
      <div className="field">
        <label htmlFor="description">Description</label>
        <input
          id="description"
          name="description"
          onChange={onChange}
          value={form.description}
        />
      </div>
      <div className="field">
        <label htmlFor="repositoryUrl">GitHub repository URL</label>
        <input
          id="repositoryUrl"
          name="repositoryUrl"
          onChange={onChange}
          required
          value={form.repositoryUrl}
        />
      </div>
      <div className="field">
        <label htmlFor="targetBranch">Target branch</label>
        <input
          id="targetBranch"
          name="targetBranch"
          onChange={onChange}
          value={form.targetBranch}
        />
      </div>
      <div className="field">
        <label htmlFor="visibility">Visibility</label>
        <select
          id="visibility"
          name="visibility"
          onChange={onChange}
          value={form.visibility}
        >
          <option value="private">private</option>
          <option value="workspace">workspace</option>
        </select>
      </div>
      <button className="button" disabled={isSubmitting} type="submit">
        {isSubmitting ? "Saving..." : submitLabel}
      </button>
    </form>
  );
}
