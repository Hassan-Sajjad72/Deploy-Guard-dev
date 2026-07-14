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
          placeholder="DATABASE_URL"
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
          type="password"
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
