export default function ServiceDiscoveryCard({ records = [] }) {
  return (
    <section className="panel">
      <h2>Service Discovery</h2>
      {records.length > 0 ? (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Service</th>
                <th>Namespace</th>
                <th>Internal DNS</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {records.map((record) => (
                <tr key={record.id}>
                  <td>{record.serviceName}</td>
                  <td>{record.namespaceName}</td>
                  <td className="wrap-cell">{record.dnsName}</td>
                  <td>{record.status}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <p className="muted">Cloud Map service discovery is not ready yet.</p>
      )}
    </section>
  );
}
