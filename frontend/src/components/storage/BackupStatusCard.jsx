function formatDate(value) {
  return value
    ? new Intl.DateTimeFormat(undefined, {
        dateStyle: "medium",
        timeStyle: "short",
      }).format(new Date(value))
    : "-";
}

export default function BackupStatusCard({ backups = [], storage }) {
  return (
    <section className="panel">
      <h2>Backups</h2>
      <dl className="details-list">
        <dt>Enabled</dt>
        <dd>{storage?.backupEnabled ? "Yes" : "No"}</dd>
        <dt>Retention</dt>
        <dd>{storage?.backupRetentionDays ? `${storage.backupRetentionDays} days` : "-"}</dd>
        <dt>Vault</dt>
        <dd>{storage?.backupVaultName || "-"}</dd>
        <dt>Plan</dt>
        <dd>{storage?.backupPlanId || "-"}</dd>
      </dl>
      <ul className="timeline">
        {backups.map((backup) => (
          <li className="timeline-item" key={backup.id}>
            <div>
              <strong>{backup.status?.replaceAll("_", " ")}</strong>
              <p>{backup.backupVaultName || "AWS Backup"}</p>
              <p className="muted">{backup.schedule || "-"}</p>
            </div>
            <span className="muted">{formatDate(backup.createdAt)}</span>
          </li>
        ))}
      </ul>
      {backups.length === 0 ? <p className="muted">No backup records yet.</p> : null}
    </section>
  );
}
