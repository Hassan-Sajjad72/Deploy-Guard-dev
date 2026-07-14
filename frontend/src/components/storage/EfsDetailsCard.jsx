function value(value) {
  return value === null || value === undefined || value === "" ? "-" : value;
}

export default function EfsDetailsCard({ storage }) {
  return (
    <section className="panel">
      <h2>EFS</h2>
      <dl className="details-list">
        <dt>File System</dt>
        <dd>{value(storage?.efsFileSystemId)}</dd>
        <dt>DNS Name</dt>
        <dd>{value(storage?.efsDnsName)}</dd>
        <dt>Access Point</dt>
        <dd>{value(storage?.efsAccessPointId)}</dd>
        <dt>Security Group</dt>
        <dd>{value(storage?.efsSecurityGroupId)}</dd>
        <dt>KMS Key</dt>
        <dd>{value(storage?.kmsKeyId)}</dd>
        <dt>Root Directory</dt>
        <dd>{value(storage?.rootDirectory)}</dd>
        <dt>POSIX</dt>
        <dd>
          {storage ? `${storage.posixUid}:${storage.posixGid} ${storage.rootPermissions}` : "-"}
        </dd>
      </dl>
    </section>
  );
}
