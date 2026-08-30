export default function EnvVarForm({
  form,
  isSubmitting,
  onCancel,
  onChange,
  onSubmit,
  submitLabel = "Add variable",
}) {
  return (
    <form className="form-stack panel" onSubmit={onSubmit}>
      <div className="field">
        <label htmlFor="envKey">Key</label>
        <input
          id="envKey"
          name="key"
          onChange={onChange}
          placeholder="APP_BASE_URL"
          required
          value={form.key}
        />
      </div>
      <div className="field">
        <label htmlFor="envValue">Value</label>
        <input
          id="envValue"
          name="value"
          onChange={onChange}
          required={!form.id}
          type={form.isSecret ? "password" : "text"}
          value={form.value}
        />
      </div>
      <label>
        <input
          checked={form.isSecret}
          name="isSecret"
          onChange={onChange}
          type="checkbox"
        />{" "}
        Secret
      </label>
      <div className="form-grid">
        <label className="field"><span>Scope</span><select name="scope" onChange={onChange} value={form.scope}><option value="build">Build</option><option value="runtime">Runtime</option><option value="both">Build and runtime</option></select></label>
        <label className="field"><span>Environment</span><select name="environment" onChange={onChange} value={form.environment}><option value="production">Production</option><option value="development">Development</option></select></label>
      </div>
      <p className="muted">Custom variables are optional. Database connection aliases are managed from Database settings.</p>
      <div className="quick-actions">
        <button className="button" disabled={isSubmitting} type="submit">
          {isSubmitting ? "Saving..." : submitLabel}
        </button>
        {onCancel ? (
          <button className="secondary-button" onClick={onCancel} type="button">
            Cancel
          </button>
        ) : null}
      </div>
    </form>
  );
}
