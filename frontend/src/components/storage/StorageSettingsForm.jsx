import { useEffect, useState } from "react";

export default function StorageSettingsForm({
  canManage,
  isSaving,
  isProvisioning,
  onProvision,
  onSave,
  storage,
}) {
  const [enabled, setEnabled] = useState(false);
  const [backupEnabled, setBackupEnabled] = useState(true);

  useEffect(() => {
    setEnabled(Boolean(storage?.enabled));
    setBackupEnabled(storage?.backupEnabled !== false);
  }, [storage]);

  function submit(event) {
    event.preventDefault();
    onSave({ enabled, backupEnabled });
  }

  return (
    <section className="panel">
      <h2>Settings</h2>
      <form className="form-stack" onSubmit={submit}>
        <label className="checkbox-row">
          <input
            checked={enabled}
            disabled={!canManage || isSaving}
            onChange={(event) => setEnabled(event.target.checked)}
            type="checkbox"
          />
          Enable EFS
        </label>
        <label className="checkbox-row">
          <input
            checked={backupEnabled}
            disabled={!canManage || isSaving}
            onChange={(event) => setBackupEnabled(event.target.checked)}
            type="checkbox"
          />
          Enable backups
        </label>
        {canManage ? (
          <div className="button-row">
            <button className="button" disabled={isSaving} type="submit">
              {isSaving ? "Saving" : "Save"}
            </button>
            {enabled ? (
              <button
                className="secondary-button"
                disabled={isProvisioning}
                onClick={onProvision}
                type="button"
              >
                {isProvisioning ? "Queued" : "Provision"}
              </button>
            ) : null}
          </div>
        ) : (
          <p className="muted">Readonly users cannot change storage settings.</p>
        )}
      </form>
    </section>
  );
}
