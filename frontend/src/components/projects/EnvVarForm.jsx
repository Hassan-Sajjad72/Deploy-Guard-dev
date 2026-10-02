export default function EnvVarForm({
  form,
  isSubmitting,
  onCancel,
  onChange,
  onSubmit,
  submitLabel = "Add variable",
}) {
  return (
    <form className="env-form" onSubmit={onSubmit}>
      <label className="field"><span>Name</span><input autoComplete="off" className="mono" id="envKey" name="key" onChange={onChange} placeholder="APP_BASE_URL" required spellCheck={false} value={form.key} /></label>
      <label className="field"><span>Value</span><input autoComplete="new-password" id="envValue" name="value" onChange={onChange} placeholder={form.id ? "Leave blank to keep the current value" : ""} required={!form.id} spellCheck={false} type={form.isSecret ? "password" : "text"} value={form.value} /></label>
      <label className="field"><span>Available during</span><select name="scope" onChange={onChange} value={form.scope}><option value="runtime">Runtime</option><option value="build">Build</option><option value="both">Build and runtime</option></select></label>
      <label className="check"><input checked={form.isSecret} name="isSecret" onChange={onChange} type="checkbox" /><span>Secret<small>Hidden after saving and never shown again.</small></span></label>
      <p className="field-hint">Database connection aliases may be supplied here when no conflicting managed database is attached.</p>
      <div className="dialog-actions">
        {onCancel ? <button className="btn btn-ghost" onClick={onCancel} type="button">Cancel</button> : null}
        <button aria-busy={isSubmitting || undefined} className="btn btn-primary" disabled={isSubmitting} type="submit">{isSubmitting ? "Saving…" : submitLabel}</button>
      </div>
    </form>
  );
}
